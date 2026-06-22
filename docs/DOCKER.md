# Docker 部署指南

## 生产环境部署

生产环境使用外部 PostgreSQL 和 Redis（由 1Panel 管理），应用通过 `docker/docker-compose.yml` 单独部署。定时任务（回放 + 数据同步）独立在 `docker/docker-compose.cron.yml` 中，按需启用。

### 目录结构

```text
/srv/nas-data/docker2/auto_recorder/
├── .env                        # 环境变量
├── docker/
│   ├── docker-compose.yml          # 主服务
│   ├── docker-compose.cron.yml     # 定时任务（可选）
│   ├── docker-compose.full.yml     # 本地开发全栈
│   ├── docker-compose.browserless.yml
│   └── .env.docker.example
├── data/
│   └── biliup/                 # biliup 登录态
├── logs/
└── scripts/
    ├── replay-cron.sh          # 回放定时任务脚本
    └── sync-records.sh         # 数据同步脚本
```

录制文件和回放产物存放在独立目录：

```text
/srv/nas-data/videos/live_records/
├── downloads/                  # 直播录制文件
├── danmaku_output/             # 弹幕压制产物
└── replay/                     # 回放工作目录
```

### 部署步骤

首次部署：

```bash
mkdir -p /srv/nas-data/docker2/auto_recorder/{data/biliup,logs,scripts}
cd /srv/nas-data/docker2/auto_recorder
# 从仓库复制 docker/ 目录和 scripts/ 目录
# 创建 .env（参考 docker/.env.docker.example）
cd docker
docker compose pull
docker compose up -d
```

如需启用定时任务（回放 + 数据同步）：

```bash
cd /srv/nas-data/docker2/auto_recorder/docker
docker compose -f docker-compose.yml -f docker-compose.cron.yml up -d
```

如果定时任务服务与主服务分开部署，需要让 cron 容器加入包含
`live_recorder_server`、`postgresql`、`redis` 的 Docker 网络。生产 NAS 使用：

```env
COMPOSE_NETWORK_NAME=external-network
```

`replay_cron` 使用 `postgres:17.5-alpine` 以便 `sync-records.sh` 调用
`psql`，启动时会安装 `curl` 供 `replay-cron.sh` 调用后端 API 和通知转发接口。
两个 cron 脚本都会通过 `/api/notify/feishu_webhook` 发送执行结果通知；
`replay-cron.sh` 通知回放同步与入队统计，`sync-records.sh` 通知本地导出、
远端暂存导入和 upsert 写入数量。
Supabase 同步不会删除远端记录；当远端 `kuaishou` 记录数大于本地
`replay_records` 时会默认停止同步，避免本地源数据异常时继续覆盖远端。
如确认允许源数据减少，可显式设置 `SYNC_ALLOW_SOURCE_SHRINK=true`。

### 运行时依赖

主服务镜像使用 Debian bookworm 仓库提供的 `ffmpeg` / `ffprobe`。
不要在镜像中注入 nightly 静态 FFmpeg 构建；生产环境曾出现静态构建在
快手 FLV 直播流输入上启动即 `SIGSEGV`，导致轮询创建录制会话后无有效文件。

更新版本：

```bash
cd /srv/nas-data/docker2/auto_recorder/docker
docker compose pull
docker compose up -d
```

查看日志：

```bash
cd /srv/nas-data/docker2/auto_recorder/docker
docker compose logs -f live_recorder_server
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

# 数据同步（默认关闭，测试阶段写入 test_records）
SYNC_CRON_ENABLED=false
SYNC_CRON_EXPR=0 4 * * *
SUPABASE_URL=
REMOTE_TABLE=test_records

# cron 调用后端 API 的内部密钥（主服务和 replay_cron 必须一致）
CRON_API_TOKEN=<生成一个随机长字符串>
```

### 持久化目录

| 宿主机路径                                      | 容器路径                | 说明          |
| ----------------------------------------------- | ----------------------- | ------------- |
| `/srv/nas-data/videos/live_records/downloads`      | `/data/video_downloads` | 直播录制文件  |
| `/srv/nas-data/videos/live_records/danmaku_output` | `/data/danmaku_output`  | 弹幕压制产物  |
| `/srv/nas-data/videos/live_records/replay`         | `/data/replay`          | 回放工作目录  |
| `./data/biliup`                                 | `/data/biliup`          | biliup 登录态 |
| `./logs`                                        | `/app/logs`             | 应用日志      |

