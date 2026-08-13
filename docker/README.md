# Docker 编排说明

采用 **base + override** 组合，统一服务名为 `live_recorder_server`。base 只放共性，差异全走 override。

## 文件职责

- `docker-compose.yml`（base）— 主服务共性：环境变量、healthcheck、ports、通用 volumes。镜像走 `${APP_IMAGE:-ghcr.io/scriptsmay/live_recorder_server:latest}`
- `docker-compose.build.yml` — 本地全栈 override：覆盖 `build:` 指向 `Dockerfile.local`，追加 postgres 16 + redis 7 及其数据卷
- `docker-compose.prod.yml` — 生产 override：写死版本号（`APP_VERSION` 必填）、`shared_scripts` 命名卷、外部网络（`EXTERNAL_NETWORK_NAME` 必填）、`deploy.resources` 限制、`DANMAKU_ARCHIVE_DIR` 等。**本文件已脱敏，所有生产真实路径 / 网络名走 `.env` 注入**
- `docker-compose.cron.yml` — replay_cron overlay（回放定时 + 数据同步）
- `docker-compose.browserless.yml` — browserless overlay（快手轮询 / 回放 m3u8 提取用远程浏览器）

## 常用组合

```bash
cd docker

# 本地全栈开发（构建本地镜像 + postgres + redis）
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build

# 本地全栈 + browserless
docker compose -f docker-compose.yml -f docker-compose.build.yml -f docker-compose.browserless.yml up -d --build

# 本地全栈 + cron
docker compose -f docker-compose.yml -f docker-compose.build.yml -f docker-compose.cron.yml up -d --build

# 生产（APP_VERSION 必填，写死发布版本号）
APP_VERSION=v1.8.2 docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.cron.yml up -d
```

## Dockerfile

- `../Dockerfile` — 生产镜像（4 阶段：前端构建 → 后端依赖 → BtbN n7.1 静态 ffmpeg → 运行环境，含 yt-dlp / CJK 字体）。**唯一用于生产的镜像**
- `Dockerfile.local` — 本地加速构建（阿里云源、apt 版 ffmpeg、无前端产物、无 yt-dlp）。**不等价于生产镜像**，仅供本地开发
- `Dockerfile.replay-cron` — replay_cron 专用轻量 Alpine（curl / redis-cli / psql），**不含 scripts**，完全依赖挂载

## shared_scripts 同步机制（v1.8.2）

Docker named volume 只在首次创建时从镜像播种，之后镜像更新会被屏蔽。为让 `replay_cron` 的只读挂载读到最新脚本：

1. 生产 `Dockerfile` build 时执行 `cp -a /app/scripts /app/scripts.image` 留一份镜像内快照
2. 主容器 `docker-entrypoint.sh` 启动时用该快照刷新 `/app/scripts`（即 `shared_scripts` 挂载点）
3. `replay_cron` 以 `:ro` 挂载同一卷，重启即读到新脚本

**注意**：若某次发布仅改了 `scripts/` 而未改主服务代码，需显式 `docker compose ... up -d --force-recreate live_recorder_server` 触发同步，再重启 `replay_cron`。回滚到 v1.8.1 及更早镜像时无此同步逻辑，卷内仍是新版脚本 —— 发布记录需显式标注。
