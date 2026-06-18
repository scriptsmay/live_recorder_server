# Docker 部署指南

## 快速启动

```bash
cp .env.docker.example .env.docker
docker compose --env-file .env.docker build
docker compose --env-file .env.docker up -d
docker compose --env-file .env.docker logs -f app
```

默认访问地址：`http://127.0.0.1:1123`

健康检查：

```bash
curl http://127.0.0.1:1123/api/health
```

## 服务组成

Docker Compose 会启动 3 个服务：

| 服务       | 说明                                         |
| ---------- | -------------------------------------------- |
| `app`      | Live Recorder Server，直接运行 `node app.js` |
| `postgres` | PostgreSQL 数据库                            |
| `redis`    | Redis 缓存、录制锁和转码队列                 |

容器内不使用 PM2。进程重启由 Docker `restart: unless-stopped` 管理。

如需启用快手轮询，可以叠加 `docker-compose.browserless.yml`，额外启动
Browserless/Chromium 服务供 `KuaishouChecker` 远程打开直播页。

## 配置文件

复制 `.env.docker.example` 为 `.env.docker` 后按需修改：

```env
DATABASE_URL=postgresql://postgres:password@postgres:5432/live_recorder
REDIS_URL=redis://default:password@redis:6379/1
APP_DATA_DIR=/data
VIDEO_DOWNLOAD_DIR=/data/video_downloads
DANMAKU_OUTPUT_DIR=/data/danmaku_output
REPLAY_WORK_DIR=/data/replay
BILIUP_WORK_DIR=/data/biliup
```

推荐在 Docker 环境使用 `DATABASE_URL` 和 `REDIS_URL`。旧的
`DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` 与
`REDIS_HOST` / `REDIS_PORT` / `REDIS_USER` / `REDIS_PASSWORD` /
`REDIS_DB` 仍然可用。

## 持久化目录

| 宿主机路径               | 容器路径                   | 说明                        |
| ------------------------ | -------------------------- | --------------------------- |
| `./data/video_downloads` | `/data/video_downloads`    | 直播录制文件                |
| `./data/danmaku_output`  | `/data/danmaku_output`     | 弹幕压制产物                |
| `./data/replay`          | `/data/replay`             | 回放下载、剪切、修复工作目录 |
| `./data/biliup`          | `/data/biliup`             | biliup 登录态、配置、缓存   |
| `./logs`                 | `/app/logs`                | ffmpeg / biliup 日志        |
| `postgres_data`          | `/var/lib/postgresql/data` | PostgreSQL 数据             |
| `redis_data`             | `/data`                    | Redis AOF 数据              |

NAS 上建议创建独立目录，例如：

```text
/volume1/docker/live_recorder/
├── .env.docker
├── data/
│   ├── biliup/
│   ├── danmaku_output/
│   ├── replay/
│   └── video_downloads/
└── logs/
```

## biliup

镜像内已安装 Python、`uv`，并通过 `uv tool install biliup` 安装
`biliup`。安装后会自动创建软链接到 `/usr/local/bin/biliup`。

如果在容器内找不到 `biliup` 命令，可在 `docker-compose.yml` 中手动指定完整路径：

```env
BILIUP_PATH=/root/.local/share/uv/tools/biliup/bin/biliup
```

默认工作目录为 `/data/biliup`，宿主机对应 `./data/biliup`。建议将
cookie 文件放在：

```text
./data/biliup/cookies.json
```

模板里的 `cookies_path` 可填写容器内路径：

```text
/data/biliup/cookies.json
```

如果需要在容器里执行 biliup 登录或检查命令：

```bash
docker compose --env-file .env.docker exec app sh
biliup --help
```

## 消息通知

通知配置是可选的，未配置时系统会静默跳过对应通道：

```env
MESSAGE_FEISHU_WEBHOOK=
MESSAGE_GOTIFY_SERVER=
MESSAGE_GOTIFY_TOKEN=
MESSAGE_GOTIFY_PRIORITY=5
```

- `MESSAGE_FEISHU_WEBHOOK`：飞书机器人 webhook。
- `MESSAGE_GOTIFY_SERVER`：Gotify 服务地址，例如 `https://gotify.example.com`。
- `MESSAGE_GOTIFY_TOKEN`：Gotify app token。
- `MESSAGE_GOTIFY_PRIORITY`：Gotify 消息优先级，默认 `5`。

`POST /api/notify/feishu_webhook` 仅用于飞书转发；未配置
`MESSAGE_FEISHU_WEBHOOK` 时返回 HTTP 503。

## 快手轮询与 Browserless

快手轮询 Checker 需要真实 Chromium 页面环境。Docker 从零部署时，推荐使用
`docker-compose.browserless.yml` 作为 overlay，把 Browserless 和 app 放在同一个
Compose 网络内：

