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

# 阶段3：下载并解压 FFmpeg 7.1 静态二进制文件
# 使用 BtbN GitHub Release（GitHub CDN，构建时走内网，稳定可靠）
# 使用 release/tag/latest 下的 n7.1 自动构建资产，避免 master nightly
FROM alpine:latest AS ffmpeg-downloader
RUN apk add --no-cache curl tar xz
RUN curl -fSL https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-linux64-gpl-7.1.tar.xz \
        -o /tmp/ffmpeg.tar.xz \
    && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp \
    && mv /tmp/ffmpeg-n7.1-latest-linux64-gpl-7.1/bin/ffmpeg /usr/local/bin/ \
    && mv /tmp/ffmpeg-n7.1-latest-linux64-gpl-7.1/bin/ffprobe /usr/local/bin/ \
    && rm -rf /tmp/ffmpeg*

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
# fontconfig + fonts-noto-cjk：弹幕压制 libass 渲染 CJK 字幕必需
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl mkvtoolnix python3 python3-pip \
    fontconfig fonts-noto-cjk \
    && fc-cache -fv \
    && pip3 install --break-system-packages --no-cache-dir uv \
    && uv tool install biliup --python /usr/bin/python3 \
    && uv tool install yt-dlp --python /usr/bin/python3 \
    && ln -sf /root/.local/share/uv/tools/biliup/bin/biliup /usr/local/bin/biliup \
    && ln -sf /root/.local/share/uv/tools/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# 从构建阶段复制依赖和源码
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# 复制前端构建产物到 public/frontend/
COPY --from=frontend-builder /app/public/frontend ./public/frontend

# scripts snapshot：用于 entrypoint 启动时刷新共享卷
# 目的：解决 Docker named volume 只在首次创建时从镜像播种、后续镜像更新被
# 屏蔽的问题（v1.8.0 上线踩坑，v1.8.2 修复）。entrypoint 会用此副本刷新
# /app/scripts 挂载点，让 replay_cron 的 ro 挂载能读到最新脚本。
RUN cp -a /app/scripts /app/scripts.image

RUN mkdir -p /data/video_downloads /data/replay /data/biliup /app/logs \
    && chmod +x docker/scripts/docker-entrypoint.sh scripts/replay-cron.sh

EXPOSE 1123

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:1123/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["./docker/scripts/docker-entrypoint.sh"]
CMD ["node", "server/app.js"]
