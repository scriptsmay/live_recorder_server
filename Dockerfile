# 阶段 1: 构建前端
FROM node:22-bookworm-slim AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# 阶段 2: 构建后端依赖
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# 安装必要的构建工具（如果需要编译原生模块）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

# 阶段 3: 运行环境
FROM node:22-bookworm-slim

ENV LANG=C.UTF-8 \
    NODE_ENV=production \
    PORT=1123 \
    APP_DATA_DIR=/data

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl ffmpeg mkvtoolnix python3 python3-pip \
    && pip3 install --break-system-packages --no-cache-dir uv \
    && uv tool install biliup --python /usr/bin/python3 \
    && ln -sf /root/.local/share/uv/tools/biliup/bin/biliup /usr/local/bin/biliup \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# 从构建阶段复制依赖和源码
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# 复制前端构建产物到 public/frontend/
COPY --from=frontend-builder /app/public/frontend ./public/frontend

RUN mkdir -p /data/video_downloads /data/danmaku_output /data/replay /data/biliup /app/logs \
    && chmod +x scripts/docker-entrypoint.sh scripts/replay-cron.sh

EXPOSE 1123

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:1123/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["node", "server/app.js"]
