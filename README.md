# ping

ping turns a link into a downloaded file. Send it a URL and it saves the video,
audio, or photos behind that link.

There are two ways to use it:

- **Command line** — run `npm run ping "<url>"` on your machine.
- **WhatsApp bot** — pair your WhatsApp account once, then send a link in any
  chat. The bot downloads it and sends the file straight back into the chat.
  This is the main use: a personal downloader you control from your phone.

Works with YouTube, TikTok, Instagram, Twitter/X, and most sites yt-dlp supports.

### What it does

- Saves videos as `mp4` (default), or `mp3` if you ask for audio.
- Handles photo and carousel posts (mixed photos and clips). Photos are saved
  as-is; videos in the post follow the format you asked for.
- Sends a WhatsApp post's media back as one album instead of one file at a time.
- Rejects playlists, so one link gives you one post, not a hundred.
- Shows a typing indicator while it works, instead of spamming the chat.

### How it works

It uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) to grab videos and audio. If a
link has no video (a photo post), it falls back to
[gallery-dl](https://github.com/mikf/gallery-dl) to get the images. `ffmpeg`
handles converting and merging. The WhatsApp side uses
[Baileys](https://github.com/WhiskeySockets/Baileys).

You decide who the bot listens to (just you, anyone who messages you, group
chats when tagged) through a small config file. See [Config](#config).

## Requirements

Install these first:

- [Bun](https://bun.sh)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [gallery-dl](https://github.com/mikf/gallery-dl)
- [ffmpeg](https://ffmpeg.org)

Then install JS deps:

```bash
bun install
```

## Command line

```bash
npm run ping "<url>"            # download as mp4
npm run ping "<url>" mp3        # download as mp3
npm run ping "<tweet-url>" card # render a tweet as an image card
npm run ping "<ig-url>" card    # render an Instagram post as a card
```

Files are saved to `downloads/`. The local file URL is printed at the end.

The `card` mode renders a post into a PNG that looks like the real thing:

- **Tweets** — text, media, quotes, and link previews. Uses X's public
  syndication API, so no login is needed.
- **Instagram** — avatar, the photo/video, likes, and caption. Uses gallery-dl,
  so it needs your Instagram cookies (see Cookies below).

## WhatsApp bot

1. Pair your phone (scan the QR once):

   ```bash
   npm run pair
   ```

2. Start the bot:

   ```bash
   npm run bot
   ```

3. Send a link in a chat. The bot downloads it and sends the file back.
   Add `mp3` in the message to get audio.
   Send a tweet or Instagram link with the word `card` to get a rendered image back.

The session is saved in `.wa-auth/`, so you only pair once.

## Config

Copy the sample and edit it. Bun loads `.env` automatically.

```bash
cp .env.sample .env
```

| Variable                 | Values                  | Meaning                                              |
| ------------------------ | ----------------------- | ---------------------------------------------------- |
| `PING_DMS`               | `anyone`, `self`, `off` | Who can trigger downloads in direct chats.           |
| `PING_GROUPS`            | `mention`, `all`, `off` | Group behavior. `mention` = only when you are tagged.|
| `GALLERY_DL_COOKIES_B64` | base64 string           | Login cookies for YouTube (server bot checks) and Instagram (optional). |
| `WA_AUTH_DIR`            | path                    | Where the WhatsApp session is saved. Default `./.wa-auth`. |
| `LINK_TOKEN`             | secret string           | If set, serves the link page at `/link?token=...`. If empty, the QR prints to the terminal instead. |
| `PORT`                   | number                  | Port for the link page. Default `3000`.              |

## Cookies (Instagram, and YouTube on a server)

Some downloads need login cookies:

- **Instagram** posts/reels need them to download at all.
- **YouTube** rejects datacenter IPs with "Sign in to confirm you're not a bot".
  On a server, pass cookies so yt-dlp can authenticate. (Local/home IPs usually
  work without cookies.)

Export your cookies as `cookies.txt` (a browser extension like "Get cookies.txt"),
then:

```bash
npm run encode-cookies -- --write
```

This keeps only `instagram.com` and `youtube.com` lines and writes
`GALLERY_DL_COOKIES_B64` to `.env` — your other sites' sessions are never encoded.
Restart the bot after changing it.

Use a THROWAWAY Google account for the YouTube cookies: cookies used from a server
IP can get the account flagged or banned.

## Run with Docker

It is a normal Docker image — run it on any host (a VPS, a Raspberry Pi, your own
server, a platform like Coolify). Build it locally, or pull a published image
(replace `<your-github-username>` with yours, lowercase).

```bash
# build locally
docker build -t ping .
# or: docker pull ghcr.io/<your-github-username>/ping:latest

docker run -d --name ping \
  --env-file .env \
  -v "$PWD/.wa-auth:/app/.wa-auth" \
  -v "$PWD/downloads:/app/downloads" \
  ping
```

Keep `.wa-auth` on a volume so you do not re-pair after a restart. Pairing is
interactive, so do it once against the running container:

```bash
docker exec -it ping bun run src/pair.ts
```

Config comes from `.env`; `.wa-auth` and `downloads` are kept on disk.

## Auto deploy with GitHub Actions

On push to `main`, the workflow builds the image, pushes it to
`ghcr.io/<your-github-username>/ping` (it uses your repo owner automatically, so
there is nothing to edit), then triggers a redeploy. It uses Coolify as the
example target, but that step is optional — replace it with your host's own
pull-and-restart command, or remove it.

For the Coolify step, set these secrets in GitHub (repo Settings, Environments,
`production`):

- `COOLIFY_BASE_URL` — your Coolify dashboard URL (e.g. `http://1.2.3.4:8000`), no `/api`.
- `COOLIFY_API_TOKEN` — a Coolify API token.
- `COOLIFY_PING_UUID` — the UUID of the ping app in Coolify.

In Coolify:

- Set the app source to the Docker image `ghcr.io/<your-github-username>/ping:latest`.
- Add a GHCR registry credential so Coolify can pull the image.
- Set `PING_DMS`, `PING_GROUPS`, `GALLERY_DL_COOKIES_B64` as runtime env vars
  (not build variables).
- Add persistent storage at `/app/.wa-auth` and `/app/downloads`.

## It asks me to re-pair on every deploy

The WhatsApp session lives in `.wa-auth`. A redeploy starts a fresh container, so
if that folder is not on a persistent volume, the session is gone and you must
pair again.

Fix it:

- Make sure `/app/.wa-auth` is mounted to a persistent volume (Coolify: Persistent
  Storage; `docker run`: `-v ...:/app/.wa-auth`).
- On startup the app prints `Session will be saved to: <path>`. Check that path is
  the mounted one.
- To confirm it persisted, exec into the running container and run
  `ls /app/.wa-auth` — after pairing it should contain `creds.json` and more.

You can also set `WA_AUTH_DIR` to a path on a volume you already mount (for
example `WA_AUTH_DIR=/data/wa-auth`).

## Relinking without a terminal

WhatsApp sometimes unlinks a device (you log out elsewhere, it sits idle, etc).
The bot handles this without a shell:

- Set `LINK_TOKEN` to a strong secret to serve a protected page on `PORT`
  (default `3000`) at `/link?token=YOUR_TOKEN`. In a deploy platform, give the app
  a domain. Without `LINK_TOKEN` no page is served and the QR prints to the logs.
- When the bot is not linked, open the page. It shows a QR to scan. The page
  refreshes on its own and switches to "Linked" once done.
- If WhatsApp unlinks the device while running, the bot clears the dead session
  and goes back to the link page automatically — just open it and scan again. No
  redeploy, no `docker exec`.

The QR lets someone link your account, so keep `LINK_TOKEN` secret and only open
the URL yourself.
