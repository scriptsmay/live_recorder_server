# 阶段 1: 构建前端
FROM node:22-trixie-slim AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# 阶段 2: 构建后端依赖
FROM node:22-trixie-slim AS builder

WORKDIR /app

# 安装必要的构建工具（如果需要编译原生模块）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

# 阶段 3: 提取 FFmpeg 9.0.2 静态二进制文件
# 背景：Debian trixie apt 源的 ffmpeg 锁定在 7.1.5，其官方 flv demuxer 不支持
# 国内直播 CDN（小红书/快手等）广泛使用的非标 FLV HEVC codec tag 0x0c，
# 录制时会报 "Video codec (c) is not implemented" 并丢弃视频轨，产出仅含音频的无画面文件。
# FFmpeg 9.0+ 已在 flv demuxer 中原生支持 0x0c HEVC。
# 采用 mwader/static-ffmpeg:9.0.2 固定版本镜像多阶段注入，既避免 nightly 构建的稳定性风险，
# 又规避 BtbN GitHub Release 轮换删除旧分支资产导致 CI 构建 404 的问题。
FROM mwader/static-ffmpeg:9.0.2 AS ffmpeg-provider

# 阶段 4: 运行环境
FROM node:22-trixie-slim

ENV LANG=C.UTF-8 \
    NODE_ENV=production \
    PORT=1123 \
    APP_DATA_DIR=/data

WORKDIR /app

# 从阶段 3 注入 FFmpeg 9.0.2 静态二进制（无需 apt 安装 ffmpeg）
COPY --from=ffmpeg-provider /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg-provider /ffprobe /usr/local/bin/ffprobe

# mkvtoolnix：视频处理和封装
# biliup 必须固定版本：上游 1.2.10 起只发 sdist 不发 wheel，uv 会退回 maturin 源码构建，
# 而本阶段没有 Rust 工具链，构建直接失败（v1.11.0 CI 实测）。1.2.8 与生产现网一致。
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl mkvtoolnix python3 python3-pip \
    && pip3 install --break-system-packages --no-cache-dir uv \
    && uv tool install biliup==1.2.8 --python /usr/bin/python3 \
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
