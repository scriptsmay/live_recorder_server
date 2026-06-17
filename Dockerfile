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

# 阶段3：下载并解压最新的 FFmpeg 静态二进制文件
FROM alpine:latest AS ffmpeg-downloader
RUN apk add --no-cache curl tar xz
RUN curl -fSL -O https://johnvansickle.com/ffmpeg/builds/ffmpeg-git-amd64-static.tar.xz \
    || (echo "[Dockerfile] johnvansickle 下载失败，尝试 BtbN 镜像..." \
        && curl -fSL -o ffmpeg-git-amd64-static.tar.xz \
           https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz) \
    && tar -xJf ffmpeg-git-amd64-static.tar.xz \
    && mv ffmpeg-git-*-amd64-static/ffmpeg /usr/local/bin/ \
    && mv ffmpeg-git-*-amd64-static/ffprobe /usr/local/bin/

# 阶段 4: 运行环境
FROM node:22-bookworm-slim

ENV LANG=C.UTF-8 \
    NODE_ENV=production \
    PORT=1123 \
    APP_DATA_DIR=/data

WORKDIR /app

# 从阶段 3 复制最新的 ffmpeg 和 ffprobe（直接注入，无需 apt 安装）
COPY --from=ffmpeg-downloader /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg-downloader /usr/local/bin/ffprobe /usr/local/bin/ffprobe

# 这里去掉了 ffmpeg 安装
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl mkvtoolnix python3 python3-pip \
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
    && chmod +x scripts/docker-entrypoint.sh

EXPOSE 1123

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:1123/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["node", "app.js"]
