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
npm run ping "<url>"        # download as mp4
npm run ping "<url>" mp3    # download as mp3
```

Files are saved to `downloads/`. The local file URL is printed at the end.

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
| `GALLERY_DL_COOKIES_B64` | base64 string           | Instagram cookies for gallery-dl (optional).         |
| `WA_AUTH_DIR`            | path                    | Where the WhatsApp session is saved. Default `./.wa-auth`. |

## Instagram cookies

Instagram needs login cookies to download. Export your cookies as `cookies.txt`
(use a browser extension like "Get cookies.txt"), then:

```bash
npm run encode-cookies -- --write
```

This keeps only the Instagram lines and writes `GALLERY_DL_COOKIES_B64` to `.env`.
It never encodes cookies from other sites. Restart the bot after changing it.

## Run with Docker

```bash
docker compose build
docker compose run --rm ping bun run src/pair.ts   # pair once (scan QR)
docker compose up -d                               # start the bot
```

Config comes from `.env`. The `.wa-auth` and `downloads` folders are kept on disk.

## Run the image anywhere

It is a normal Docker image, so you can run it on any host: a VPS, a Raspberry
Pi, your own server, or a platform like Coolify. Build it yourself, or pull it
from a registry.

Replace `<your-github-username>` below with your own (lowercase).

```bash
docker run -d \
  --env-file .env \
  -v "$PWD/.wa-auth:/app/.wa-auth" \
  -v "$PWD/downloads:/app/downloads" \
  ghcr.io/<your-github-username>/ping:latest
```

Keep `.wa-auth` on a volume so you do not re-pair after a restart. Pairing is
interactive, so do it once against the running container:

```bash
docker exec -it <container> bun run src/pair.ts
```

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
