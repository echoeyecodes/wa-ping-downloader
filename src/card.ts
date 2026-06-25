/** Render a tweet (Twitter syndication) or Instagram post (gallery-dl) into a PNG card. */

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { download, downloadsDir, resolveCookies } from "./download";

const RENDER_SCALE = 2;

type Author = { name: string; handle: string; avatar: string | null };
type Media = { url: string; video: boolean; width: number; height: number };
type Tweet = { author: Author; text: string; date: string; likes: number; replies: number };

// --- data: X syndication API (cdn.syndication.twimg.com) ---

function tweetId(url: string): string | null {
  return url.match(/status(?:es)?\/(\d+)/i)?.[1] ?? null;
}

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

function normalizeText(s: string): string {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/︎/g, "");
}

function authorOf(d: Record<string, any>): Author {
  const u = d.user ?? {};
  const avatar = String(u.profile_image_url_https ?? "").replace("_normal", "_400x400");
  return {
    name: normalizeText(u.name ?? "Unknown"),
    handle: String(u.screen_name ?? ""),
    avatar: avatar || null,
  };
}

function cleanText(d: Record<string, any>): string {
  let t = String(d.text ?? "");
  for (const u of d.entities?.urls ?? []) {
    if (u.url && u.display_url) t = t.split(u.url).join(u.display_url);
  }
  for (const m of d.entities?.media ?? []) {
    if (m.url) t = t.split(m.url).join("");
  }
  return normalizeText(t).trim();
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
    url: String(m.media_url_https ?? ""),
    video: m.type === "video" || m.type === "animated_gif",
    width: Number(m.original_info?.width) || 0,
    height: Number(m.original_info?.height) || 0,
  }));
}

type LinkCard = {
  large: boolean;
  title: string;
  domain: string;
  description: string;
  image: { url: string; width: number; height: number } | null;
};

