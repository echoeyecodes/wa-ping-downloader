#!/usr/bin/env bun
/** `npm run pair` — link this device by scanning a QR code from WhatsApp. */

import qrcode from "qrcode-terminal";
import { runSocket } from "./wa";

console.log("Open WhatsApp, go to Settings, Linked Devices, Link a Device, then scan:\n");

await runSocket({
  onQr: (qr) => qrcode.generate(qr, { small: true }),
  onOpen: (sock) => {
    console.log(`\nPaired as ${sock.user?.id}. Now run: npm run bot`);
    setTimeout(() => process.exit(0), 1500);
  },
  onLoggedOut: () => {
    console.error("Logged out. Delete the .wa-auth folder and pair again.");
    process.exit(1);
  },
});

export {};
