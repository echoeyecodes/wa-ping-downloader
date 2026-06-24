/** Thin Baileys glue: auth dir, quiet logger, a reconnecting socket runner, and helpers. */

import { rm } from "node:fs/promises";
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";

export const AUTH_DIR = process.env.WA_AUTH_DIR?.trim() || `${process.cwd()}/.wa-auth`;

// Baileys expects a pino-like logger; we don't want its chatter on the CLI.
const quietLogger: any = {
  level: "silent",
  fatal() {},
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child() {
    return quietLogger;
  },
};

type Handlers = {
  onQr?: (qr: string) => void;
  onOpen?: (sock: WASocket) => void;
  onLoggedOut?: () => void;
  onMessages?: (sock: WASocket, messages: WAMessage[]) => void | Promise<void>;
  /** On logout, wipe the dead session and start linking again instead of stopping. */
  relinkOnLogout?: boolean;
};

/** Run a WhatsApp socket, auto-reconnecting on transient drops (e.g. restart-required). */
export async function runSocket(handlers: Handlers): Promise<void> {
  const { version } = await fetchLatestBaileysVersion();
  let stopped = false;

  const start = async (): Promise<void> => {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const sock = makeWASocket({
      version,
      auth: state,
      logger: quietLogger,
      browser: Browsers.macOS("Desktop"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async () => undefined,
    });

    sock.ev.on("creds.update", async () => {
      try {
        await saveCreds();
      } catch (err) {
        console.error(`Failed to save WhatsApp session to ${AUTH_DIR}:`, err);
      }
    });

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) handlers.onQr?.(qr);
      if (connection === "open") handlers.onOpen?.(sock);
      if (connection === "close") {
        const code = (lastDisconnect?.error as any)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          handlers.onLoggedOut?.();
          if (handlers.relinkOnLogout && !stopped) {
            rm(AUTH_DIR, { recursive: true, force: true })
              .catch(() => {})
              .then(() => setTimeout(() => void start(), 1000));
          }
          return;
        }
        if (!stopped) setTimeout(() => void start(), 2000);
      }
    });

    if (handlers.onMessages) {
      sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        await handlers.onMessages?.(sock, messages);
      });
    }
  };

  await start();
}

export function extractText(msg: WAMessage): string {
  const m = msg.message;
  return (
    m?.conversation ??
    m?.extendedTextMessage?.text ??
    m?.imageMessage?.caption ??
    m?.videoMessage?.caption ??
    ""
  );
}

const baseNumber = (jid: string | null | undefined): string =>
  (jid ?? "").split("@")[0].split(":")[0];

/** True if a chat JID is the user's own self-chat (phone- or lid-based). */
export function isSelfChat(jid: string | null | undefined, sock: WASocket): boolean {
  if (!jid) return false;
  const chat = baseNumber(jid);
  return chat !== "" && (chat === baseNumber(sock.user?.id) || chat === baseNumber(sock.user?.lid));
}

/** True if the logged-in user is @-mentioned in the message. */
export function isMentioned(msg: WAMessage, sock: WASocket): boolean {
  const m = msg.message;
  const ctx =
    m?.extendedTextMessage?.contextInfo ??
    m?.imageMessage?.contextInfo ??
    m?.videoMessage?.contextInfo ??
    m?.documentMessage?.contextInfo;
  const mentioned = ctx?.mentionedJid ?? [];
  const me = baseNumber(sock.user?.id);
  const lid = baseNumber(sock.user?.lid);
  return mentioned.some((j) => baseNumber(j) === me || baseNumber(j) === lid);
}
