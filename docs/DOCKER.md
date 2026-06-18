# Docker 部署指南

## 生产环境部署

生产环境使用外部 PostgreSQL 和 Redis（由 1Panel 管理），应用通过 `docker-compose.yml` 单独部署。

### 目录结构

```text
/srv/nas-data/docker2/auto_recorder/
├── .env                        # 环境变量
├── docker-compose.yml
├── data/
│   └── biliup/                 # biliup 登录态
├── logs/
└── scripts/
    └── replay-cron.sh          # 回放定时任务脚本
```

录制文件和回放产物存放在独立目录：

```text
/srv/nas-data/videos/live_records/
├── downloads/                  # 直播录制文件
├── danmaku_output/             # 弹幕压制产物
└── replay/                     # 回放工作目录
```

### docker-compose.yml

```yaml
services:
  live_recorder_server:
    image: ghcr.io/scriptsmay/live_recorder_server:latest
    container_name: live_recorder_server
    environment:
      LANG: C.UTF-8
      LC_ALL: C.UTF-8
      TZ: Asia/Shanghai
      DATABASE_URL: postgresql://user:password@postgresql:5432/live_recorder
      REDIS_URL: redis://default:password@redis:6379/3
      MESSAGE_FEISHU_WEBHOOK: <飞书 webhook>
      MESSAGE_GOTIFY_SERVER: <Gotify 地址>
      MESSAGE_GOTIFY_TOKEN: <Gotify token>
      MESSAGE_GOTIFY_PRIORITY: 6
      REPLAY_WORK_DIR: /data/replay
      # 从 .env 读取
      REMOTE_BROWSER_WS_ENDPOINT: ${REMOTE_BROWSER_WS_ENDPOINT:-}
      KUAISHOU_CHECKER_ENABLED: ${KUAISHOU_CHECKER_ENABLED:-true}
      POLLING_KUAISHOU_COOKIE: ${POLLING_KUAISHOU_COOKIE:-}
      KUAISHOU_CHECKER_ALLOW_FIRST_SCREEN_RESOURCES: ${KUAISHOU_CHECKER_ALLOW_FIRST_SCREEN_RESOURCES:-true}
    ports:
      - '11123:1123'
    volumes:
      - /srv/nas-data/videos/live_records/downloads:/data/video_downloads
      - /srv/nas-data/videos/live_records/danmaku_output:/data/danmaku_output
      - /srv/nas-data/videos/live_records/replay:/data/replay
      - ./data/biliup:/data/biliup
      - ./logs:/app/logs
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 2048M
          cpus: '2.0'
    networks:
      - external-network
    healthcheck:
      test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:' + (process.env.PORT || 1123) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 30s
      retries: 3

  replay_cron:
    image: alpine:3.20
    container_name: replay_cron
    environment:
      TZ: Asia/Shanghai
      API_BASE: http://live_recorder_server:1123
      REPLAY_CRON_EXPR: ${REPLAY_CRON_EXPR:-0 3 * * *}
      REPLAY_CRON_ENABLED: ${REPLAY_CRON_ENABLED:-false}
      REPLAY_PRINCIPAL_ID: ${REPLAY_PRINCIPAL_ID:-}
      REPLAY_CRON_COUNT: ${REPLAY_CRON_COUNT:-1}
    volumes:
      - ./scripts/replay-cron.sh:/replay-cron.sh:ro
    entrypoint: /bin/sh
    command:
      - -c
      - |
        if [ "$$REPLAY_CRON_ENABLED" != "true" ]; then
          echo "[replay-cron] 已禁用，退出"
          exit 0
        fi
        echo "[replay-cron] 启用，表达式: $$REPLAY_CRON_EXPR"
        echo "$$REPLAY_CRON_EXPR /replay-cron.sh >> /proc/1/fd/1 2>&1" | crontab -
        crond -f -l 2
    restart: unless-stopped
    depends_on:
      - live_recorder_server

networks:
  external-network:
    external: true
```

### .env 配置

```env
# 快手轮询 + 回放 m3u8 提取
REMOTE_BROWSER_WS_ENDPOINT=ws://192.168.0.247:11300/chromium?--user-data-dir=data/user-profiles/kuaishou
POLLING_KUAISHOU_COOKIE=<快手 cookie>
KUAISHOU_CHECKER_ENABLED=true
KUAISHOU_CHECKER_ALLOW_FIRST_SCREEN_RESOURCES=true

# 回放定时任务（默认关闭）
REPLAY_CRON_ENABLED=false
REPLAY_CRON_EXPR=0 3 * * *
REPLAY_PRINCIPAL_ID=
REPLAY_CRON_COUNT=1
```

