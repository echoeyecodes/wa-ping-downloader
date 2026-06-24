# Bun runtime for the app; yt-dlp + gallery-dl (Python) and ffmpeg for media.
FROM oven/bun:1

# Installed via pip so the image works on both x86_64 and arm64.
# yt-dlp nightly tracks YouTube changes fastest; gallery-dl stays stable.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages -U --pre "yt-dlp[default]" \
  && pip3 install --no-cache-dir --break-system-packages -U gallery-dl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install JS deps first for layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Created here so the volume mount points exist even before first use.
RUN mkdir -p downloads .wa-auth

# Web link page for (re)linking WhatsApp (enabled when LINK_TOKEN is set).
EXPOSE 3000

# Default process is the WhatsApp bot. When not linked it serves the link page;
# open /link?token=... to scan. No separate pair step needed in production.
CMD ["bun", "run", "src/bot.ts"]
