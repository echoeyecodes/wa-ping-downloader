#!/usr/bin/env bun
/**
 * Encode the Instagram + YouTube cookies from a cookies.txt to base64 for
 * GALLERY_DL_COOKIES_B64. Only those domains are kept — never encode your whole
 * browser cookie jar.
 *
 *   npm run encode-cookies                      # print ./cookies.txt (filtered)
 *   npm run encode-cookies /path/cookies.txt    # print a given file
 *   npm run encode-cookies -- --write           # write to .env
 */

import { readFile, writeFile } from "node:fs/promises";

const KEY = "GALLERY_DL_COOKIES_B64";
const HEADER = "# Netscape HTTP Cookie File";
// Sites that need login cookies. youtube.com bypasses YouTube's server bot check;
// x.com/twitter.com are needed to read tweets (guest access is gone).
const DOMAINS = ["instagram.com", "youtube.com", "x.com", "twitter.com"];

const args = Bun.argv.slice(2);
const write = args.some((a) => a === "--write" || a === "-w");
const path = args.find((a) => !a.startsWith("-")) ?? "cookies.txt";

let raw: string;
try {
  raw = await readFile(path, "utf8");
} catch {
  process.stderr.write(`Couldn't read "${path}". Pass a path or put cookies.txt in this folder.\n`);
  process.exit(1);
}

// Keep only the allowed sites' cookie lines; drop everything else so other
// sessions never get encoded or shipped.
const cookies = raw
  .split(/\r?\n/)
  .filter((line) => line && !line.startsWith("#"))
  .filter((line) => {
    const domain = line.split("\t")[0] ?? "";
    return DOMAINS.some((d) => domain.includes(d));
  });

if (cookies.length === 0) {
  process.stderr.write(`No ${DOMAINS.join(" / ")} cookies found in "${path}".\n`);
  process.exit(1);
}

const b64 = Buffer.from(`${HEADER}\n${cookies.join("\n")}\n`, "utf8").toString("base64");

if (!write) {
  process.stdout.write(b64);
  process.exit(0);
}

const file = ".env";
let content = "";
try {
  content = await readFile(file, "utf8");
} catch {
  // no .env yet; we'll create it
}

const line = `${KEY}=${b64}`;
const existing = new RegExp(`^${KEY}=.*$`, "m");
if (existing.test(content)) {
  content = content.replace(existing, () => line);
} else {
  content = content && !content.endsWith("\n") ? `${content}\n${line}\n` : `${content}${line}\n`;
}

await writeFile(file, content);
process.stderr.write(`Wrote ${KEY} to ${file} (${cookies.length} cookies)\n`);

export {};
