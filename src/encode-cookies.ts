#!/usr/bin/env bun
/**
 * Encode a cookies.txt to base64 for GALLERY_DL_COOKIES_B64.
 * Prints it by default, or writes it to .env with --write / -w.
 *
 *   npm run encode-cookies                      # print ./cookies.txt
 *   npm run encode-cookies /path/cookies.txt    # print a given file
 *   npm run encode-cookies -- --write           # write ./cookies.txt to .env
 */

import { readFile, writeFile } from "node:fs/promises";

const KEY = "GALLERY_DL_COOKIES_B64";

const args = Bun.argv.slice(2);
const write = args.some((a) => a === "--write" || a === "-w");
const path = args.find((a) => !a.startsWith("-")) ?? "cookies.txt";

let data: Buffer;
try {
  data = await readFile(path);
} catch {
  process.stderr.write(`Couldn't read "${path}". Pass a path or put cookies.txt in this folder.\n`);
  process.exit(1);
}

const b64 = data.toString("base64");

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
process.stderr.write(`Wrote ${KEY} to ${file}\n`);

export {};
