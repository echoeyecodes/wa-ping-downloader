#!/usr/bin/env bun
/** `npm run bot` — watch your WhatsApp self-chat for links and download them. */

import { parse as parsePath } from "node:path";
import type {
  AnyMessageContent,
  WAMessage,
  WAMessageKey,
  WASocket,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { saveCard } from "./card";
import { config } from "./config";
import { type Command, download, parseCommand, videoMeta } from "./download";
import { linkState, startLinkServer } from "./link";
import { extractText, isMentioned, isSelfChat, runSocket } from "./wa";

const isCardUrl = (url: string): boolean =>
  /(?:x|twitter)\.com\/[^/]+\/status\//i.test(url) || /instagram\.com\/(?:p|reel|tv)\//i.test(url);

const ALBUM_IMAGE = ["jpg", "jpeg", "png", "webp"];
const ALBUM_VIDEO = ["mp4", "mov", "mkv", "webm", "m4v", "gif"];

const extOf = (path: string): string => parsePath(path).ext.toLowerCase().slice(1);
const isAlbumMedia = (path: string): boolean =>
  ALBUM_IMAGE.includes(extOf(path)) || ALBUM_VIDEO.includes(extOf(path));

/** Build the right WhatsApp message for a file based on its actual type. */
async function mediaContent(path: string): Promise<AnyMessageContent> {
  const { base } = parsePath(path);
  const e = extOf(path);
  if (["mp3", "m4a", "aac", "opus", "ogg", "wav"].includes(e)) {
    return { audio: { url: path }, mimetype: e === "mp3" ? "audio/mpeg" : `audio/${e}`, fileName: base };
  }
  if (e === "gif") {
    return { video: { url: path }, gifPlayback: true, caption: base, ...(await videoMeta(path)) } as AnyMessageContent;
  }
  if (ALBUM_VIDEO.includes(e)) {
    return { video: { url: path }, mimetype: "video/mp4", caption: base, ...(await videoMeta(path)) } as AnyMessageContent;
  }
  if (ALBUM_IMAGE.includes(e)) return { image: { url: path }, caption: base };
  return { document: { url: path }, mimetype: "application/octet-stream", fileName: base };
}

/** A single child of an album: image or video tied to the parent album message. */
async function albumChild(path: string, parent: WAMessageKey): Promise<AnyMessageContent> {
  const e = extOf(path);
  if (ALBUM_IMAGE.includes(e)) return { image: { url: path }, albumParentKey: parent };
  const meta = await videoMeta(path);
  if (e === "gif") {
    return { video: { url: path }, gifPlayback: true, albumParentKey: parent, ...meta } as AnyMessageContent;
  }
  return { video: { url: path }, mimetype: "video/mp4", albumParentKey: parent, ...meta } as AnyMessageContent;
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
    for (const f of files) await sock.sendMessage(jid, await mediaContent(f), { quoted });
    return;
  }
  for (const f of files) await sock.sendMessage(jid, await albumChild(f, parent.key));
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

/** Show the "typing…" indicator until stop() is called, refreshing so it stays on. */
function startTyping(sock: WASocket, jid: string): () => void {
  let active = true;
  const tick = () => {
    if (active) void sock.sendPresenceUpdate("composing", jid).catch(() => {});
  };
  tick();
  const timer = setInterval(tick, 9000);
  return () => {
    active = false;
    clearInterval(timer);
    void sock.sendPresenceUpdate("paused", jid).catch(() => {});
  };
}

async function handleCard(sock: WASocket, jid: string, msg: WAMessage, url: string): Promise<void> {
  const stopTyping = startTyping(sock, jid);
  try {
    const path = await saveCard(url);
    stopTyping();
    await sock.sendMessage(jid, { image: { url: path } }, { quoted: msg });
  } catch (err) {
    stopTyping();
    await sock.sendMessage(
      jid,
      { text: `Failed: ${err instanceof Error ? err.message : String(err)}` },
      { quoted: msg },
    );
  }
}

async function handleCommand(
  sock: WASocket,
  jid: string,
  msg: WAMessage,
  { url, format }: Command,
): Promise<void> {
  const reply = (text: string) => sock.sendMessage(jid, { text }, { quoted: msg });
  const stopTyping = startTyping(sock, jid);

  let paths: string[];
  try {
    paths = await download({ url, format });
  } catch (err) {
    stopTyping();
    await reply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  stopTyping();

  const album = paths.filter(isAlbumMedia);
  const singles = paths.filter((p) => !isAlbumMedia(p));

  try {
    if (album.length >= 2) {
      await sendAlbum(sock, jid, msg, album);
    } else {
      for (const path of album) await sock.sendMessage(jid, await mediaContent(path), { quoted: msg });
    }
    for (const path of singles) await sock.sendMessage(jid, await mediaContent(path), { quoted: msg });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await reply(`Couldn't send the files: ${reason}. They are saved in:\n${parsePath(paths[0]).dir}`);
  }
}

const linkHint = startLinkServer();

await runSocket({
  relinkOnLogout: true,
  onQr: (qr) => {
    linkState.status = "waiting";
    linkState.qr = qr;
    if (linkHint) {
      if (!pairHintShown) {
        pairHintShown = true;
        console.log(`Not linked. Open the link page (${linkHint}) to scan.`);
      }
    } else {
      console.log("Not linked. Scan this QR (or set LINK_TOKEN to use the web page):");
      qrcode.generate(qr, { small: true });
    }
  },
  onLoggedOut: () => {
    pairHintShown = false;
    linkState.status = "waiting";
    linkState.qr = null;
    linkState.user = null;
    console.log("WhatsApp unlinked this device. Re-linking — open the link page.");
  },
  onOpen: (sock) => {
    startedAt = Math.floor(Date.now() / 1000);
    pairHintShown = false;
    linkState.status = "linked";
    linkState.user = sock.user?.id ?? null;
    linkState.qr = null;
    console.log(`Bot ready as ${sock.user?.id}. DMs=${config.dms}, Groups=${config.groups}`);
  },
  onMessages: async (sock, messages) => {
    for (const msg of messages) {
      const jid = msg.key?.remoteJid;
      if (!jid) continue;
      // Ignore backlog delivered on reconnect so old links aren't re-downloaded.
      if (Number(msg.messageTimestamp) < startedAt - 5) continue;
      if (!shouldHandle(jid, msg, sock)) continue;

      const body = extractText(msg);
      const command = parseCommand(body);
      if (!command) continue;
      // "card" + a tweet/Instagram link → render a card image instead of downloading.
      if (/\bcard\b/i.test(body) && isCardUrl(command.url)) {
        await handleCard(sock, jid, msg, command.url);
        continue;
      }
      await handleCommand(sock, jid, msg, command);
    }
  },
});

export {};
