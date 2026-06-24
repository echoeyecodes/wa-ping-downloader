#!/usr/bin/env bun
/** `npm run bot` — watch your WhatsApp self-chat for links and download them. */

import { parse as parsePath } from "node:path";
import type {
  AnyMessageContent,
  WAMessage,
  WAMessageKey,
  WASocket,
} from "@whiskeysockets/baileys";
import { type Command, type DownloadEvent, download, parseCommand } from "./download";
import { extractText, isMentioned, isSelfChat, runSocket } from "./wa";

const ALBUM_IMAGE = ["jpg", "jpeg", "png", "webp"];
const ALBUM_VIDEO = ["mp4", "mov", "mkv", "webm", "m4v", "gif"];

const extOf = (path: string): string => parsePath(path).ext.toLowerCase().slice(1);
const isAlbumMedia = (path: string): boolean =>
  ALBUM_IMAGE.includes(extOf(path)) || ALBUM_VIDEO.includes(extOf(path));

/** Build the right WhatsApp message for a file based on its actual type. */
function mediaContent(path: string): AnyMessageContent {
  const { base } = parsePath(path);
  const e = extOf(path);
  if (["mp3", "m4a", "aac", "opus", "ogg", "wav"].includes(e)) {
    return { audio: { url: path }, mimetype: e === "mp3" ? "audio/mpeg" : `audio/${e}`, fileName: base };
  }
  if (e === "gif") return { video: { url: path }, gifPlayback: true, caption: base };
  if (ALBUM_VIDEO.includes(e)) return { video: { url: path }, mimetype: "video/mp4", caption: base };
  if (ALBUM_IMAGE.includes(e)) return { image: { url: path }, caption: base };
  return { document: { url: path }, mimetype: "application/octet-stream", fileName: base };
}

/** A single child of an album: image or video tied to the parent album message. */
function albumChild(path: string, parent: WAMessageKey): AnyMessageContent {
  const e = extOf(path);
  if (ALBUM_IMAGE.includes(e)) return { image: { url: path }, albumParentKey: parent };
  if (e === "gif") return { video: { url: path }, gifPlayback: true, albumParentKey: parent };
  return { video: { url: path }, mimetype: "video/mp4", albumParentKey: parent };
}

/** Send images/videos as one album so they arrive together. */
async function sendAlbum(
  sock: WASocket,
  jid: string,
  quoted: WAMessage,
  files: string[],
): Promise<void> {
  const expectedImageCount = files.filter((f) => ALBUM_IMAGE.includes(extOf(f))).length;
  const expectedVideoCount = files.length - expectedImageCount;
  const parent = await sock.sendMessage(
    jid,
    { album: { expectedImageCount, expectedVideoCount } },
    { quoted },
  );
  if (!parent?.key) {
    for (const f of files) await sock.sendMessage(jid, mediaContent(f), { quoted });
    return;
  }
  for (const f of files) await sock.sendMessage(jid, albumChild(f, parent.key));
}

let pairHintShown = false;
let startedAt = 0;

async function handleCommand(
  sock: WASocket,
  jid: string,
  msg: WAMessage,
  { url, format }: Command,
): Promise<void> {
  const reply = (text: string) => sock.sendMessage(jid, { text }, { quoted: msg });
  const say = (text: string) => void reply(text).catch(() => {});

  await reply("📥 Got your link — working on it…");

  // Announce what it actually is (and the format) once download() figures it out.
  let announced = false;
  const onEvent = (event: DownloadEvent): void => {
    if (announced) return;
    if (event.kind === "fetching" || event.kind === "progress") {
      announced = true;
      say(`🎬 It's a video — saving as *${format}*…`);
    } else if (event.kind === "gallery") {
      announced = true;
      say(`🖼️ Photo/gallery post — photos saved as-is, any videos as *${format}*…`);
    }
  };

  let paths: string[];
  try {
    paths = await download({ url, format }, onEvent);
  } catch (err) {
    await reply(`✖ ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const album = paths.filter(isAlbumMedia);
  const singles = paths.filter((p) => !isAlbumMedia(p));

  try {
    if (album.length >= 2) {
      await sendAlbum(sock, jid, msg, album);
    } else {
      for (const path of album) await sock.sendMessage(jid, mediaContent(path), { quoted: msg });
    }
    for (const path of singles) await sock.sendMessage(jid, mediaContent(path), { quoted: msg });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await reply(`✖ Couldn't attach files (${reason}). Saved in:\n${parsePath(paths[0]).dir}`);
  }
}

await runSocket({
  onQr: () => {
    if (pairHintShown) return;
    pairHintShown = true;
    console.log("⚠️  Not paired yet. Stop this and run:  npm run pair");
  },
  onOpen: (sock) => {
    startedAt = Math.floor(Date.now() / 1000);
    console.log(`🤖 Bot ready as ${sock.user?.id}. It downloads links from DMs and groups (optionally "mp3").`);
  },
  onMessages: async (sock, messages) => {
    for (const msg of messages) {
      const jid = msg.key?.remoteJid;
      if (!jid) continue;
      // DMs and groups only — skip broadcasts, status, and newsletters.
      const allowed =
        jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid") || jid.endsWith("@g.us");
      if (!allowed) continue;
      // Handle links others send (in DMs or groups) plus links I send myself;
      // skip my own outgoing messages elsewhere (and my replies, which carry no URL).
      if (msg.key?.fromMe === true && !isSelfChat(jid, sock)) continue;
      // In groups, only act when I'm @-mentioned.
      if (jid.endsWith("@g.us") && !isMentioned(msg, sock)) continue;
      // Ignore backlog delivered on reconnect so old links aren't re-downloaded.
      if (Number(msg.messageTimestamp) < startedAt - 5) continue;

      const command = parseCommand(extractText(msg));
      if (!command) continue;
      await handleCommand(sock, jid, msg, command);
    }
  },
});

export {};
