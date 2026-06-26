/** Core downloader: drives yt-dlp, emits progress events, returns saved file paths. */

import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  | { kind: "removed"; file: string }
  | { kind: "gallery" }
  | { kind: "processing"; label: string };

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
    if (host === "youtu.be") return false;
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

const NO_AUDIO = "no audio track";

let cookiesFile: string | null | undefined;

function isInstagram(url: string): boolean {
  try {
    return new URL(url).hostname.replace(/^www\./, "").endsWith("instagram.com");
  } catch {
    return false;
  }
}

/**
 * Resolve a cookies.txt used by yt-dlp (YouTube bot checks on servers) and
 * gallery-dl (Instagram). Accepts a file path (GALLERY_DL_COOKIES) or a
 * base64-encoded file (GALLERY_DL_COOKIES_B64), decoded to a temp file once.
 * cookies.txt is domain-scoped, so one file safely covers both sites.
 */
export async function resolveCookies(): Promise<string | null> {
  if (cookiesFile !== undefined) return cookiesFile;

  const path = process.env.GALLERY_DL_COOKIES?.trim();
  if (path) return (cookiesFile = path);

  const b64 = process.env.GALLERY_DL_COOKIES_B64?.trim();
  if (b64) {
    const out = join(tmpdir(), "ping-cookies.txt");
    await writeFile(out, Buffer.from(b64, "base64"), { mode: 0o600 });
    return (cookiesFile = out);
  }

  return (cookiesFile = null);
}

/** Try yt-dlp (single video / audio). Throws a friendly Error on failure. */
async function ytdlpDownload(
  { url, format }: Command,
  onEvent?: (event: DownloadEvent) => void,
  normalize = true,
  maxHeight?: number,
): Promise<string[]> {
  const outDir = downloadsDir();
  await mkdir(outDir, { recursive: true });
  const template = `${outDir}/%(title)s [%(id)s].%(ext)s`;

  const cap = maxHeight ? `[height<=${maxHeight}]` : "";
  const sortArgs = maxHeight ? ["-S", `res:${maxHeight},fps:30`] : [];

  const formatArgs =
    format === "mp3"
      ? ["-f", "ba/b", "-x", "--audio-format", "mp3"]
      : [
          // Prefer H.264 + AAC so the result plays in WhatsApp (not just desktop
          // players). Fall back to best available if a site has no H.264.
          "-f",
          `bv*[vcodec^=avc1]${cap}+ba[acodec^=mp4a]/b[vcodec^=avc1]${cap}/bv*${cap}+ba/b${cap}/bv*+ba/b`,
          ...sortArgs,
          "--merge-output-format",
          "mp4",
          // moov atom at the front for clean streaming/playback.
          "--postprocessor-args",
          "Merger:-movflags +faststart",
        ];

  const cookies = await resolveCookies();
  const cookieArgs = cookies ? ["--cookies", cookies] : [];

  const proc = Bun.spawn(
    [
      "yt-dlp",
      "--newline",
      "--no-warnings",
      "--no-playlist",
      // Web/default clients now need a PO token (they return audio-only without
      // one). These clients still serve video; they need a JS runtime (deno).
      "--extractor-args",
      "youtube:player_client=tv_embedded,web_embedded,mweb,android_vr",
      ...cookieArgs,
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
    const noAudio = errors.find((e) => e.includes(NO_AUDIO));
    throw new Error(noAudio ?? errors.at(-1) ?? `yt-dlp exited with code ${exitCode}.`);
  }

  const finalPaths =
    format === "mp4" && normalize ? await Promise.all(paths.map((p) => normalizeMp4(p, onEvent))) : paths;

  await removeOtherFormat(finalPaths, format, onEvent);
  return finalPaths;
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "heic", "avif"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "mkv", "webm", "m4v", "avi"]);

const extOf = (path: string): string => parsePath(path).ext.toLowerCase().slice(1);
const swapExt = (path: string, ext: string): string => {
  const { dir, name } = parsePath(path);
  return join(dir, `${name}.${ext}`);
};

/**
 * Move the moov atom to the front (faststart) so the video plays on iOS WhatsApp,
 * which won't start a video whose index is at the end. Stream-copy, no re-encode.
 */
type AVInfo = {
  vcodec?: string;
  acodec?: string;
  pixfmt?: string;
  aprofile?: string;
  hasAudio: boolean;
};

