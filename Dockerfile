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

# 阶段 3: 下载并解压 FFmpeg 7.1 静态二进制文件
# 使用 BtbN GitHub Release（release/7.1 分支自动构建，稳定可靠）
# v1.8.6 曾切到 Debian trixie apt 包（7.1.5-0+deb13u1），生产实测对虎牙 FLV 流
# 出现 "Timestamps are unset" 且 segment 切割点漂移（52 号会话首段 2h35m/9.7GB），
# 阶段 3 已移除：FFmpeg 不再使用 BtbN 静态构建，改回 Debian 官方源 apt 包。
# 历史：v1.8.6 首播（会话 52）出现 Timestamps are unset + segment 切割漂移，
# 当时常怀疑为 apt 包导致而 revert 回 BtbN 静态构建（66b3501）；后续在播流对照
# 实验裁决根因为虎牙流侧时间戳异常，与 FFmpeg 构建源无关。且 BtbN latest 发布
# 只保留最新分支构建、会轮换删除旧资源（v1.10.0 CI 构建即 404），Debian 官方源
# 构建更稳定可复现，故 v1.10.0 起复原 apt ffmpeg（trixie 为 7.1.5）。
# 阶段 4: 运行环境
FROM node:22-trixie-slim

ENV LANG=C.UTF-8 \
    NODE_ENV=production \
    PORT=1123 \
    APP_DATA_DIR=/data

WORKDIR /app

# ffmpeg/mkvtoolnix：视频处理和封装（Debian 官方源，见上方阶段说明）
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates curl mkvtoolnix python3 python3-pip \
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