### 持久化目录

| 宿主机路径                                 | 容器路径                   | 说明             |
| ------------------------------------------ | -------------------------- | ---------------- |
| `/srv/nas-data/videos/live_records/downloads` | `/data/video_downloads`    | 直播录制文件     |
| `/srv/nas-data/videos/live_records/danmaku_output` | `/data/danmaku_output`  | 弹幕压制产物     |
| `/srv/nas-data/videos/live_records/replay`    | `/data/replay`             | 回放工作目录     |
| `./data/biliup`                            | `/data/biliup`             | biliup 登录态    |
| `./logs`                                   | `/app/logs`                | 应用日志         |

## 部署步骤

首次部署：

```bash
mkdir -p /srv/nas-data/docker2/auto_recorder/{data/biliup,logs,scripts}
cd /srv/nas-data/docker2/auto_recorder
# 创建 .env 和 docker-compose.yml（见上方模板）
# 复制 replay-cron.sh 到 scripts/ 目录
docker compose pull
docker compose up -d
```

更新版本：

```bash
cd /srv/nas-data/docker2/auto_recorder
docker compose pull
docker compose up -d
```

查看日志：

```bash
docker compose logs -f live_recorder_server
```

## 镜像内置组件

镜像已包含以下依赖，无需额外安装：

| 组件        | 说明                                              |
| ----------- | ------------------------------------------------- |
| Node.js 22  | 运行时                                            |
| FFmpeg      | 录制、转码、弹幕压制                              |
| mkvmerge    | 视频切片（mkvtoolnix）                            |
| yt-dlp      | 回放下载                                          |
| biliup      | B 站投稿（通过 uv tool 安装）                     |
| playwright  | 回放 m3u8 提取兜底方案（需配置远程浏览器）        |

## biliup 配置

cookie 文件放在宿主机 `./data/biliup/cookies.json`，投稿模板的 `cookies_path` 填容器内路径 `/data/biliup/cookies.json`。

进入容器执行 biliup 命令：

```bash
docker compose exec live_recorder_server sh
biliup --help
```

## 消息通知

通知通道可选，未配置时静默跳过：

| 环境变量                 | 说明                   |
| ------------------------ | ---------------------- |
| `MESSAGE_FEISHU_WEBHOOK` | 飞书机器人 webhook     |
| `MESSAGE_GOTIFY_SERVER`  | Gotify 服务地址        |
| `MESSAGE_GOTIFY_TOKEN`   | Gotify app token       |
| `MESSAGE_GOTIFY_PRIORITY` | Gotify 优先级（默认 5）|

## 快手轮询 + 回放工具箱

两者共享以下配置：

| 配置项                       | 说明                                                 |
| ---------------------------- | ---------------------------------------------------- |
| `REMOTE_BROWSER_WS_ENDPOINT` | 远程 Chromium WebSocket 地址（轮询 + m3u8 提取兜底） |
| `POLLING_KUAISHOU_COOKIE`    | 快手 cookie（轮询 + 回放共享）                       |

地址格式：`ws://<host>:<port>/chromium`（CDP endpoint，不是 `/chromium/playwright`）。

## 回放定时任务

`replay_cron` 服务通过 curl 调用后端 API，每日自动同步回放列表并入队处理。

启用：在 `.env` 中设置 `REPLAY_CRON_ENABLED=true`，填写 `REPLAY_PRINCIPAL_ID`（快手主播 ID）。

## 数据库备份

PostgreSQL 备份：

```bash
docker compose exec postgres pg_dump -U postgres live_recorder > backup.sql
```

恢复：

```bash
docker compose exec -T postgres psql -U postgres live_recorder < backup.sql
```

## 本地开发部署

本地开发使用 `docker-compose.full.yml`，包含 PostgreSQL 和 Redis 容器：

```bash
cp .env.example .env
docker compose -f docker-compose.full.yml up -d
```

如需 Browserless（快手轮询 + m3u8 提取），叠加 overlay：

```bash
docker compose \
  -f docker-compose.full.yml \
  -f docker-compose.browserless.yml \
  up -d --build
```
