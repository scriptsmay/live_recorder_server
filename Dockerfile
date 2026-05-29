# 阶段 1: 构建依赖
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# 安装必要的构建工具（如果需要编译原生模块）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

# 阶段 2: 运行环境
FROM node:22-bookworm-slim

ENV LANG=C.UTF-8 \
    NODE_ENV=production \
    PORT=1123 \
    APP_DATA_DIR=/data

WORKDIR /app

# [修改] 在 apt-get install 中增加了 gosu
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl ffmpeg python3 python3-pip gosu \
    && pip3 install --break-system-packages --no-cache-dir uv \
    && uv tool install biliup --python /usr/bin/python3 \
    && ln -sf /root/.local/share/uv/bin/biliup /usr/local/bin/biliup \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# 从构建阶段复制依赖和源码
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# 设置非 root 用户
RUN groupadd -r nodeuser && useradd -r -m -g nodeuser nodeuser \
    && mkdir -p /data/video_downloads /data/biliup /app/logs \
    && chown -R nodeuser:nodeuser /data /app /home/nodeuser

# ⚠️ [重要修改] 注释掉这里的 USER 限制，允许 entrypoint 以 root 身份启动来修正权限
# USER nodeuser

RUN chmod +x scripts/docker-entrypoint.sh

EXPOSE 1123

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:1123/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["node", "app.js"]