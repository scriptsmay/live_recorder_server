FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=1123 \
    APP_DATA_DIR=/data \
    VIDEO_DOWNLOAD_DIR=/data/video_downloads \
    BILIUP_WORK_DIR=/data/biliup \
    UV_TOOL_BIN_DIR=/usr/local/bin

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    python3 \
    python3-pip \
  && pip3 install --break-system-packages --no-cache-dir uv \
  && uv tool install biliup \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
RUN chmod +x scripts/docker-entrypoint.sh \
  && mkdir -p /data/video_downloads /data/biliup /app/logs

EXPOSE 1123

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 1123) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["node", "app.js"]
