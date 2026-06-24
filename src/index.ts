#!/usr/bin/env bun
/** CLI: download a media resource to disk and print its local file URL. */

import { pathToFileURL } from "node:url";
import { type Command, FORMATS, type Format, download, isFormat } from "./download";

function parseArgs(argv: string[]): Command {
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
    think(message: string): void {
      stopSpinner();
      clearLive();
      process.stderr.write(`${message}\n`);
    },
    status(message: string): void {
      stopSpinner();
      if (isTTY) {
        process.stderr.write(`\r\x1b[2K${message}`);
        live = true;
      } else {
        process.stderr.write(`${message}\n`);
      }
    },
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

async function main(): Promise<void> {
  const command = parseArgs(Bun.argv.slice(2));
  ui.spin(`🔎 Resolving ${command.url} …`);

  let paths: string[];
  try {
    paths = await download(command, (event) => {
      switch (event.kind) {
        case "fetching":
          return ui.think("📥 Fetching media stream…");
        case "progress": {
          const extras = [event.speed, event.eta && `ETA ${event.eta}`].filter(Boolean).join(" · ");
          return ui.status(`⬇️  Downloading  ${event.percent}%${extras ? `  (${extras})` : ""}`);
        }
        case "merging":
          return ui.spin("🎬 Merging video + audio…");
        case "converting":
          return ui.spin("🎧 Converting to mp3…");
        case "reusing":
          return ui.think("📦 Already on disk — reusing it.");
        case "removed":
          return ui.think(`🗑️  Removed old ${event.file}`);
      }
    });
  } catch (err) {
    ui.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  ui.done();
  ui.think(`✅ Saved ${paths.length} file${paths.length > 1 ? "s" : ""} as ${command.format}:`);
  for (const path of paths) console.log(pathToFileURL(path).href);
}

await main();

export {};
