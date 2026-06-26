#!/usr/bin/env bun
/** CLI: download a media resource to disk and print its local file URL. */

import { pathToFileURL } from "node:url";
import { saveCard } from "./card";
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
      process.stderr.write(`Error: ${message}\n`);
    },
    done(): void {
      stopSpinner();
      clearLive();
    },
  };
})();

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);

  // `card` renders an image card. Add `mp4` for a video card; for tweets, an
  // optional target (quote | parent | og) picks which embedded video plays.
  if (argv.includes("card")) {
    const url = argv.find((a) => /^https?:\/\//i.test(a));
    if (!url) fail('Provide a post URL, e.g. npm run ping "<tweet>" card');
    const video = argv.includes("mp4");
    const videoTarget = (["quote", "parent", "og"] as const).find((t) => argv.includes(t));
    ui.spin(`Building card for ${url}`);
    try {
      const out = await saveCard(url, { video, videoTarget });
      ui.done();
      ui.think("Saved card:");
      console.log(pathToFileURL(out).href);
    } catch (err) {
      ui.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  const command = parseArgs(argv);
  ui.spin(`Resolving ${command.url}`);

  let paths: string[];
  try {
    paths = await download(command, (event) => {
      switch (event.kind) {
        case "fetching":
          return ui.think("Downloading video");
        case "progress": {
          const extras = [event.speed, event.eta && `ETA ${event.eta}`].filter(Boolean).join(", ");
          return ui.status(`Downloading ${event.percent}%${extras ? ` (${extras})` : ""}`);
        }
        case "merging":
          return ui.spin("Merging video and audio");
        case "converting":
          return ui.spin("Converting to mp3");
        case "reusing":
          return ui.think("Already downloaded, reusing it");
        case "removed":
          return ui.think(`Removed old ${event.file}`);
        case "gallery":
          return ui.spin("No video found, using gallery-dl");
        case "processing":
          return ui.spin(event.label);
      }
    });
  } catch (err) {
    ui.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  ui.done();
  ui.think(`Saved ${paths.length} file${paths.length > 1 ? "s" : ""} as ${command.format}:`);
  for (const path of paths) console.log(pathToFileURL(path).href);
}

await main();

export {};