function linkCardOf(d: Record<string, any>): LinkCard | null {
  const c = d.card;
  if (!c?.binding_values) return null;
  const bv = c.binding_values as Record<string, any>;
  const str = (k: string): string => bv[k]?.string_value ?? "";

  const title = str("title");
  const domain = str("vanity_url") || str("domain");
  if (!title && !domain) return null;

  const large = c.name === "summary_large_image" || String(c.name).startsWith("player");
  const keys = large
    ? ["photo_image_full_size_large", "summary_photo_image_large", "thumbnail_image_large", "thumbnail_image"]
    : ["thumbnail_image_large", "thumbnail_image"];

  let image: LinkCard["image"] = null;
  for (const k of keys) {
    const v = bv[k]?.image_value;
    if (v?.url) {
      image = { url: v.url, width: Number(v.width) || 0, height: Number(v.height) || 0 };
      break;
    }
  }
  return { large, title, domain, description: str("description"), image };
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
const ACCENT = "#1d9bf0";
const SENTINEL = "#fe00ff";
const INNER = 576;
const QUOTE_INNER = 544;
const MEDIA_H = 320;
const MEDIA_MAX_H = 720;
const GAP = 4;

const PLAY_URI = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
    '<circle cx="32" cy="32" r="32" fill="#000" fill-opacity="0.55"/>' +
    '<path d="M25 19 L47 32 L25 45 Z" fill="#fff"/></svg>',
).toString("base64")}`;

const text = (value: string, style: Record<string, unknown>) => ({
  type: "div",
  props: { style: { display: "flex", ...style }, children: value },
});

function isEntity(word: string): boolean {
  const w = word.replace(/[)\].,!?:;"'»]+$/, "");
  if (/^[@#]\w/.test(w)) return true;
  if (/^https?:\/\//i.test(w)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(w);
}

function richText(content: string, fontSize: number, lineHeight: number, marginTop = 0) {
  const children: unknown[] = [];
  content.split("\n").forEach((line, li) => {
    if (li > 0) children.push({ type: "div", props: { style: { display: "flex", width: "100%", height: 0 } } });
    for (const tok of line.match(/\S+\s*/g) ?? []) {
      children.push({
        type: "div",
        props: {
          style: {
            display: "flex",
            whiteSpace: "pre",
            fontSize,
            lineHeight,
            color: isEntity(tok.trimEnd()) ? ACCENT : undefined,
          },
          children: tok,
        },
      });
    }
  });
  return {
    type: "div",
    props: { style: { display: "flex", flexWrap: "wrap", marginTop }, children },
  };
}

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

function imageTile(uri: string, w: number, h: number, video: boolean, radius = 0, sentinel = false) {
  if (sentinel) {
    return { type: "div", props: { style: { display: "flex", width: w, height: h, backgroundColor: SENTINEL } } };
  }
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
              top: (h - 64) / 2,
              left: (w - 64) / 2,
              display: "flex",
            },
            children: [{ type: "img", props: { src: PLAY_URI, width: 64, height: 64 } }],
          },
        },
      ],
    },
  };
}

type MediaItem = { uri: string; video: boolean; width: number; height: number };

function buildMedia(
  items: MediaItem[],
  fullW: number,
  gridH: number,
  maxH: number,
  radius: number,
  sentinel = false,
): { node: unknown; height: number } {
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
    let w = fullW;
    let h = Math.round((fullW * nh) / nw);
    if (h > maxH) {
      h = maxH;
      w = Math.round((maxH * nw) / nh);
    }
    const node = {
      type: "div",
      props: {
        style: { display: "flex", marginTop: 16, justifyContent: w < fullW ? "center" : "flex-start" },
        children: [imageTile(it.uri, w, h, it.video, radius, sentinel)],
      },
    };
    return { node, height: h + 16 };
  }

  const w = (fullW - GAP) / 2;
  const h = (gridH - GAP) / 2;
  let inner: unknown;
  if (items.length === 2) {
    inner = row(items.map((m) => imageTile(m.uri, w, gridH, m.video)));
  } else if (items.length === 3) {
    inner = row([
      imageTile(items[0].uri, w, gridH, items[0].video),
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
      style: { display: "flex", marginTop: 16, borderRadius: radius, overflow: "hidden" },
      children: [inner],
    },
  };
  return { node, height: gridH + 16 };
}

function buildLinkCard(info: LinkCard, imageUri: string | null): { node: unknown; height: number } {
  const domainNode = info.domain ? text(info.domain, { fontSize: 16, color: GRAY }) : null;
  const titleNode = text(info.title, { fontSize: 20, fontWeight: 700, marginTop: 2, color: "#0f1419" });

  if (info.large) {
    let imgH = 0;
    const imgNode = imageUri
      ? (() => {
          const nw = info.image?.width || 800;
          const nh = info.image?.height || 419;
          imgH = Math.min(360, Math.round((INNER * nh) / nw));
          return { type: "img", props: { src: imageUri, width: INNER, height: imgH, style: { objectFit: "cover" } } };
        })()
      : null;
    const textBox = {
      type: "div",
      props: {
        style: { display: "flex", flexDirection: "column", padding: 12 },
        children: [domainNode, titleNode].filter(Boolean),
      },
    };
    const node = {
      type: "div",
      props: {
        style: {
          display: "flex",
          flexDirection: "column",
          marginTop: 16,
          border: "1px solid #cfd9de",
          borderRadius: 16,
          overflow: "hidden",
        },
        children: imgNode ? [imgNode, textBox] : [textBox],
      },
    };
    const titleLines = Math.max(1, Math.ceil(info.title.length / 38));
    return { node, height: 16 + imgH + 12 + 22 + titleLines * 26 + 12 };
  }

  const sq = 130;
  const imgNode = imageUri
    ? { type: "img", props: { src: imageUri, width: sq, height: sq, style: { objectFit: "cover" } } }
    : { type: "div", props: { style: { width: sq, height: sq, backgroundColor: "#cfd9de" } } };
  const descNode = info.description
    ? text(info.description, { fontSize: 15, color: GRAY, marginTop: 2 })
    : null;
  const right = {
    type: "div",
    props: {
      style: { display: "flex", flexDirection: "column", padding: 12, flexGrow: 1 },
      children: [domainNode, titleNode, descNode].filter(Boolean),
    },
  };
  const node = {
    type: "div",
    props: {
      style: {
        display: "flex",
        marginTop: 16,
        border: "1px solid #cfd9de",
        borderRadius: 16,
        overflow: "hidden",
      },
      children: [imgNode, right],
    },
  };
  return { node, height: 16 + sq };
}

function quotedBox(q: Tweet, avatar: string | null, mediaNode: unknown | null) {
  const children: unknown[] = [authorRow(q.author, avatar, 32, 18)];
  if (q.text) children.push(richText(q.text, 20, 1.3, 8));
  if (mediaNode) children.push(mediaNode);
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
      children,
    },
  };
}

function cardElement(
  main: Tweet,
  mainAvatar: string | null,
  mediaNode: unknown | null,
  linkCardNode: unknown | null,
  quoted: Tweet | null,
  quotedAvatar: string | null,
  quotedMediaNode: unknown | null,
): unknown {
  const children: unknown[] = [authorRow(main.author, mainAvatar, 56, 24)];
  if (main.text) children.push(richText(main.text, 28, 1.35, 20));
  if (mediaNode) children.push(mediaNode);
  if (linkCardNode) children.push(linkCardNode);
  if (quoted) children.push(quotedBox(quoted, quotedAvatar, quotedMediaNode));
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

async function renderSvg(element: unknown, width: number, height: number): Promise<string> {
  const fontDir = join(import.meta.dir, "..", "assets");
  const [regular, bold, symbols] = await Promise.all([
    Bun.file(join(fontDir, "Sans-Regular.ttf")).arrayBuffer(),
    Bun.file(join(fontDir, "Sans-Bold.ttf")).arrayBuffer(),
    Bun.file(join(fontDir, "Symbols.woff")).arrayBuffer(),
  ]);
  return satori(element as never, {
    width,
    height,
    fonts: [
      { name: "Sans", data: regular, weight: 400, style: "normal" },
      { name: "Sans", data: bold, weight: 700, style: "normal" },
      { name: "Symbols", data: symbols, weight: 400, style: "normal" },
    ],
    loadAdditionalAsset: async (code, segment) => (code === "emoji" ? loadEmoji(segment) : ""),
  });
}

async function rasterize(svg: string, width: number, outName: string): Promise<string> {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width * RENDER_SCALE } }).render().asPng();
  const outDir = downloadsDir();
  await mkdir(outDir, { recursive: true });
  const out = join(outDir, outName);
  await Bun.write(out, png);
  return out;
}

/** Render a satori element tree to a PNG file in downloads/ and return its path. */
async function renderToFile(element: unknown, width: number, height: number, outName: string): Promise<string> {
  return rasterize(await renderSvg(element, width, height), width, outName);
}

function sentinelRect(svg: string): { x: number; y: number; w: number; h: number } | null {
  const m = svg.match(new RegExp(`<rect [^>]*fill="${SENTINEL}"[^>]*/>`));
  if (!m) return null;
  const r = m[0];
  const num = (attr: string) => Number(r.match(new RegExp(`${attr}="([\\d.]+)"`))?.[1] ?? 0);
  return {
    x: Math.round(num("x") * RENDER_SCALE),
    y: Math.round(num("y") * RENDER_SCALE),
    w: Math.round(num("width") * RENDER_SCALE),
    h: Math.round(num("height") * RENDER_SCALE),
  };
}

async function renderToVideo(
  element: unknown,
  width: number,
  height: number,
  outBase: string,
  sourceUrl: string,
): Promise<string> {
  const svg = await renderSvg(element, width, height);
  const rect = sentinelRect(svg);
  const png = await rasterize(svg, width, `${outBase}.png`);
  if (!rect) return png;
  return compositeCardVideo(png, sourceUrl, rect, `${outBase}.mp4`);
}

/**
 * Render a card for a tweet, Instagram post, or TikTok depending on the URL.
 * With `video: true`, IG/TikTok video posts return an mp4 with the clip playing
 * inside the card; otherwise a PNG is returned.
 */
export async function saveCard(url: string, opts: { video?: boolean } = {}): Promise<string> {
  if (/tiktok\.com/i.test(url)) return saveTikTokCard(url, opts);
  if (/instagram\.com/i.test(url)) return saveIgCard(url, opts);
  return saveTweetCard(url, opts);
}

/** Fetch a tweet via the syndication API and save a rendered card PNG. */
async function saveTweetCard(url: string, opts: CardOpts = {}): Promise<string> {
  const id = tweetId(url);
  if (!id) throw new Error("That doesn't look like a tweet URL.");

  const data = await getTweet(id);
  if (!data) {
    throw new Error("Couldn't load that tweet. It may be private, removed, or age-restricted.");
  }

  const main = toTweet(data);
  const media = mediaOf(data);
  const quoted = data.quoted_tweet ? toTweet(data.quoted_tweet) : null;
  const quotedMedia = data.quoted_tweet ? mediaOf(data.quoted_tweet) : [];
  const link = media.length === 0 ? linkCardOf(data) : null;

  const [mainAvatar, quotedAvatar, mainUris, quotedUris, linkImg] = await Promise.all([
    fetchImage(main.author.avatar),
    quoted ? fetchImage(quoted.author.avatar) : Promise.resolve(null),
    Promise.all(media.map((m) => fetchImage(m.url))),
    Promise.all(quotedMedia.map((m) => fetchImage(m.url))),
    link?.image ? fetchImage(link.image.url) : Promise.resolve(null),
  ]);
  const linkBuilt = link ? buildLinkCard(link, linkImg) : null;

  const toItems = (ms: Media[], uris: (string | null)[]): MediaItem[] =>
    ms
      .map((m, i) => ({ uri: uris[i], video: m.video, width: m.width, height: m.height }))
      .filter((m): m is MediaItem => Boolean(m.uri));

  const wantVideo = Boolean(opts.video && media.length === 1 && media[0].video);
  const built = toItems(media, mainUris).length
    ? buildMedia(toItems(media, mainUris), INNER, MEDIA_H, MEDIA_MAX_H, 16, wantVideo)
    : null;
  const quotedBuilt = toItems(quotedMedia, quotedUris).length
    ? buildMedia(toItems(quotedMedia, quotedUris), QUOTE_INNER, 220, 360, 12)
    : null;

  const width = 640;
  let height = 32 + 72 + lineCount(main.text, 46) * 40 + 24 + 28 + 24 + 32;
  if (built) height += built.height;
  if (linkBuilt) height += linkBuilt.height;
  if (quoted) height += 32 + 56 + lineCount(quoted.text, 52) * 28 + 16 + (quotedBuilt?.height ?? 0);

  const element = cardElement(
    main,
    mainAvatar,
    built?.node ?? null,
    linkBuilt?.node ?? null,
    quoted,
    quotedAvatar,
    quotedBuilt?.node ?? null,
  );
  const outBase = `tweet ${main.author.handle || id} [${id}]`;
  if (wantVideo) return renderToVideo(element, width, height, outBase, url);
  return renderToFile(element, width, height, `${outBase}.png`);
}

// --- Instagram (gallery-dl, needs IG cookies) ---

type IgPost = {
  username: string;
  fullname: string;
  caption: string;
  likes: number;
  date: string;
  avatar: string | null;
  media: { url: string; video: boolean; width: number; height: number } | null;
};

function findDeep(node: unknown, pred: (o: Record<string, any>) => boolean): Record<string, any> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const r = findDeep(child, pred);
      if (r) return r;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, any>;
    if (pred(o)) return o;
    for (const v of Object.values(o)) {
      const r = findDeep(v, pred);
      if (r) return r;
    }
  }
  return null;
}

async function videoPoster(url: string): Promise<string | null> {
  const tmp = join(tmpdir(), `ping-poster-${Math.floor(Math.random() * 1e9)}.jpg`);
  const proc = Bun.spawn(
    ["ffmpeg", "-y", "-loglevel", "error", "-ss", "0", "-i", url, "-frames:v", "1", "-vf", "scale=720:-1", tmp],
    { stdout: "ignore", stderr: "ignore" },
  );
  if ((await proc.exited) !== 0) return null;
  try {
    const buf = await Bun.file(tmp).arrayBuffer();
    await rm(tmp).catch(() => {});
    return `data:image/jpeg;base64,${Buffer.from(buf).toString("base64")}`;
  } catch {
    return null;
  }
}

async function fetchIgPost(url: string): Promise<IgPost> {
  const cookies = await resolveCookies();
  const proc = Bun.spawn(
    ["gallery-dl", "-j", ...(cookies ? ["--cookies", cookies] : []), url],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, errText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  let data: unknown = null;
  try {
    data = JSON.parse(out);
  } catch {
  }

  const post = Array.isArray(data)
    ? findDeep(data, (o) => typeof o.description === "string" && typeof o.username === "string")
    : null;
  if (!post) {
    const last = errText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1);
    if (last) throw new Error(last.replace(/^\[[^\]]+\]\s*/g, ""));
    throw new Error("Couldn't load that Instagram post. It may be private or need login cookies.");
  }

  const avatar = findDeep(data, (o) => typeof o.profile_pic_url === "string")?.profile_pic_url ?? null;

  let media: IgPost["media"] = null;
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!Array.isArray(item) || item[0] !== 3) continue;
      const m = (item[2] ?? {}) as Record<string, any>;
      const video = Boolean(m.video_url) || m.type === "video" || m.type === "reel";
      media = {
        url: video ? String(m.video_url) : String(item[1]),
        video,
        width: Number(m.width) || 0,
        height: Number(m.height) || 0,
      };
      break;
    }
  }

  return {
    username: String(post.username),
    fullname: normalizeText(post.fullname ?? ""),
    caption: normalizeText(post.description ?? ""),
    likes: Number(post.likes) || 0,
    date: String(post.date ?? "").slice(0, 10),
    avatar,
    media,
  };
}

function captionText(username: string, caption: string) {
  const children: unknown[] = [
    { type: "div", props: { style: { display: "flex", whiteSpace: "pre", fontSize: 18, fontWeight: 700 }, children: `${username} ` } },
  ];
  caption.split("\n").forEach((line, li) => {
    if (li > 0) children.push({ type: "div", props: { style: { display: "flex", width: "100%", height: 0 } } });
    for (const tok of line.match(/\S+\s*/g) ?? []) {
      children.push({
        type: "div",
        props: {
          style: { display: "flex", whiteSpace: "pre", fontSize: 18, lineHeight: 1.35, color: isEntity(tok.trimEnd()) ? ACCENT : undefined },
          children: tok,
        },
      });
    }
  });
  return { type: "div", props: { style: { display: "flex", flexWrap: "wrap", marginTop: 6 }, children } };
}

function igCardElement(post: IgPost, avatarUri: string | null, mediaNode: unknown | null): unknown {
  const header = {
    type: "div",
    props: {
      style: { display: "flex", alignItems: "center", padding: "14px 16px" },
      children: [
        avatarNode(avatarUri, 44),
        {
          type: "div",
          props: {
            style: { display: "flex", flexDirection: "column", marginLeft: 10 },
            children: [
              text(post.username, { fontSize: 20, fontWeight: 700 }),
              post.fullname ? text(post.fullname, { fontSize: 15, color: GRAY }) : null,
            ].filter(Boolean),
          },
        },
      ],
    },
  };

  const footer = {
    type: "div",
    props: {
      style: { display: "flex", flexDirection: "column", padding: "12px 16px" },
      children: [
        text(`${compact(post.likes)} likes`, { fontSize: 18, fontWeight: 700 }),
        post.caption ? captionText(post.username, post.caption) : null,
        text(post.date, { fontSize: 14, color: GRAY, marginTop: 8 }),
      ].filter(Boolean),
    },
  };

  return {
    type: "div",
    props: {
      style: { display: "flex", flexDirection: "column", backgroundColor: "#ffffff", fontFamily: "Sans", color: "#0f1419", width: "100%" },
      children: [header, mediaNode, footer].filter(Boolean),
    },
  };
}

type CardOpts = { video?: boolean; url?: string };

async function compositeCardVideo(
  cardPng: string,
  url: string,
  rect: { x: number; y: number; w: number; h: number },
  outName: string,
): Promise<string> {
  let video: string | undefined;
  try {
    video = (await download({ url, format: "mp4" }))[0];
  } catch {
    video = undefined;
  }
  if (!video) return cardPng;

  const out = join(downloadsDir(), outName);
  const filter =
    `[1:v]scale=${rect.w}:${rect.h}:force_original_aspect_ratio=increase,` +
    `crop=${rect.w}:${rect.h},setsar=1[ov];` +
    `[0:v][ov]overlay=${rect.x}:${rect.y}:shortest=1[v]`;
  const proc = Bun.spawn(
    [
      "ffmpeg", "-y", "-loglevel", "error",
      "-loop", "1", "-i", cardPng,
      "-i", video,
      "-filter_complex", filter,
      "-map", "[v]", "-map", "1:a?",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-movflags", "+faststart", "-shortest",
      out,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  return (await proc.exited) === 0 ? out : cardPng;
}

async function renderPostCard(
  post: IgPost,
  avatarUri: string | null,
  mediaUri: string | null,
  outBase: string,
  opts: CardOpts = {},
): Promise<string> {
  const width = 640;
  const headerH = 72;
  const wantVideo = Boolean(opts.video && opts.url && post.media?.video);
  let mediaH = 0;
  let mediaNode: unknown | null = null;
  if (post.media && (mediaUri || wantVideo)) {
    const nw = post.media.width || 1;
    const nh = post.media.height || 1;
    mediaH = Math.min(800, Math.round((width * nh) / nw));
    mediaNode = wantVideo
      ? imageTile("", width, mediaH, false, 0, true)
      : imageTile(mediaUri as string, width, mediaH, post.media.video, 0);
  }

  const captionLines = post.caption ? lineCount(`${post.username} ${post.caption}`, 40) : 0;
  const height = headerH + mediaH + 12 + 24 + captionLines * 26 + 26 + 12;

  const element = igCardElement(post, avatarUri, mediaNode);
  if (wantVideo) return renderToVideo(element, width, height, outBase, opts.url as string);
  return renderToFile(element, width, height, `${outBase}.png`);
}

async function saveIgCard(url: string, opts: CardOpts = {}): Promise<string> {
  const post = await fetchIgPost(url);
  const [avatarUri, mediaUri] = await Promise.all([
    fetchImage(post.avatar),
    post.media ? (post.media.video ? videoPoster(post.media.url) : fetchImage(post.media.url)) : Promise.resolve(null),
  ]);
  const shortcode = url.match(/\/(?:p|reel|tv)\/([^/?]+)/i)?.[1] ?? "ig";
  return renderPostCard(post, avatarUri, mediaUri, `ig ${post.username} [${shortcode}]`, { ...opts, url });
}

async function tiktokAvatar(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/"avatar(?:Larger|Medium|Thumb)":"([^"]+)"/);
    return m ? m[1].replace(/\\u002F/g, "/").replace(/\\\//g, "/") : null;
  } catch {
    return null;
  }
}

async function fetchTikTok(url: string): Promise<IgPost> {
  const proc = Bun.spawn(["yt-dlp", "-j", "--no-warnings", "--no-playlist", url], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, errText, , avatar] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
    tiktokAvatar(url),
  ]);

  let d: Record<string, any> | null = null;
  try {
    d = JSON.parse(out);
  } catch {
  }
  if (!d || typeof d !== "object") {
    const last = errText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1);
    throw new Error(last ? last.replace(/^ERROR:\s*/, "") : "Couldn't load that TikTok.");
  }

  const ymd = String(d.upload_date ?? "");
  return {
    username: String(d.uploader ?? ""),
    fullname: normalizeText(d.channel ?? d.creator ?? ""),
    caption: normalizeText(d.description ?? d.title ?? ""),
    likes: Number(d.like_count) || 0,
    date: ymd.length === 8 ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : "",
    avatar,
    media: d.thumbnail
      ? { url: String(d.thumbnail), video: true, width: Number(d.width) || 0, height: Number(d.height) || 0 }
      : null,
  };
}

async function saveTikTokCard(url: string, opts: CardOpts = {}): Promise<string> {
  const post = await fetchTikTok(url);
  const [avatarUri, mediaUri] = await Promise.all([
    fetchImage(post.avatar),
    post.media ? fetchImage(post.media.url) : Promise.resolve(null),
  ]);
  const id = url.match(/video\/(\d+)/i)?.[1] ?? "tiktok";
  return renderPostCard(post, avatarUri, mediaUri, `tiktok ${post.username} [${id}]`, { ...opts, url });
}
