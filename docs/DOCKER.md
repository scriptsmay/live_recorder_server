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

## 配置文件

复制 `.env.docker.example` 为 `.env.docker` 后按需修改：

```env
DATABASE_URL=postgresql://postgres:password@postgres:5432/live_recorder
REDIS_URL=redis://default:password@redis:6379/1
APP_DATA_DIR=/data
VIDEO_DOWNLOAD_DIR=/data/video_downloads
BILIUP_WORK_DIR=/data/biliup
```

推荐在 Docker 环境使用 `DATABASE_URL` 和 `REDIS_URL`。旧的
`DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` 与
`REDIS_HOST` / `REDIS_PORT` / `REDIS_USER` / `REDIS_PASSWORD` /
`REDIS_DB` 仍然可用。

## 持久化目录

| 宿主机路径               | 容器路径                   | 说明                      |
| ------------------------ | -------------------------- | ------------------------- |
| `./data/video_downloads` | `/data/video_downloads`    | 录制文件                  |
| `./data/biliup`          | `/data/biliup`             | biliup 登录态、配置、缓存 |
| `./logs`                 | `/app/logs`                | ffmpeg / biliup 日志      |
| `postgres_data`          | `/var/lib/postgresql/data` | PostgreSQL 数据           |
| `redis_data`             | `/data`                    | Redis AOF 数据            |

NAS 上建议创建独立目录，例如：

```text
/volume1/docker/live_recorder/
├── .env.docker
├── data/
│   ├── biliup/
│   └── video_downloads/
└── logs/
```

## biliup

镜像内已安装 Python、`uv`，并通过 `uv tool install biliup` 安装
`biliup`。默认不需要设置 `BILIUP_PATH`。

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

## 首次部署

1. 准备 `.env.docker`，至少修改数据库和 Redis 密码。
2. 创建宿主机目录：

```bash
mkdir -p data/video_downloads data/biliup logs
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
