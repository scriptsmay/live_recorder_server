# Docker 部署指南

> **注意**：本文件不包含任何生产环境真实路径、IP 或网络名。生产环境基础设施信息不进入本仓库文档。

## 编排文件说明（v1.8.2）

采用 **base + override** 组合，统一服务名为 `live_recorder_server`。详见 `docker/README.md`。

| 文件                             | 职责                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `docker-compose.yml`             | base —— 主服务共性配置（环境变量、healthcheck、ports、volumes）                                              |
| `docker-compose.build.yml`       | 本地全栈 override —— 覆盖 build 指向 `Dockerfile.local`，追加 postgres + redis                               |
| `docker-compose.prod.yml`        | 生产 override —— `APP_VERSION`（必填）、`EXTERNAL_NETWORK_NAME`（必填）、shared_scripts 卷、deploy.resources |
| `docker-compose.cron.yml`        | replay_cron overlay —— 回放定时 + 数据同步                                                                   |
| `docker-compose.browserless.yml` | browserless overlay —— 远程 Chromium                                                                         |

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

| `.env` 变量                                                                             | 容器路径                | 说明            |
| --------------------------------------------------------------------------------------- | ----------------------- | --------------- |
| 由 base compose `../data/video_downloads` 或 prod override `${VIDEO_DOWNLOAD_HOST_DIR}` | `/data/video_downloads` | 直播录制文件    |
| 同上 `../data/replay` 或 `${REPLAY_HOST_DIR}`                                           | `/data/replay`          | 回放工作目录    |
| `${DANMAKU_ARCHIVE_HOST_DIR}`                                                           | `/data/danmaku_archive` | 弹幕归档        |
| `${YTDLP_TEMP_HOST_DIR}`                                                                | `/tmp/yt_dlp_cache`     | yt-dlp 临时缓存 |
| `./data/biliup`                                                                         | `/data/biliup`          | biliup 登录态   |
| `./logs`                                                                                | `/app/logs`             | 应用日志        |

## 镜像内置组件

| 组件       | 说明                                                                                   |
| ---------- | -------------------------------------------------------------------------------------- |
| Node.js 22 | 运行时                                                                                 |
| FFmpeg     | 录制、转码（Debian Trixie 软件包）                                                     |
| mkvmerge   | 视频切片（mkvtoolnix）                                                                 |
| yt-dlp     | 回放下载（通过 uv tool 安装）                                                          |
| biliup     | B 站投稿（通过 uv tool 安装，固定 `1.2.8`；上游 1.2.10+ 无 wheel，留空会撞 Rust 构建） |

## .env 配置参考

参考根目录 `.env.example` 了解所有可配置变量。生产必填变量（缺失会导致 compose 直接报错）：

- `APP_VERSION` —— 镜像版本号
- `EXTERNAL_NETWORK_NAME` —— 外部 docker 网络名

其他重要配置项见 `.env.example` 中的分组注释。

## biliup 配置

cookie 文件放在宿主机 `./data/biliup/cookies.json`，投稿模板的 `cookies_path` 填容器内路径 `/data/biliup/cookies.json`。

宿主机直跑（`npm start` / `npm run dev`，非容器）时路径策略自动放宽：`cookies_path` 可填开发机上的任意绝对路径（仍拒绝 `..` 穿越与符号链接）。两种模式由 `BILIUP_COOKIE_PATH_MODE` 控制（`auto` 默认按运行环境判定 / `strict` 强制白名单 / `any` 强制放宽），生产容器无需配置。

```bash
docker compose exec live_recorder_server sh
biliup --help
```

## 投稿后自动加入合集（v1.11.0）

投稿成功后由服务端直连 B 站创作中心接口把稿件加入指定合集小节，全部配置可选：

