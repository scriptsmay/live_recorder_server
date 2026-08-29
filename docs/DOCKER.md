# Docker 部署指南

> **注意**：本文件不包含任何生产环境真实路径、IP 或网络名。生产环境基础设施信息集中在私有知识库文档中维护。

## 编排文件说明（v1.8.2）

采用 **base + override** 组合，统一服务名为 `live_recorder_server`。详见 `docker/README.md`。

| 文件 | 职责 |
|------|------|
| `docker-compose.yml` | base —— 主服务共性配置（环境变量、healthcheck、ports、volumes） |
| `docker-compose.build.yml` | 本地全栈 override —— 覆盖 build 指向 `Dockerfile.local`，追加 postgres + redis |
| `docker-compose.prod.yml` | 生产 override —— `APP_VERSION`（必填）、`EXTERNAL_NETWORK_NAME`（必填）、shared_scripts 卷、deploy.resources |
| `docker-compose.cron.yml` | replay_cron overlay —— 回放定时 + 数据同步 |
| `docker-compose.browserless.yml` | browserless overlay —— 远程 Chromium |

常用组合：

```bash
cd docker

# 本地全栈开发
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build

# 本地 + browserless
docker compose -f docker-compose.yml -f docker-compose.build.yml -f docker-compose.browserless.yml up -d --build

# 生产（APP_VERSION 和 EXTERNAL_NETWORK_NAME 必须在 .env 中填写）
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.cron.yml up -d
```

## 生产部署

生产环境使用外部 PostgreSQL 和 Redis（由面板托管），应用通过上述三文件组合部署。

### 目录结构（通用）

```text
<deploy-root>/
├── .env                        # 环境变量（真实值，gitignore）
├── docker/
│   ├── docker-compose.yml
│   ├── docker-compose.prod.yml
│   ├── docker-compose.cron.yml
│   └── ...
├── data/
│   └── biliup/                 # biliup 登录态
├── logs/
└── scripts/                    # (由 shared_scripts named volume 覆盖)
```

### 更新版本

v1.8.2 只需更换镜像版本号：

```bash
# 修改 .env 中 APP_VERSION=vX.Y.Z
# 然后
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull live_recorder_server
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.cron.yml up -d
```

如果不使用三文件组合（现有单文件部署方案），则按原方式修改 `image:` 行版本号后执行 `pull` + `up -d`。

### shared_scripts 同步（v1.8.2）

v1.8.2 起主容器 entrypoint 会用镜像内 `/app/scripts.image` 刷新 `/app/scripts`（named volume 挂载点）。replay_cron 以 `:ro` 挂载同一 volume。

- 正常升级时 `up -d` 即自动同步
- 若仅改了 scripts 未改主服务代码：需 `up -d --force-recreate live_recorder_server`
- replay_cron 需手动重启：`docker compose restart replay_cron`

### 运行时依赖

主服务镜像基于 `node:22-trixie-slim`，通过 Debian Trixie 软件源安装 FFmpeg。这样避免依赖第三方 Release 的滚动资产文件名；FFmpeg 版本随 Debian 安全更新维护。

### 持久化目录

| `.env` 变量 | 容器路径 | 说明 |
|---|---|---|
| 由 base compose `../data/video_downloads` 或 prod override `${VIDEO_DOWNLOAD_HOST_DIR}` | `/data/video_downloads` | 直播录制文件 |
| 同上 `../data/replay` 或 `${REPLAY_HOST_DIR}` | `/data/replay` | 回放工作目录 |
| `${DANMAKU_ARCHIVE_HOST_DIR}` | `/data/danmaku_archive` | 弹幕归档 |
| `${YTDLP_TEMP_HOST_DIR}` | `/tmp/yt_dlp_cache` | yt-dlp 临时缓存 |
| `./data/biliup` | `/data/biliup` | biliup 登录态 |
| `./logs` | `/app/logs` | 应用日志 |

## 镜像内置组件

| 组件 | 说明 |
|---|---|
| Node.js 22 | 运行时 |
| FFmpeg | 录制、转码（Debian Trixie 软件包） |
| mkvmerge | 视频切片（mkvtoolnix） |
| yt-dlp | 回放下载（通过 uv tool 安装） |
| biliup | B 站投稿（通过 uv tool 安装） |

## .env 配置参考

参考根目录 `.env.example` 了解所有可配置变量。生产必填变量（缺失会导致 compose 直接报错）：

- `APP_VERSION` —— 镜像版本号
- `EXTERNAL_NETWORK_NAME` —— 外部 docker 网络名

其他重要配置项见 `.env.example` 中的分组注释。

## biliup 配置

cookie 文件放在宿主机 `./data/biliup/cookies.json`，投稿模板的 `cookies_path` 填容器内路径 `/data/biliup/cookies.json`。

```bash
docker compose exec live_recorder_server sh
biliup --help
```

## 消息通知

通知通道可选，未配置时静默跳过：

| 环境变量 | 说明 |
|---|---|
| `MESSAGE_FEISHU_WEBHOOK` | 飞书机器人 webhook |
| `MESSAGE_GOTIFY_SERVER` | Gotify 服务地址 |
| `MESSAGE_GOTIFY_TOKEN` | Gotify app token |
| `MESSAGE_GOTIFY_PRIORITY` | Gotify 优先级（默认 5） |

## 登录鉴权

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `AUTH_ENABLED` | 鉴权总开关 | `true` |
| `ADMIN_USERNAME` | 首次启动自动创建管理员用户名 | `admin` |
| `AUTH_TOKEN_TTL_HOURS` | 登录态有效期（小时） | `24` |
| `AUTH_COOKIE_NAME` | Cookie 名称 | `auth_token` |
| `AUTH_COOKIE_SECURE` | 是否 HTTPS only | `false` |
| `LOGIN_RATE_LIMIT` | 每分钟允许登录失败次数 | `5` |
| `LOGIN_LOCKOUT_MIN` | 锁定时长（分钟） | `5` |

## 快手轮询 + 回放工具箱

两者共享配置：

| 变量 | 说明 |
|---|---|
| `REMOTE_BROWSER_WS_ENDPOINT` | 远程 Chromium WebSocket 地址（CDP endpoint，回放 m3u8 提取使用） |
| `POLLING_KUAISHOU_COOKIE` | 快手 cookie |
| `KUAISHOU_CHECKER_ENABLED` | 是否启用快手轮询（默认 true） |
| `KUAISHOU_API_TIMEOUT_MS` | 快手 API 请求超时（默认 15000） |

## 定时任务

定时任务独立在 `docker-compose.cron.yml` 中。

### 回放定时任务

`replay_cron` 通过 curl 调用后端 API，每日自动同步回放列表并入队处理。启用：`.env` 中设置 `REPLAY_CRON_ENABLED=true`。

### 数据同步

`sync-records.sh` 通过 psql 将本地 `replay_records` 表同步到远程数据库。启用：`.env` 中设置 `SYNC_CRON_ENABLED=true`。

`replay_cron` 容器同时监听 Redis `REDIS_PUBLISH_CHANNEL`。后端在回放记录 `duration` 更新时发布事件，监听器解析 `record_id` 执行增量同步。

## 数据库备份

```bash
docker compose exec postgres pg_dump -U postgres live_recorder > backup.sql
# 恢复
docker compose exec -T postgres psql -U postgres live_recorder < backup.sql
```

## 本地开发部署

```bash
cp .env.example .env
# 编辑 .env
cd docker
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

如需 Browserless：

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml -f docker-compose.browserless.yml up -d --build
```
