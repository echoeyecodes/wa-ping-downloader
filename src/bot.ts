#!/usr/bin/env bun
/** `npm run bot` — watch your WhatsApp self-chat for links and download them. */

import { parse as parsePath } from "node:path";
import type {
  AnyMessageContent,
  WAMessage,
  WAMessageKey,
  WASocket,
} from "@whiskeysockets/baileys";
import { config } from "./config";
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

/** Decide whether a message is in scope, per the .env config. */
function shouldHandle(jid: string, msg: WAMessage, sock: WASocket): boolean {
  const fromMe = msg.key?.fromMe === true;

  if (jid.endsWith("@g.us")) {
    if (config.groups === "off") return false;
    if (fromMe) return false; // don't act on my own group posts
    if (config.groups === "mention") return isMentioned(msg, sock);
    return true; // "all"
  }

  if (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid")) {
    if (config.dms === "off") return false;
    const self = isSelfChat(jid, sock);
    if (fromMe && !self) return false; // my outgoing DMs to other people
    if (config.dms === "self") return self;
    return true; // "anyone" (incoming from others, plus my self-chat)
  }

  return false; // broadcasts, status, newsletters, etc.
}

async function handleCommand(
  sock: WASocket,
  jid: string,
  msg: WAMessage,
  { url, format }: Command,
): Promise<void> {
  const reply = (text: string) => sock.sendMessage(jid, { text }, { quoted: msg });
  const say = (text: string) => void reply(text).catch(() => {});

  await reply("Working on it.");

  // Tell the user what it is (and the format) once download() figures it out.
  let announced = false;
  const onEvent = (event: DownloadEvent): void => {
    if (announced) return;
    if (event.kind === "fetching" || event.kind === "progress") {
      announced = true;
      say(`Video found. Saving as ${format}.`);
    } else if (event.kind === "gallery") {
      announced = true;
      say(`Photo or gallery post. Saving photos as-is and videos as ${format}.`);
    }
  };

  let paths: string[];
  try {
    paths = await download({ url, format }, onEvent);
  } catch (err) {
    await reply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
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
    await reply(`Couldn't send the files: ${reason}. They are saved in:\n${parsePath(paths[0]).dir}`);
  }
}

await runSocket({
  onQr: () => {
    if (pairHintShown) return;
    pairHintShown = true;
    console.log("Not paired yet. Stop this and run: npm run pair");
  },
  onOpen: (sock) => {
    startedAt = Math.floor(Date.now() / 1000);
    console.log(`Bot ready as ${sock.user?.id}. DMs=${config.dms}, Groups=${config.groups}`);
  },
  onMessages: async (sock, messages) => {
    for (const msg of messages) {
      const jid = msg.key?.remoteJid;
      if (!jid) continue;
      // Ignore backlog delivered on reconnect so old links aren't re-downloaded.
      if (Number(msg.messageTimestamp) < startedAt - 5) continue;
      if (!shouldHandle(jid, msg, sock)) continue;

      const command = parseCommand(extractText(msg));
      if (!command) continue;
      await handleCommand(sock, jid, msg, command);
    }
  },
});

export {};
