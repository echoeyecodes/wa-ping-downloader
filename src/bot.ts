#!/usr/bin/env bun
/** `npm run bot` — watch your WhatsApp self-chat for links and download them. */

import { parse as parsePath } from "node:path";
import type { AnyMessageContent, WAMessage, WASocket } from "@whiskeysockets/baileys";
import { type Command, type Format, download, parseCommand } from "./download";
import { extractText, isMentioned, isSelfChat, runSocket } from "./wa";

function mediaContent(path: string, format: Format): AnyMessageContent {
  const { base } = parsePath(path);
  return format === "mp3"
    ? { audio: { url: path }, mimetype: "audio/mpeg", fileName: base }
    : { video: { url: path }, mimetype: "video/mp4", caption: base };
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

  await reply(`📥 Downloading as *${format}*…`);

  let paths: string[];
  try {
    paths = await download({ url, format });
  } catch (err) {
    await reply(`✖ ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  for (const path of paths) {
    try {
      await sock.sendMessage(jid, mediaContent(path, format), { quoted: msg });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await reply(`✖ Couldn't attach ${parsePath(path).base} (${reason}). Saved at:\n${path}`);
    }
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
