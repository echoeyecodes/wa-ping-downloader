/** A small authenticated web page that shows the QR for linking. */

import QRCode from "qrcode";

export type LinkState = {
  status: "connecting" | "waiting" | "linked";
  qr: string | null;
  user: string | null;
};

export const linkState: LinkState = {
  status: "connecting",
  qr: null,
  user: null,
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

async function renderPage(): Promise<string> {
  const refresh = linkState.status === "linked" ? "" : `<meta http-equiv="refresh" content="5">`;

  let body: string;
  if (linkState.status === "linked") {
    body = `<h1>Linked</h1><p>Connected as ${escapeHtml(linkState.user ?? "")}.</p>`;
  } else if (linkState.qr) {
    const svg = await QRCode.toString(linkState.qr, { type: "svg", margin: 1, width: 320 });
    body = `<h1>Scan to link</h1><p>WhatsApp, Settings, Linked Devices, Link a Device, then scan:</p>${svg}<p>This page refreshes on its own.</p>`;
  } else {
    body = `<h1>Starting</h1><p>Waiting for a QR. This page refreshes on its own.</p>`;
  }

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>ping link</title><style>body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px}svg{width:100%;height:auto}</style></head><body>${body}</body></html>`;
}

/**
 * Start the protected link page if LINK_TOKEN is set. Returns the URL hint, or
 * null when no token is set (the caller should show the QR in the terminal).
 */
export function startLinkServer(): string | null {
  const token = process.env.LINK_TOKEN?.trim();
  const port = Number(process.env.PORT ?? 3000);
  if (!token) return null;

  Bun.serve({
    port,
    idleTimeout: 30,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/health") return new Response("ok");
      if (url.pathname !== "/link") return new Response("Not found", { status: 404 });
      if (url.searchParams.get("token") !== token) return new Response("Unauthorized", { status: 401 });
      return new Response(await renderPage(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });

  return `port ${port}, path /link?token=...`;
}