| 环境变量                     | 说明                                                 | 默认值    |
| ---------------------------- | ---------------------------------------------------- | --------- |
| `SEASON_AUTO_ADD_ENABLED`    | 总开关，仅 `false` 关闭                              | `true`    |
| `SEASON_ADD_DELAY_MS`        | 投稿成功后延迟入合集（毫秒），给稿件转码留时间       | `45000`   |
| `SEASON_READY_POLL_MS`       | 稿件就绪轮询间隔（毫秒），轮询在写队列之外并发执行   | `30000`   |
| `SEASON_READY_TIMEOUT_MS`    | 稿件就绪等待上限（毫秒），超时判 `failed` 可手动重试 | `1800000` |
| `SEASON_ADD_MAX_ATTEMPTS`    | 写阶段最多尝试次数（含首次；就绪轮询不计入）         | `3`       |
| `SEASON_ADD_BACKOFF_MS`      | 首次重试退避基数（毫秒，指数递增 30s / 60s / 120s）  | `30000`   |
| `SEASON_WRITE_GAP_MS`        | 同账号连续写入最小间隔（毫秒），避免触发 20111 频控  | `3000`    |
| `SEASON_PENDING_MAX_AGE_MIN` | 重启续跑硬上限（分钟），占位超时未完成则判 `failed`  | `90`      |
| `SEASON_HTTP_TIMEOUT_MS`     | B 站接口超时（毫秒）                                 | `10000`   |
| `SEASON_LIST_CACHE_TTL`      | 合集列表 Redis 缓存 TTL（秒）                        | `600`     |
| `SEASON_SEASONS_PAGE_SIZE`   | 合集列表分页条数                                     | `30`      |

合集与小节的选择存在投稿模板上（`season_id` / `season_title` / `section_id` / `season_auto_add`），未勾选自动加入的模板完全不受该功能影响。

加入流程分两段：先按 `SEASON_READY_POLL_MS` 轮询 B 站 view 接口等稿件可查（`-404` 等瞬态错误继续等，不受写重试次数限制），就绪后才进入同账号写队列，按 `SEASON_ADD_MAX_ATTEMPTS` 与退避策略重试；同一账号相邻写入之间至少间隔 `SEASON_WRITE_GAP_MS`，避免毫秒级连写触发 20111 频控。服务重启时 `resumePending()` 会以非阻塞方式续跑 `pending` 记录，超过 `SEASON_PENDING_MAX_AGE_MIN` 的占位直接判失败。

## 消息通知

通知通道可选，未配置时静默跳过：

| 环境变量                  | 说明                    |
| ------------------------- | ----------------------- |
| `MESSAGE_FEISHU_WEBHOOK`  | 飞书机器人 webhook      |
| `MESSAGE_GOTIFY_SERVER`   | Gotify 服务地址         |
| `MESSAGE_GOTIFY_TOKEN`    | Gotify app token        |
| `MESSAGE_GOTIFY_PRIORITY` | Gotify 优先级（默认 5） |

## 登录鉴权

| 环境变量               | 说明                         | 默认值       |
| ---------------------- | ---------------------------- | ------------ |
| `AUTH_ENABLED`         | 鉴权总开关                   | `true`       |
| `ADMIN_USERNAME`       | 首次启动自动创建管理员用户名 | `admin`      |
| `AUTH_TOKEN_TTL_HOURS` | 登录态有效期（小时）         | `24`         |
| `AUTH_COOKIE_NAME`     | Cookie 名称                  | `auth_token` |
| `AUTH_COOKIE_SECURE`   | 是否 HTTPS only              | `false`      |
| `LOGIN_RATE_LIMIT`     | 每分钟允许登录失败次数       | `5`          |
| `LOGIN_LOCKOUT_MIN`    | 锁定时长（分钟）             | `5`          |

## 快手轮询 + 回放工具箱

两者共享配置：

| 变量                         | 说明                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| `REMOTE_BROWSER_WS_ENDPOINT` | 远程 Chromium WebSocket 地址（CDP endpoint，回放 m3u8 提取使用） |
| `POLLING_KUAISHOU_COOKIE`    | 快手 cookie                                                      |
| `KUAISHOU_CHECKER_ENABLED`   | 是否启用快手轮询（默认 true）                                    |
| `KUAISHOU_API_TIMEOUT_MS`    | 快手 API 请求超时（默认 15000）                                  |

## 服务端原生弹幕采集（v1.10.0）

录制会话期间由服务端直连各平台弹幕服务（虎牙/斗鱼 TCP、B站/抖音 WS），弹幕落盘 `danmaku/{sessionId}.jsonl`，格式与扩展推送路径完全一致。**默认全关**，通过白名单灰度：

| 变量                       | 说明                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `DANMAKU_NATIVE_PLATFORMS` | 逗号分隔平台白名单（`huya,bilibili,douyu,douyin`），留空 = 全关（行为与 v1.9.0 一致）                               |
| `DOUYIN_TTWID`             | 抖音 ttwid cookie；douyin 平台必需，缺省用内置值（有时效风险）。抖音客户端定位为「尽力而为」，签名/凭证随时可能失效 |
| `BILIBILI_DANMAKU_COOKIE`  | B站 cookie（可选）；用于缓解 getDanmuInfo -352 风控                                                                 |

