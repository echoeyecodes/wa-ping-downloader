#!/usr/bin/env bun
/** Download a media resource to disk via yt-dlp and print its local file URL. */

import { mkdir, rm, stat } from "node:fs/promises";
import { join, parse as parsePath } from "node:path";
import { pathToFileURL } from "node:url";

type Format = "mp4" | "mp3";

type Options = {
  url: string;
  format: Format;
};

const FORMATS: Format[] = ["mp4", "mp3"];

function parseArgs(argv: string[]): Options {
  let url: string | undefined;
  let format: Format = "mp4";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-f" || arg === "--format" || arg === "-format") {
      const next = argv[++i];
      if (!isFormat(next)) fail(`Unsupported format "${next}". Use mp4 or mp3.`);
      format = next;
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (isFormat(arg)) {
      format = arg;
    } else if (!arg.startsWith("-")) {
      url ??= arg;
    }
  }

  if (!url) {
    printHelp();
    process.exit(1);
  }

  return { url, format };
}

function isFormat(value: string | undefined): value is Format {
  return value === "mp4" || value === "mp3";
}

function fail(message: string): never {
  ui.error(message);
  process.exit(1);
}

function printHelp(): void {
  console.log(`ping — download a media resource and get its local file URL

Usage:
  npm run ping "<url>"            download as mp4 (default)
  npm run ping "<url>" mp3        download as mp3
  npm run ping -- "<url>" -f mp4  explicit flag form

Formats: ${FORMATS.join(", ")}`);
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const ui = (() => {
  const isTTY = Boolean(process.stderr.isTTY);
  let live = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let frame = 0;

  function clearLive(): void {
    if (live) {
      process.stderr.write("\n");
      live = false;
    }
  }

  function stopSpinner(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    /** A finalized "thought" line. */
    think(message: string): void {
      stopSpinner();
      clearLive();
      process.stderr.write(`${message}\n`);
    },
    /** A live, in-place status line (e.g. download percentage). */
    status(message: string): void {
      stopSpinner();
      if (isTTY) {
        process.stderr.write(`\r\x1b[2K${message}`);
        live = true;
      } else {
        process.stderr.write(`${message}\n`);
      }
    },
    /** An animated spinner for phases without measurable progress. */
    spin(message: string): void {
      stopSpinner();
      if (!isTTY) {
        process.stderr.write(`${message}\n`);
        return;
      }
      const render = () => {
        process.stderr.write(`\r\x1b[2K${SPINNER[frame++ % SPINNER.length]} ${message}`);
        live = true;
      };
      render();
      timer = setInterval(render, 80);
    },
    error(message: string): void {
      stopSpinner();
      clearLive();
      process.stderr.write(`✖ ${message}\n`);
    },
    done(): void {
      stopSpinner();
      clearLive();
    },
  };
})();

function addError(errors: string[], message: string): void {
  if (!errors.includes(message)) errors.push(message);
}

function handleLine(line: string, paths: string[], errors: string[]): void {
  const text = line.trim();
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
    const speed = text.match(/at\s+([\d.]+\s*\S+\/s)/)?.[1];
    const eta = text.match(/ETA\s+([\d:]+)/)?.[1];
    const extras = [speed, eta && `ETA ${eta}`].filter(Boolean).join(" · ");
    ui.status(`⬇️  Downloading  ${percent[1]}%${extras ? `  (${extras})` : ""}`);
    return;
  }

  if (text.startsWith("[download] Destination:")) {
    ui.think("📥 Fetching media stream…");
    return;
  }

  if (text.includes("has already been downloaded")) {
    ui.think("📦 Already on disk — reusing it.");
    return;
  }

  if (text.startsWith("[Merger]")) {
    ui.spin("🎬 Merging video + audio…");
    return;
  }

  if (text.startsWith("[ExtractAudio]")) {
    ui.spin("🎧 Converting to mp3…");
  }
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
      onLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  }
  if (buffer) onLine(buffer);
}

async function removeOtherFormat(paths: string[], format: Format): Promise<void> {
  const other: Format = format === "mp3" ? "mp4" : "mp3";
  for (const path of paths) {
    const { dir, name } = parsePath(path);
    const sibling = join(dir, `${name}.${other}`);
    try {
      await stat(sibling);
      await rm(sibling);
      ui.think(`🗑️  Removed old ${other}: ${name}.${other}`);
    } catch {
      // no counterpart file to clean up
    }
  }
}

async function run({ url, format }: Options): Promise<void> {
  const outDir = `${process.cwd()}/downloads`;
  await mkdir(outDir, { recursive: true });
  const template = `${outDir}/%(title)s [%(id)s].%(ext)s`;

  const formatArgs =
    format === "mp3"
      ? ["-f", "ba/b", "-x", "--audio-format", "mp3"]
      : ["-f", "bv*+ba/b", "--merge-output-format", "mp4"];

  ui.spin(`🔎 Resolving ${url} …`);

  const proc = Bun.spawn(
    [
      "yt-dlp",
      "--newline",
      "--no-warnings",
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
  const onLine = (line: string) => handleLine(line, paths, errors);

  const [, , exitCode] = await Promise.all([
    pump(proc.stdout, onLine),
    pump(proc.stderr, onLine),
    proc.exited,
  ]);

  ui.done();

  if (exitCode !== 0 || paths.length === 0) {
    const noAudio = errors.find((e) => e.includes("no audio track"));
    ui.error(noAudio ?? errors.at(-1) ?? `yt-dlp exited with code ${exitCode}.`);
    process.exit(exitCode || 1);
  }

  await removeOtherFormat(paths, format);

  ui.think(`✅ Saved ${paths.length} file${paths.length > 1 ? "s" : ""} as ${format}:`);
  for (const path of paths) console.log(pathToFileURL(path).href);
}

await run(parseArgs(Bun.argv.slice(2)));

export {};
