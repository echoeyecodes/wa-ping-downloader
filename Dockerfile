# Bun runtime for the app; yt-dlp + gallery-dl (Python) and ffmpeg for media.
FROM oven/bun:1

# Installed via pip so the image works on both x86_64 and arm64.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages -U yt-dlp gallery-dl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install JS deps first for layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Created here so the volume mount points exist even before first use.
RUN mkdir -p downloads .wa-auth

# Default process is the WhatsApp bot. Pair with:
#   docker compose run --rm ping bun run src/pair.ts
CMD ["bun", "run", "src/bot.ts"]