```bash
cp .env.docker.example .env.docker
# 编辑 .env.docker，至少修改 POSTGRES_PASSWORD、REDIS_PASSWORD、BROWSERLESS_TOKEN
docker compose \
  --env-file .env.docker \
  -f docker-compose.full.yml \
  -f docker-compose.browserless.yml \
  up -d --build
```

overlay 会启动 `browserless` 服务，并把 app 内的
`REMOTE_BROWSER_WS_ENDPOINT` 设置为：

```text
ws://browserless:3000/chromium?token=${BROWSERLESS_TOKEN}
```

这里使用 `/chromium` CDP endpoint，因为服务端代码通过
`playwright-core` 的 `chromium.connectOverCDP()` 连接远程浏览器；不要把它配置成
native Playwright endpoint `/chromium/playwright`。

Browserless 默认不映射宿主机端口，仅供 Compose 网络内的 app 访问。需要从宿主机调试
Browserless 时，可以临时在 `docker-compose.browserless.yml` 中给
`browserless` 增加端口映射：

```yaml
ports:
  - '3000:3000'
```

快手轮询烟测建议在 app 容器内执行，避免宿主机端口映射差异：

```bash
docker compose \
  --env-file .env.docker \
  -f docker-compose.full.yml \
  -f docker-compose.browserless.yml \
  exec app npm run smoke:kuaishou
```

生产环境建议：

- `BROWSERLESS_TOKEN` 使用高强度随机值，不要保留示例默认值
- `BROWSERLESS_CONCURRENT=1`，保持快手检查串行，降低触发风控的概率
- `BROWSERLESS_TIMEOUT_MS=60000` 即可覆盖快手 Checker 内部 45 秒页面超时
- `POLLING_KUAISHOU_COOKIE` 可选，作为快手直播轮询和回放工具箱共享的访问态 cookie
- 只有需要从宿主机直接调试时才暴露 Browserless 端口

## NAS 备份

Docker 部署通常通过 `./data/video_downloads:/data/video_downloads` 持久化直播录制文件，
并通过 `./data/replay:/data/replay` 持久化回放下载、剪切和修复产物，
不一定需要额外 NAS 备份。

如果投稿模板选择了 `after_upload=backup` 或 `backup_and_delete`，但未配置
`NAS_HOST`、`NAS_USER`、`NAS_BACKUP_DIR`，系统会跳过 NAS 备份并在投稿记录中写入
`skipped` 结果。`backup_and_delete` 在 NAS 未配置时不会继续删除本地文件。

如仍需通过 rsync 备份到 NAS，可在 `.env.docker` 中配置：

```env
NAS_HOST=192.168.1.100
NAS_USER=username
NAS_BACKUP_DIR=/volume1/video_backups
```

## 首次部署

1. 准备 `.env.docker`，至少修改数据库和 Redis 密码。
2. 创建宿主机目录：

```bash
mkdir -p data/video_downloads data/danmaku_output data/replay data/biliup logs
```

3. 构建并启动：

```bash
docker compose --env-file .env.docker up -d --build
```

4. 查看启动日志：

```bash
docker compose --env-file .env.docker logs -f app
```

应用启动时会等待 PostgreSQL 和 Redis 可连接，然后自动运行数据库迁移。

## 从 PM2 迁移到 Docker

1. 停止 PM2 服务：

```bash
npm run stop
```

2. 备份现有数据库、Redis 和录制目录。
3. 将录制目录复制或挂载到 `./data/video_downloads`。
4. 将 biliup 的 cookie、配置和缓存复制到 `./data/biliup`。
5. 启动 Docker Compose。
6. 打开 `/api/health`，确认 `db` 与 `redis` 都为 `true`。

## 回滚到 PM2

1. 停止 Docker：

```bash
docker compose --env-file .env.docker down
```

2. 恢复原 `.env`，确认 `VIDEO_DOWNLOAD_DIR` 指向原录制目录。
3. 如 Docker 期间产生新录制文件，将其复制回 PM2 使用的录制目录。
4. 启动 PM2：

```bash
npm run start
```

## 备份与恢复

PostgreSQL 备份：

```bash
docker compose --env-file .env.docker exec postgres \
  pg_dump -U postgres live_recorder > backups/live_recorder.sql
```

PostgreSQL 恢复：

```bash
docker compose --env-file .env.docker exec -T postgres \
  psql -U postgres live_recorder < backups/live_recorder.sql
```

Redis 备份可直接备份 Docker volume，或在维护窗口复制
`redis_data` 对应的数据卷内容。

录制文件和 biliup 状态直接备份宿主机目录：

```bash
tar -czf backups/live_recorder_files.tgz data logs
```
