/** Render a tweet (text, media, quotes) into a saved PNG card, Twitter-style.
 *  Uses X's public syndication API (same source as embedded tweets) — no auth. */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { downloadsDir } from "./download";

type Author = { name: string; handle: string; avatar: string | null };
type Media = { url: string; video: boolean; width: number; height: number };
type Tweet = { author: Author; text: string; date: string; likes: number; replies: number };

// --- data: X syndication API (cdn.syndication.twimg.com) ---

function tweetId(url: string): string | null {
  return url.match(/status(?:es)?\/(\d+)/i)?.[1] ?? null;
}

// The soft token the embed widget derives from the id.
function syndToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

async function getTweet(id: string): Promise<Record<string, any> | null> {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndToken(id)}&lang=en`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return null;
  const data = (await res.json()) as Record<string, any>;
  if (!data || data.__typename === "TweetTombstone" || typeof data.text !== "string") return null;
  return data;
}

function authorOf(d: Record<string, any>): Author {
  const u = d.user ?? {};
  const avatar = String(u.profile_image_url_https ?? "").replace("_normal", "_400x400");
  return {
    name: String(u.name ?? "Unknown"),
    handle: String(u.screen_name ?? ""),
    avatar: avatar || null,
  };
}

// Replace t.co links with their readable form and drop the trailing media link.
function cleanText(d: Record<string, any>): string {
  let t = String(d.text ?? "");
  for (const u of d.entities?.urls ?? []) {
    if (u.url && u.display_url) t = t.split(u.url).join(u.display_url);
  }
  for (const m of d.entities?.media ?? []) {
    if (m.url) t = t.split(m.url).join("");
  }
  return t.trim();
}

function toTweet(d: Record<string, any>): Tweet {
  return {
    author: authorOf(d),
    text: cleanText(d),
    date: String(d.created_at ?? "").slice(0, 10),
    likes: Number(d.favorite_count ?? 0),
    replies: Number(d.conversation_count ?? 0),
  };
}

function mediaOf(d: Record<string, any>): Media[] {
  return (d.mediaDetails ?? []).slice(0, 4).map((m: Record<string, any>) => ({
    url: String(m.media_url_https ?? ""), // for video this is the poster frame
    video: m.type === "video" || m.type === "animated_gif",
    width: Number(m.original_info?.width) || 0,
    height: Number(m.original_info?.height) || 0,
  }));
}

async function fetchImage(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// --- emoji (Twemoji SVGs) ---
const ZWJ = "‍";
const emojiCache = new Map<string, string>();

function toCodePoint(str: string): string {
  const out: string[] = [];
  let high = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (high) {
      out.push((0x10000 + ((high - 0xd800) << 10) + (c - 0xdc00)).toString(16));
      high = 0;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      high = c;
    } else {
      out.push(c.toString(16));
    }
  }
  return out.join("-");
}

async function loadEmoji(segment: string): Promise<string> {
  const normalized = segment.includes(ZWJ) ? segment : segment.replace(/️/g, "");
  const code = toCodePoint(normalized);
  const cached = emojiCache.get(code);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(`https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg/${code}.svg`);
    const uri = res.ok
      ? `data:image/svg+xml;base64,${Buffer.from(await res.text()).toString("base64")}`
      : "";
    emojiCache.set(code, uri);
    return uri;
  } catch {
    return "";
  }
}

// --- layout ---
const compact = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
};

const GRAY = "#536471";
const INNER = 576; // 640 width - 32 padding each side
const MEDIA_H = 320; // grid block height
const MEDIA_MAX_H = 720; // cap for a single (tall) image
const GAP = 4;

const text = (value: string, style: Record<string, unknown>) => ({
  type: "div",
  props: { style: { display: "flex", ...style }, children: value },
});

function avatarNode(src: string | null, size: number) {
  return src
    ? { type: "img", props: { src, width: size, height: size, style: { borderRadius: size / 2 } } }
    : {
        type: "div",
        props: { style: { width: size, height: size, borderRadius: size / 2, backgroundColor: "#cfd9de" } },
      };
}

function authorRow(a: Author, avatar: string | null, size: number, nameSize: number) {
  return {
    type: "div",
    props: {
      style: { display: "flex", alignItems: "center" },
      children: [
        avatarNode(avatar, size),
        {
          type: "div",
          props: {
            style: { display: "flex", flexDirection: "column", marginLeft: 10 },
            children: [
              text(a.name, { fontSize: nameSize, fontWeight: 700 }),
              text(a.handle ? `@${a.handle}` : "", { fontSize: nameSize - 6, color: GRAY }),
            ],
          },
        },
      ],
    },
  };
}

function imageTile(uri: string, w: number, h: number, video: boolean, radius = 0) {
  const img = {
    type: "img",
    props: { src: uri, width: w, height: h, style: { objectFit: "cover", borderRadius: radius } },
  };
  if (!video) return img;
  return {
    type: "div",
    props: {
      style: { display: "flex", position: "relative", width: w, height: h, borderRadius: radius, overflow: "hidden" },
      children: [
        img,
        {
          type: "div",
          props: {
            style: {
              position: "absolute",
              top: 0,
              left: 0,
              width: w,
              height: h,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    width: 64,
                    height: 64,
                    borderRadius: 32,
                    backgroundColor: "rgba(0,0,0,0.55)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  },
                  children: [
                    {
                      type: "div",
                      props: {
                        style: {
                          width: 0,
                          height: 0,
                          marginLeft: 6,
                          borderTop: "12px solid transparent",
                          borderBottom: "12px solid transparent",
                          borderLeft: "20px solid white",
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  };
}

type MediaItem = { uri: string; video: boolean; width: number; height: number };

function buildMedia(items: MediaItem[]): { node: unknown; height: number } {
  const row = (children: unknown[]) => ({
    type: "div",
    props: { style: { display: "flex", gap: GAP }, children },
  });
  const col = (children: unknown[]) => ({
    type: "div",
    props: { style: { display: "flex", flexDirection: "column", gap: GAP }, children },
  });

  if (items.length === 1) {
    const it = items[0];
    const nw = it.width || 16;
    const nh = it.height || 9;
    let w = INNER;
    let h = Math.round((INNER * nh) / nw);
    if (h > MEDIA_MAX_H) {
      h = MEDIA_MAX_H;
      w = Math.round((MEDIA_MAX_H * nw) / nh);
    }
    const node = {
      type: "div",
      props: {
        style: { display: "flex", marginTop: 16, justifyContent: w < INNER ? "center" : "flex-start" },
        children: [imageTile(it.uri, w, h, it.video, 16)],
      },
    };
    return { node, height: h + 16 };
  }

  const w = (INNER - GAP) / 2;
  const h = (MEDIA_H - GAP) / 2;
  let inner: unknown;
  if (items.length === 2) {
    inner = row(items.map((m) => imageTile(m.uri, w, MEDIA_H, m.video)));
  } else if (items.length === 3) {
    inner = row([
      imageTile(items[0].uri, w, MEDIA_H, items[0].video),
      col([imageTile(items[1].uri, w, h, items[1].video), imageTile(items[2].uri, w, h, items[2].video)]),
    ]);
  } else {
    inner = col([
      row([imageTile(items[0].uri, w, h, items[0].video), imageTile(items[1].uri, w, h, items[1].video)]),
      row([imageTile(items[2].uri, w, h, items[2].video), imageTile(items[3].uri, w, h, items[3].video)]),
    ]);
  }

  const node = {
    type: "div",
    props: {
      style: { display: "flex", marginTop: 16, borderRadius: 16, overflow: "hidden" },
      children: [inner],
    },
  };
  return { node, height: MEDIA_H + 16 };
}

function quotedBox(q: Tweet, avatar: string | null) {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column",
        marginTop: 16,
        padding: 16,
        border: "1px solid #cfd9de",
        borderRadius: 16,
      },
      children: [
        authorRow(q.author, avatar, 32, 18),
        text(q.text, { fontSize: 20, lineHeight: 1.3, marginTop: 8, whiteSpace: "pre-wrap", color: "#0f1419" }),
      ],
    },
  };
}

function cardElement(
  main: Tweet,
  mainAvatar: string | null,
  mediaNode: unknown | null,
  quoted: Tweet | null,
  quotedAvatar: string | null,
): unknown {
  const children: unknown[] = [authorRow(main.author, mainAvatar, 56, 24)];
  if (main.text) {
    children.push(text(main.text, { fontSize: 28, lineHeight: 1.35, marginTop: 20, whiteSpace: "pre-wrap" }));
  }
  if (mediaNode) children.push(mediaNode);
  if (quoted) children.push(quotedBox(quoted, quotedAvatar));
  children.push({
    type: "div",
    props: {
      style: { display: "flex", marginTop: 20, fontSize: 18, color: GRAY },
      children: [
        text(`${compact(main.replies)} replies`, { marginRight: 20 }),
        text(`${compact(main.likes)} likes`, {}),
      ],
    },
  });
  children.push(text(main.date, { marginTop: 8, fontSize: 16, color: GRAY }));

  return {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#ffffff",
        padding: 32,
        fontFamily: "Sans",
        color: "#0f1419",
      },
      children,
    },
  };
}

const lineCount = (s: string, perLine: number): number =>
  s.split("\n").reduce((acc, line) => acc + Math.max(1, Math.ceil(line.length / perLine)), 0);

/** Fetch a tweet via the syndication API and save a rendered card PNG. */
export async function saveCard(url: string): Promise<string> {
  const id = tweetId(url);
  if (!id) throw new Error("That doesn't look like a tweet URL.");

  const data = await getTweet(id);
  if (!data) {
    throw new Error("Couldn't load that tweet. It may be private, removed, or age-restricted.");
  }

  const main = toTweet(data);
  const media = mediaOf(data);
  const quoted = data.quoted_tweet ? toTweet(data.quoted_tweet) : null;

  const [mainAvatar, quotedAvatar, ...mediaUris] = await Promise.all([
    fetchImage(main.author.avatar),
    quoted ? fetchImage(quoted.author.avatar) : Promise.resolve(null),
    ...media.map((m) => fetchImage(m.url)),
  ]);
  const mediaItems = media
    .map((m, i) => ({ uri: mediaUris[i], video: m.video, width: m.width, height: m.height }))
    .filter((m): m is MediaItem => Boolean(m.uri));
  const built = mediaItems.length ? buildMedia(mediaItems) : null;

  const fontDir = join(import.meta.dir, "..", "assets");
  const [regular, bold] = await Promise.all([
    Bun.file(join(fontDir, "Sans-Regular.ttf")).arrayBuffer(),
    Bun.file(join(fontDir, "Sans-Bold.ttf")).arrayBuffer(),
  ]);

  const width = 640;
  let height = 32 + 72 + lineCount(main.text, 46) * 40 + 24 + 28 + 24 + 32;
  if (built) height += built.height;
  if (quoted) height += 32 + 56 + lineCount(quoted.text, 52) * 28 + 16;

  const svg = await satori(cardElement(main, mainAvatar, built?.node ?? null, quoted, quotedAvatar) as never, {
    width,
    height,
    fonts: [
      { name: "Sans", data: regular, weight: 400, style: "normal" },
      { name: "Sans", data: bold, weight: 700, style: "normal" },
    ],
    loadAdditionalAsset: async (code, segment) => (code === "emoji" ? loadEmoji(segment) : ""),
  });

  const png = new Resvg(svg, { fitTo: { mode: "width", value: width * 2 } }).render().asPng();

  const outDir = downloadsDir();
  await mkdir(outDir, { recursive: true });
  const out = join(outDir, `tweet ${main.author.handle || id} [${id}].png`);
  await Bun.write(out, png);
  return out;
}