async function probeAV(path: string): Promise<AVInfo> {
  try {
    const proc = Bun.spawn(
      ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt,profile", "-of", "json", path],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const streams: Array<Record<string, unknown>> = JSON.parse(out).streams ?? [];
    const v = streams.find((s) => s.codec_type === "video");
    const a = streams.find((s) => s.codec_type === "audio");
    return {
      vcodec: v?.codec_name as string | undefined,
      acodec: a?.codec_name as string | undefined,
      pixfmt: v?.pix_fmt as string | undefined,
      aprofile: a?.profile as string | undefined,
      hasAudio: Boolean(a),
    };
  } catch {
    return { hasAudio: false };
  }
}

/**
 * Normalize a video to a broadly playable MP4: H.264 (yuv420p) + AAC-LC with the
 * moov atom up front. Already-standard streams are copied (fast); VP9/HEVC/AV1 or
 * HE-AAC are re-encoded. iOS WhatsApp only plays this combination.
 */
export async function normalizeMp4(
  src: string,
  onEvent?: (event: DownloadEvent) => void,
): Promise<string> {
  const info = await probeAV(src);
  const videoOk = info.vcodec === "h264" && (!info.pixfmt || info.pixfmt === "yuv420p");
  const audioOk = !info.hasAudio || (info.acodec === "aac" && info.aprofile === "LC");

  const { dir, name } = parsePath(src);
  const finalPath = join(dir, `${name}.mp4`);
  const tmp = join(dir, `${name}.norm.mp4`);

  const videoArgs = videoOk
    ? ["-c:v", "copy"]
    : ["-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23"];
  const audioArgs = !info.hasAudio ? [] : audioOk ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "128k"];

  if (!videoOk || !audioOk) {
    onEvent?.({ kind: "processing", label: `Converting ${name} to standard mp4` });
  }

  const ok = await ffmpeg(["-i", src, ...videoArgs, ...audioArgs, "-movflags", "+faststart", tmp]);
  if (!ok) {
    await rm(tmp).catch(() => {});
    return src;
  }
  if (src !== finalPath) await rm(src).catch(() => {});
  await rm(finalPath).catch(() => {});
  await rename(tmp, finalPath);
  return finalPath;
}

/** Probe a video for duration (seconds) and dimensions, for nicer WhatsApp playback. */
export async function videoMeta(
  path: string,
): Promise<{ seconds?: number; width?: number; height?: number }> {
  try {
    const proc = Bun.spawn(
      [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:format=duration",
        "-of",
        "json",
        path,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const data = JSON.parse(out);
    const stream = data.streams?.[0] ?? {};
    const duration = Number(data.format?.duration);
    return {
      seconds: Number.isFinite(duration) ? Math.round(duration) : undefined,
      width: typeof stream.width === "number" ? stream.width : undefined,
      height: typeof stream.height === "number" ? stream.height : undefined,
    };
  } catch {
    return {};
  }
}

async function ffmpeg(args: string[]): Promise<boolean> {
  const proc = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

async function toMp3(src: string): Promise<string> {
  const out = swapExt(src, "mp3");
  const ok = await ffmpeg(["-i", src, "-vn", "-acodec", "libmp3lame", "-q:a", "2", out]);
  if (!ok) return src;
  await rm(src).catch(() => {});
  return out;
}

/** Apply the requested format to gallery files: videos → mp4/mp3, images kept as-is. */
async function applyFormat(
  files: string[],
  format: Format,
  onEvent?: (event: DownloadEvent) => void,
  normalize = true,
): Promise<string[]> {
  const result: string[] = [];
  for (const file of files) {
    const ext = extOf(file);
    if (!VIDEO_EXTS.has(ext)) {
      result.push(file);
      continue;
    }
    if (format === "mp3") {
      onEvent?.({ kind: "processing", label: `Extracting audio from ${parsePath(file).base}` });
      result.push(await toMp3(file));
    } else {
      result.push(normalize ? await normalizeMp4(file, onEvent) : file);
    }
  }
  return result;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else out.push(path);
  }
  return out;
}

function gallerySlug(url: string): string {
  try {
    const u = new URL(url);
    const raw = u.hostname.replace(/^www\./, "") + u.pathname;
    return raw.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "gallery";
  } catch {
    return "gallery";
  }
}

const lastLine = (text: string): string =>
  text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? "";

/** Fall back to gallery-dl for image/mixed posts; download everything, then apply format. */
async function galleryDownload(
  { url, format }: Command,
  onEvent?: (event: DownloadEvent) => void,
  normalize = true,
): Promise<string[]> {
  onEvent?.({ kind: "gallery" });
  const dir = join(downloadsDir(), gallerySlug(url));
  await mkdir(dir, { recursive: true });

  const cookies = isInstagram(url) ? await resolveCookies() : null;
  const cookieArgs = cookies ? ["--cookies", cookies] : [];

  const proc = Bun.spawn(["gallery-dl", "--no-mtime", ...cookieArgs, "-D", dir, url], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const files = await listFiles(dir);
  if (files.length === 0) {
    const message = lastLine(stderr) || lastLine(stdout) || `gallery-dl exited with code ${code}.`;
    throw new Error(message.replace(/^\[\w+\]\s*/, ""));
  }
  return applyFormat(files, format, onEvent, normalize);
}

/** Download a link into ./downloads, falling back to gallery-dl for non-video posts. */
export async function download(
  command: Command,
  onEvent?: (event: DownloadEvent) => void,
  opts: { normalize?: boolean; maxHeight?: number } = {},
): Promise<string[]> {
  if (isPlaylistUrl(command.url)) {
    throw new Error("Playlists aren't supported — send a single video link.");
  }

  const normalize = opts.normalize ?? true;
  let ytError: unknown;
  try {
    return await ytdlpDownload(command, onEvent, normalize, opts.maxHeight);
  } catch (err) {
    // A real video with no audio shouldn't fall through to gallery-dl.
    if (err instanceof Error && err.message.includes(NO_AUDIO)) throw err;
    ytError = err;
  }

  try {
    return await galleryDownload(command, onEvent, normalize);
  } catch (galErr) {
    const msg = galErr instanceof Error ? galErr.message : String(galErr);
    if (/unsupported url|no suitable/i.test(msg) && ytError) {
      throw ytError instanceof Error ? ytError : new Error(String(ytError));
    }
    throw galErr;
  }
}
