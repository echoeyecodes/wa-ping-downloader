/** Core downloader: drives yt-dlp, emits progress events, returns saved file paths. */

import { mkdir, rm, stat } from "node:fs/promises";
import { join, parse as parsePath } from "node:path";

export type Format = "mp4" | "mp3";

export const FORMATS: Format[] = ["mp4", "mp3"];

export function isFormat(value: string | undefined): value is Format {
  return value === "mp4" || value === "mp3";
}

export type DownloadEvent =
  | { kind: "fetching" }
  | { kind: "progress"; percent: string; speed?: string; eta?: string }
  | { kind: "merging" }
  | { kind: "converting" }
  | { kind: "reusing" }
  | { kind: "removed"; file: string };

export type Command = { url: string; format: Format };

/** Pull a URL (and optional mp3/mp4 token) out of a free-text message. */
export function parseCommand(text: string | null | undefined): Command | null {
  if (!text) return null;
  const url = text.match(/https?:\/\/\S+/i)?.[0];
  if (!url) return null;
  const rest = text.replace(url, " ");
  const format = rest.split(/\s+/).find(isFormat) ?? "mp4";
  return { url: url.replace(/[.,)\]]+$/, ""), format };
}

export function downloadsDir(): string {
  return `${process.cwd()}/downloads`;
}

/** True for a YouTube playlist page (not a single video that merely carries a list= param). */
function isPlaylistUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    if (host === "youtu.be") return false; // short links are single videos
    if (!host.endsWith("youtube.com")) return false;
    if (u.pathname.startsWith("/playlist")) return true;
    return u.searchParams.has("list") && !u.searchParams.has("v");
  } catch {
    return false;
  }
}

async function removeOtherFormat(
  paths: string[],
  format: Format,
  onEvent?: (event: DownloadEvent) => void,
): Promise<void> {
  const other: Format = format === "mp3" ? "mp4" : "mp3";
  for (const path of paths) {
    const { dir, name } = parsePath(path);
    const sibling = join(dir, `${name}.${other}`);
    try {
      await stat(sibling);
      await rm(sibling);
      onEvent?.({ kind: "removed", file: `${name}.${other}` });
    } catch {
      // no counterpart file to clean up
    }
  }
}

function readLine(
  text: string,
  paths: string[],
  errors: string[],
  onEvent?: (event: DownloadEvent) => void,
): void {
  if (!text) return;

  const captured = text.match(/^PINGPATH:(.*)$/);
  if (captured) {
    paths.push(captured[1].trim());
    return;
  }

  if (/unable to obtain file audio codec/i.test(text)) {
    addError(errors, "This video has no audio track, so it can't be saved as mp3 — try mp4 instead.");
    return;
  }

  if (text.startsWith("ERROR:")) {
    addError(errors, text.replace(/^ERROR:\s*/, ""));
    return;
  }

  const percent = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
  if (percent) {
    onEvent?.({
      kind: "progress",
      percent: percent[1],
      speed: text.match(/at\s+([\d.]+\s*\S+\/s)/)?.[1],
      eta: text.match(/ETA\s+([\d:]+)/)?.[1],
    });
    return;
  }

  if (text.startsWith("[download] Destination:")) return onEvent?.({ kind: "fetching" });
  if (text.includes("has already been downloaded")) return onEvent?.({ kind: "reusing" });
  if (text.startsWith("[Merger]")) return onEvent?.({ kind: "merging" });
  if (text.startsWith("[ExtractAudio]")) return onEvent?.({ kind: "converting" });
}

function addError(errors: string[], message: string): void {
  if (!errors.includes(message)) errors.push(message);
}

async function pump(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.search(/[\r\n]/)) >= 0) {
      onLine(buffer.slice(0, index).trim());
      buffer = buffer.slice(index + 1);
    }
  }
  if (buffer) onLine(buffer.trim());
}

/** Download `url` as `format` into ./downloads. Throws a friendly Error on failure. */
export async function download(
  { url, format }: Command,
  onEvent?: (event: DownloadEvent) => void,
): Promise<string[]> {
  if (isPlaylistUrl(url)) {
    throw new Error("Playlists aren't supported — send a single video link.");
  }

  const outDir = downloadsDir();
  await mkdir(outDir, { recursive: true });
  const template = `${outDir}/%(title)s [%(id)s].%(ext)s`;

  const formatArgs =
    format === "mp3"
      ? ["-f", "ba/b", "-x", "--audio-format", "mp3"]
      : ["-f", "bv*+ba/b", "--merge-output-format", "mp4"];

  const proc = Bun.spawn(
    [
      "yt-dlp",
      "--newline",
      "--no-warnings",
      "--no-playlist",
      ...formatArgs,
      "--exec",
      "after_move:echo PINGPATH:%(filepath)q",
      "-o",
      template,
      url,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const paths: string[] = [];
  const errors: string[] = [];
  const onLine = (line: string) => readLine(line, paths, errors, onEvent);

  const [, , exitCode] = await Promise.all([
    pump(proc.stdout, onLine),
    pump(proc.stderr, onLine),
    proc.exited,
  ]);

  if (exitCode !== 0 || paths.length === 0) {
    const noAudio = errors.find((e) => e.includes("no audio track"));
    throw new Error(noAudio ?? errors.at(-1) ?? `yt-dlp exited with code ${exitCode}.`);
  }

  await removeOtherFormat(paths, format, onEvent);
  return paths;
}