灰度顺序建议：先 `huya` 观察一个完整录制周期，再开 `bilibili,douyu`；`douyin` 默认不开、按需显式加白名单。弹幕采集异常只导致 JSONL 缺失 + 告警日志，绝不影响录制主流程。

## 定时任务

定时任务独立在 `docker-compose.cron.yml` 中。

### 回放定时任务

`replay_cron` 通过 curl 调用后端 API，每日自动同步回放列表并入队处理。启用：`.env` 中设置 `REPLAY_CRON_ENABLED=true`。

### 数据同步

`sync-records.sh` 通过 psql 将本地 `replay_records` 表同步到远程数据库。启用：`.env` 中设置 `SYNC_CRON_ENABLED=true`。

`replay_cron` 容器同时监听 Redis `REDIS_PUBLISH_CHANNEL`。后端在回放记录 `duration` 更新时发布事件，监听器解析 `record_id` 执行增量同步。

### 数据库定时备份

`backup-db.sh` 由同一个 `replay_cron` sidecar 调度（镜像自带 `postgresql17-client`，主应用镜像里没有 `pg_dump`），每日把整库导出为 `pg_dump -Fc` 自定义格式归档，本地落盘。启用：`.env` 中设置 `BACKUP_CRON_ENABLED=true`，并把 `DB_BACKUP_HOST_DIR` 指向宿主机目录。

> 表里的 crontab 表达式按 **北京时间** 判定：sidecar 镜像装了 `tzdata`，`TZ=Asia/Shanghai` 才会生效。缺 `tzdata` 时 busybox crond 会静默忽略 `TZ`、退回 UTC，排期整体偏移 8 小时（`30 2 * * *` 实际在北京时间上午 10:30 触发），且日志与产物文件名的时间戳一并偏成 UTC，从表面上看不出错。该约束由 `test/cron-env-defaults.test.js` 静态锁定。

| 变量                    | 默认值       | 说明                                            |
| ----------------------- | ------------ | ----------------------------------------------- |
| `BACKUP_CRON_ENABLED`   | `false`      | 总开关                                          |
| `BACKUP_CRON_EXPR`      | `30 2 * * *` | crontab 表达式（与回放 03:00、同步 04:00 错峰） |
| `BACKUP_RETENTION_DAYS` | `7`          | 产物保留天数，超期自动清理                      |
| `DB_BACKUP_HOST_DIR`    | `./backups`  | 宿主机产物目录，挂载到容器 `/data/db_backups`   |

导出前会检查磁盘水位（可用空间需 ≥ 库大小的 1.5 倍），产物先写 `.partial` 再通过 `pg_restore --list` 校验、校验通过才 `mv` 成正式档，避免半档被当成可用备份。`.partial` 文件名带进程 PID（`backup_${TS}_$$.dump.partial`），即使将来再出现并发实例，各自的半档也互不覆盖、失败清理只会删掉本进程自己的文件。失败与每周日一次成功心跳都经 `/api/notify/feishu_webhook` 推送，sidecar 本身不持有通知密钥。

> `cron-entrypoint.sh` 每次启动都会先清空再重建 `/tmp/crontab`（`: > "$CRONTAB_FILE"`），保证 cron 行幂等、不会因 `docker restart` 重复追加而出现两条相同的调度行。

> 默认落盘目录与数据库在同一存储池，能应对误删，扛不住整盘损坏。需要异地留存时改 `DB_BACKUP_HOST_DIR` 即可，脚本无需改动。

## 数据库备份

定时备份见上一节；下面是手动跑一次与恢复的流程。

```bash
# 立即执行一次备份（不等排期）
docker exec replay_cron sh /mnt/scripts/backup-db.sh

# 确认调度已注册
docker exec replay_cron crontab -l
```

恢复前先确认归档内容与目标库：

```bash
pg_restore --list backups/backup_YYYYMMDD_HHMMSS.dump   # 先看 TOC，确认可读、条目符合预期
pg_restore -d "$DATABASE_URL" --clean --if-exists -Fc backups/backup_YYYYMMDD_HHMMSS.dump
```

- `-d` 必须传**连接串**（或显式 `-U`）。只写库名时会用当前操作系统用户名当角色，报 `role "xxx" does not exist`。
- `--clean` 会先 DROP 目标库里的同名对象再重建，属于破坏性操作；执行前确认目标库，演练请指向开发库。
- 只想恢复个别表，用 `pg_restore -d "$DATABASE_URL" -t <table> --clean -Fc <dump>`，不要整库覆盖。
- 未演练过恢复的备份等于没有备份：发版后至少做一次「导出 → 在开发库恢复」的闭环。

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