## 镜像内置组件

镜像已包含以下依赖，无需额外安装：

| 组件       | 说明                                       |
| ---------- | ------------------------------------------ |
| Node.js 22 | 运行时                                     |
| FFmpeg     | 录制、转码、弹幕压制（BtbN n7.1 静态构建） |
| mkvmerge   | 视频切片（mkvtoolnix）                     |
| yt-dlp     | 回放下载（通过 uv tool 安装）              |
| biliup     | B 站投稿（通过 uv tool 安装）              |
| playwright | 回放 m3u8 提取兜底方案（需配置远程浏览器） |

## biliup 配置

cookie 文件放在宿主机 `./data/biliup/cookies.json`，投稿模板的 `cookies_path` 填容器内路径 `/data/biliup/cookies.json`。

进入容器执行 biliup 命令：

```bash
docker compose exec live_recorder_server sh
biliup --help
```

## 消息通知

通知通道可选，未配置时静默跳过：

| 环境变量                  | 说明                    |
| ------------------------- | ----------------------- |
| `MESSAGE_FEISHU_WEBHOOK`  | 飞书机器人 webhook      |
| `MESSAGE_GOTIFY_SERVER`   | Gotify 服务地址         |
| `MESSAGE_GOTIFY_TOKEN`    | Gotify app token        |
| `MESSAGE_GOTIFY_PRIORITY` | Gotify 优先级（默认 5） |

## 登录鉴权

| 环境变量               | 说明                                                               | 默认值       |
| ---------------------- | ------------------------------------------------------------------ | ------------ |
| `AUTH_ENABLED`         | 登录鉴权总开关；生产环境建议保持开启                               | `true`       |
| `ADMIN_USERNAME`       | 首次启动自动创建管理员时使用的用户名                               | `admin`      |
| `AUTH_TOKEN_TTL_HOURS` | 登录态有效期，单位小时                                             | `24`         |
| `AUTH_COOKIE_NAME`     | 登录态 Cookie 名称                                                 | `auth_token` |
| `AUTH_COOKIE_SECURE`   | 是否只允许 HTTPS 写入 Cookie；内网 HTTP 部署保持 `false`           | `false`      |
| `LOGIN_RATE_LIMIT`     | 同一 IP 每分钟允许的登录失败次数                                   | `5`          |
| `LOGIN_LOCKOUT_MIN`    | 达到失败次数上限后的锁定时长，单位分钟；锁定期间登录接口会直接拒绝 | `5`          |

## 快手轮询 + 回放工具箱

两者共享以下配置：

| 配置项                       | 说明                                                 |
| ---------------------------- | ---------------------------------------------------- |
| `REMOTE_BROWSER_WS_ENDPOINT` | 远程 Chromium WebSocket 地址（轮询 + m3u8 提取兜底） |
| `POLLING_KUAISHOU_COOKIE`    | 快手 cookie（轮询 + 回放共享）                       |

地址格式：`ws://<host>:<port>/chromium`（CDP endpoint，不是 `/chromium/playwright`）。

## 定时任务

定时任务独立在 `docker/docker-compose.cron.yml` 中，包含两个 cron 服务：

### 回放定时任务

`replay_cron` 通过 curl 调用后端 API，每日自动同步回放列表并入队处理。

启用：在 `.env` 中设置 `REPLAY_CRON_ENABLED=true`，填写 `REPLAY_PRINCIPAL_ID`（快手主播 ID）。

### 数据同步

`sync-records.sh` 通过 psql 将本地 `replay_records` 表同步到远程 Supabase 数据库。

启用：在 `.env` 中设置 `SYNC_CRON_ENABLED=true`，填写 `SUPABASE_URL`。测试阶段默认写入 `test_records` 表，上线时改 `REMOTE_TABLE=records`。

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

本地开发使用 `docker/docker-compose.full.yml`，包含 PostgreSQL 和 Redis 容器：

```bash
cp docker/.env.docker.example .env
# 编辑 .env 配置
cd docker
docker compose -f docker-compose.full.yml up -d
```

如需 Browserless（快手轮询 + m3u8 提取），叠加 overlay：

```bash
cd docker
docker compose \
  -f docker-compose.full.yml \
  -f docker-compose.browserless.yml \
  up -d --build
```
