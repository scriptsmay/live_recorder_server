# API 文档

## 基础信息

- 基础地址：`http://<host>:<port>/api`
- 默认端口：`1123`
- 请求格式：`application/json`
- 直播间地址 `room_url` 作为稳定标识使用，服务端会在查询或创建前移除分享跟踪 query string 和 fragment，避免同一地址被识别为新直播间。平台用于识别直播间的参数（如抖音 `web_rid`）会保留。

---

## 健康检查

### GET /api/health

检查应用、PostgreSQL、Redis 是否可用，并返回当前版本。

**响应示例：**

```json
{
  "ok": true,
  "app": true,
  "db": true,
  "redis": true,
  "version": "1.1.0"
}
```

当数据库或 Redis 不可用时返回 HTTP 503，`ok` 为 `false`。

**示例：**

```bash
curl http://127.0.0.1:1123/api/health
```

---

## 登录鉴权

登录鉴权使用单管理员账号和 HttpOnly Cookie session。相关环境变量：

| 环境变量               | 说明                                                               | 默认值       |
| ---------------------- | ------------------------------------------------------------------ | ------------ |
| `AUTH_ENABLED`         | 登录鉴权总开关；设为 `false` 时业务路由免登录                      | `true`       |
| `ADMIN_USERNAME`       | 首次启动自动创建管理员时使用的用户名                               | `admin`      |
| `AUTH_TOKEN_TTL_HOURS` | 登录态有效期，单位小时                                             | `24`         |
| `AUTH_COOKIE_NAME`     | 登录态 Cookie 名称                                                 | `auth_token` |
| `AUTH_COOKIE_SECURE`   | 是否只允许 HTTPS 写入 Cookie                                       | `false`      |
| `LOGIN_RATE_LIMIT`     | 同一 IP 每分钟允许的登录失败次数                                   | `5`          |
| `LOGIN_LOCKOUT_MIN`    | 达到失败次数上限后的锁定时长，单位分钟；锁定期间登录接口会直接拒绝 | `5`          |

### POST /api/auth/login

使用用户名和密码登录。成功后返回当前用户名，并写入 `HttpOnly` Cookie。

**请求体：**

```json
{
  "username": "admin",
  "password": "******"
}
```

### POST /api/auth/logout

退出登录并清理服务端 session。

### GET /api/auth/me

获取当前登录用户信息。

**响应示例：**

```json
{
  "status": "ok",
  "data": {
    "username": "admin"
  }
}
```

### 限流

- 同 IP 5 次失败 / 分钟
- 超过后返回 `429`

## 匿名访问说明

- `/api/health` 仍可匿名访问
- `/hls/*` 仍可匿名播放

---

## 仪表盘

### GET /api/dashboard/status

获取 Dashboard 运维概览数据。接口聚合活跃录制、转码队列、弹幕采集、轮询快照、今日摘要和近期活动，前端 Dashboard 只需调用此接口。

**响应示例：**

```json
{
  "status": "ok",
  "data": {
    "active_recordings": [
      {
        "room_url": "https://www.huya.com/123",
        "room_name": "主播名",
        "pid": 12345,
        "session_id": 51,
        "started_at": "2026-06-10T12:00:00.000Z",
        "downloader": "ffmpeg"
      }
    ],
    "active_count": 1,
    "pool_size": 3,
    "transcode": {
      "queue_length": 2,
      "processing": 1,
      "concurrency": 3
    },
    "danmaku": {
      "active_captures": 1
    },
    "polling": {
      "total_polled": 8,
      "total_rooms": 12,
      "currently_live": 3,
      "platform_breakdown": {
        "huya": { "total": 3, "live": 1 },
        "kuaishou": { "total": 5, "live": 2 }
      }
    },
    "summary": {
      "sessions_today": 6,
      "sessions_today_total_size": 4831838208,
      "interrupted_today": 1,
      "uploads_today": 2,
      "uploads_failed_today": 0,
      "orphaned_files": 0
    },
    "recent_activity": [
      {
        "type": "session_completed",
        "title": "主播名 录制完成",
        "detail": "3 个分段, 1 GB",
        "timestamp": "2026-06-10T14:32:00.000Z",
        "link": "/sessions"
      }
    ]
  }
}
```

`polling` 来自 `PollingManager.getPollingSnapshot()`，只读取内存 Map，不在请求路径中逐房间访问 Redis。`summary` 的今日统计由应用服务器当天零点时间戳计算，避免依赖数据库服务器时区。

---

## 日志查看

### GET /api/logs/files

列出 `logs/` 目录下的日志文件。

**返回：**

```json
{
  "status": "ok",
  "data": [{ "name": "access.log", "size": 102400, "mtime": "2026-06-26T10:00:00.000Z" }]
}
```

### GET /api/logs/content

读取指定日志文件尾部内容，用于 `/logs` 页面按需查看最近日志。

**参数（Query）：**

| 参数 | 类型    | 必填 | 说明                                 |
| ---- | ------- | ---- | ------------------------------------ |
| file | string  | 是   | 日志文件名，仅允许 `logs/` 下 `.log` |
| tail | integer | 否   | 返回最后 N 行，默认 2000，最大 5000  |

**返回：**

```json
{
  "status": "ok",
  "data": {
    "file": "access.log",
    "lines": ["GET /api/health 200 5ms"],
    "truncated": true,
    "offset": 2048
  }
}
```

### GET /api/logs/stream

建立 SSE 连接，实时推送指定日志文件新增内容。后端使用文件 offset 轮询新增字节，不依赖 `fs.watch`。

前端日志页开启“实时查看”时会以 `tail=0` 连接该接口，语义是从当前文件末尾开始追踪，只追加连接建立后写入的完整新行；它不会定时重新拉取或刷新已显示的历史内容。若日志写入没有换行符，内容会暂存在服务端 buffer 中，直到后续写入换行后才推送。

**参数（Query）：**

| 参数 | 类型    | 必填 | 说明                                                                         |
| ---- | ------- | ---- | ---------------------------------------------------------------------------- |
| file | string  | 是   | 日志文件名，仅允许 `logs/` 下 `.log`                                         |
| tail | integer | 否   | 初始推送最后 N 行，默认 100；`0` 表示只返回当前 offset，后续仅推送新增完整行 |

**事件：**

- `ready`：连接就绪，格式 `{ "file": "access.log", "truncated": false, "offset": 2048 }`
- `log`：新增日志行，格式 `{ "line": "..." }`
- `reset`：日志文件发生轮转或截断，客户端应清空旧内容后继续接收
- `log-error`：读取日志时发生错误，格式 `{ "message": "..." }`

### DELETE /api/logs

删除指定日志文件。

**请求体：**

| 参数 | 类型   | 必填 | 说明                                 |
| ---- | ------ | ---- | ------------------------------------ |
| file | string | 是   | 日志文件名，仅允许 `logs/` 下 `.log` |

---

## 直播间管理

### GET /api/rooms

查询直播间列表。

**参数（Query）：**

| 参数   | 类型   | 必填 | 说明                                        |
| ------ | ------ | ---- | ------------------------------------------- |
| status | string | 否   | 按状态筛选：`idle` / `recording` / `paused` |

**示例：**

```bash
curl http://127.0.0.1:1123/api/rooms
curl http://127.0.0.1:1123/api/rooms?status=recording
```

---

### POST /api/rooms

创建直播间。如果 `room_url` 已存在则自动更新（upsert）。

**请求体：**

| 参数                 | 类型    | 必填 | 说明                                                                                            |
| -------------------- | ------- | ---- | ----------------------------------------------------------------------------------------------- |
| room_url             | string  | 是   | 直播间地址（唯一标识）                                                                          |
| room_name            | string  | 否   | 直播间名称                                                                                      |
| filename_template    | string  | 否   | 文件名模板，默认 `{room_name}_{datetime}`                                                       |
| segment_duration     | integer | 否   | 分段录制时长（秒）。0 或留空表示不分段，3600=每小时一个文件                                     |
| notification_enabled | boolean | 否   | 是否启用通知，默认 true                                                                         |
| monitoring_enabled   | boolean | 否   | 是否启用监听，默认 true（关闭后即使收到录制通知也不会启动下载）                                 |
| upload_template_id   | integer | 否   | 关联的投稿模板 ID；不设置则不自动投稿（可手动投稿）                                             |
| polling_enabled      | boolean | 否   | 是否启用轮询检测开播状态，默认 false                                                            |
| polling_platform     | string  | 否   | 轮询平台：`huya`、`bilibili`、`douyin`、`kuaishou`（已实现），`douyu`（不可用-平台流2分钟超时） |
| polling_interval     | integer | 否   | 轮询间隔（秒），默认 60，最小 30                                                                |

**示例：**

```bash
curl -X POST http://127.0.0.1:1123/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"room_url": "https://live.example.com/room1", "room_name": "主播名"}'
```

---

### GET /api/rooms/:id

查询单个直播间详情（包含轮询状态字段）。

---

### PUT /api/rooms/:id

更新直播间信息。直播间处于 `recording` 或 `paused` 时，仅接受 `notification_enabled`、`upload_template_id`；其余字段返回 400。

**请求体：**

| 参数                 | 类型    | 必填 | 说明                                   |
| -------------------- | ------- | ---- | -------------------------------------- |
| room_name            | string  | 否   | 直播间名称                             |
| filename_template    | string  | 否   | 文件名模板                             |
| segment_duration     | integer | 否   | 分段录制时长（秒）                     |
| notification_enabled | boolean | 否   | 是否启用通知                           |
| monitoring_enabled   | boolean | 否   | 是否启用监听                           |
| upload_template_id   | integer | 否   | 关联的投稿模板 ID；null 表示不自动投稿 |
| polling_enabled      | boolean | 否   | 是否启用轮询                           |
| polling_platform     | string  | 否   | 轮询平台                               |
| polling_interval     | integer | 否   | 轮询间隔（秒）                         |

---

### DELETE /api/rooms/:id

删除直播间（仅限 `idle` 状态）。

---

## 录制控制

### POST /api/rooms/:id/pause

暂停录制（向录制进程发送 `SIGSTOP`，适用于所有下载引擎）。

### POST /api/rooms/:id/resume

恢复录制（向录制进程发送 `SIGCONT`，适用于所有下载引擎）。

### POST /api/rooms/:id/stop

停止录制（向录制进程发送 `SIGTERM`，标记录制结束）。

---

## 录制触发

### POST /api/notify/live_download

触发直播流录制。如果 `room_url` 对应的直播间不存在，会自动创建。

**请求体：**

| 参数     | 类型   | 必填 | 说明                                |
| -------- | ------ | ---- | ----------------------------------- |
| url      | string | 是   | 直播流 URL（m3u8 / rtmp 等）        |
| title    | string | 是   | 直播标题（用于直播间名称）          |
| caption  | string | 否   | 直播描述/备注，存储到录制会话中     |
| room_url | string | 否   | 直播间地址。不传则用 `url` 作为标识 |

**示例：**

```bash
curl -X POST http://127.0.0.1:1123/api/notify/live_download \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://stream.example.com/live.m3u8", "title": "直播标题", "room_url": "https://live.example.com/room1"}'
```

**返回：**

```json
{
  "status": "Recording started",
  "data": {
    "room_id": 1,
    "room_url": "https://live.example.com/room1",
    "session_id": 42,
    "path": "/data/videos/主播名_20260514_143022.mp4"
  }
}
```

### POST /api/notify/feishu_webhook

转发一条飞书机器人消息。需要配置 `MESSAGE_FEISHU_WEBHOOK`；未配置时返回 HTTP 503。

**请求体：**

| 参数    | 类型   | 必填 | 说明     |
| ------- | ------ | ---- | -------- |
| title   | string | 是   | 消息标题 |
| content | string | 否   | 消息内容 |

### POST /api/notify/test_webhook

测试 Webhook 通知配置。向已配置的 Webhook URL 发送一条测试消息。

**请求体：**

| 参数 | 类型   | 必填 | 说明                                        |
| ---- | ------ | ---- | ------------------------------------------- |
| url  | string | 否   | 测试 URL，不传则使用 `settings.webhook_url` |

**返回：**

```json
{ "status": "ok", "message": "Webhook 测试发送成功" }
```

**错误：**

| 状态码 | 说明               |
| ------ | ------------------ |
| 400    | Webhook URL 未配置 |
| 500    | 发送失败           |

---

## 通知配置

服务端通知由录制、投稿、回放处理队列和投稿后处理流程自动触发，支持以下通道：

| 环境变量                  | 说明                                               |
| ------------------------- | -------------------------------------------------- |
| `MESSAGE_FEISHU_WEBHOOK`  | 飞书机器人 webhook；未配置则跳过飞书通知           |
| `MESSAGE_GOTIFY_SERVER`   | Gotify 服务地址，例如 `https://gotify.example.com` |
| `MESSAGE_GOTIFY_TOKEN`    | Gotify app token；未配置则跳过 Gotify 通知         |
| `MESSAGE_GOTIFY_PRIORITY` | Gotify 优先级，默认 `5`                            |

回放工具箱在每个处理步骤完成后发送「直播回放处理完成」通知，覆盖
`extract`、`download`、`cut`、`fix`、`upload`。通知发送失败只写入回放任务日志，
不会影响队列继续执行。

### GET /api/notify/status

查询直播间录制状态（轻量只读，不会创建房间）。

**参数（Query）：**

| 参数 | 类型   | 必填 | 说明                     |
| ---- | ------ | ---- | ------------------------ |
| url  | string | 是   | 直播间地址（`room_url`） |

**示例：**

```bash
curl 'http://127.0.0.1:1123/api/notify/status?url=https://live.example.com/room1'
```

**返回（空闲）：**

```json
{
  "exists": true,
  "data": {
    "status": "idle",
    "room": {
      "id": 1,
      "room_url": "https://live.example.com/room1",
      "room_name": "主播名"
    }
  }
}
```

**返回（录制中）：**

```json
{
  "exists": true,
  "data": {
    "status": "recording",
    "downloader": "ffmpeg",
    "room": {
      "id": 1,
      "room_url": "https://live.example.com/room1",
      "room_name": "主播名"
    },
    "session": { "id": 42, "started_at": "2026-05-14T14:30:22.000Z" }
  }
}
```

**返回（不存在）：**

```json
{ "exists": false }
```

---

### GET /api/sessions

查询录制会话列表。支持分页、按房间和状态筛选。

每条会话记录包含关联的投稿记录（`upload_records` 字段），无需单独请求投稿 API。

**参数（Query）：**

| 参数     | 类型    | 必填 | 说明                                                  |
| -------- | ------- | ---- | ----------------------------------------------------- |
| page     | integer | 否   | 页码，默认 1                                          |
| limit    | integer | 否   | 每页条数，默认 20                                     |
| room_url | string  | 否   | 按房间 URL 筛选                                       |
| room_id  | integer | 否   | 按房间 ID 筛选                                        |
| status   | string  | 否   | 按状态筛选：`recording` / `completed` / `interrupted` |

**响应结构：**

```json
{
  "status": "ok",
  "data": {
    "rows": [
      {
        "id": 25,
        "room_url": "https://live.example.com/room1",
        "room_name": "主播名",
        "status": "completed",
        "started_at": "2026-05-14T14:30:22Z",
        "ended_at": "2026-05-14T17:30:22Z",
        "total_segments": 3,
        "total_size": 524288000,
        "danmaku_status": "completed",
        "danmaku_event_count": 1200,
        "upload_records": [{ "id": 1, "session_id": 25, "status": "success", "bv_id": "BV1xx" }]
      }
    ],
    "total": 150
  }
}
```

**`upload_records` 字段说明：**

| 字段       | 类型           | 说明                        |
| ---------- | -------------- | --------------------------- |
| id         | integer        | 投稿记录 ID                 |
| session_id | integer        | 关联的录制会话 ID           |
| status     | string         | 投稿状态：success/failed 等 |
| bv_id      | string \| null | Bilibili BV 号              |

**示例：**

```bash
curl http://127.0.0.1:1123/api/sessions?page=1&limit=10
curl http://127.0.0.1:1123/api/sessions?status=completed&room_id=3
```

---

### GET /api/sessions/:id

查询录制会话详情（包含该会话的所有文件记录，以 `recording_files` 表为数据源）。

**示例：**

```bash
curl http://127.0.0.1:1123/api/sessions/25
```

**返回：**

```json
{
  "status": "ok",
  "data": {
    "session": {
      "id": 25,
      "room_url": "https://live.example.com/room1",
      "status": "completed",
      "total_segments": 3,
      "total_size": 524288000
    },
    "recordings": [
      {
        "id": 101,
        "session_id": 25,
        "file_path": "/data/videos/主播名_20260514_143022.mp4",
        "file_size": 262144000,
        "status": "completed",
        "file_exists": true
      }
    ]
  }
}
```

**说明：**

- `recordings` 数组内容实际来自 `recording_files` 表，字段映射后返回（含 `segment_index: 0` 和 `ended_at`）
- 若该会话尚无文件记录但有 `rooms.output_path`（录制中），则自动从磁盘读取文件信息
- 受 `filtering_threshold` 设置影响，小于阈值的文件会被过滤

---

### GET /api/recording_files

查询录制文件跟踪记录。

**参数（Query）：**

| 参数       | 类型    | 必填 | 说明                                                                                       |
| ---------- | ------- | ---- | ------------------------------------------------------------------------------------------ |
| status     | string  | 否   | 按状态筛选：`pending` / `recording` / `completed` / `interrupted` / `missing` / `orphaned` |
| session_id | integer | 否   | 按会话 ID 筛选                                                                             |

### DELETE /api/recordings/:id

删除录制文件记录。

**参数（Query）：**

| 参数        | 类型   | 必填 | 说明                                                                      |
| ----------- | ------ | ---- | ------------------------------------------------------------------------- |
| delete_file | string | 否   | 设为 `true` 时同时删除本地文件（主文件 + HLS 目录），默认仅删除数据库记录 |

**删除本地文件时的行为：**

1. 删除 `file_path` 对应的主文件（.ts/.flv/.mp4 等）
2. 若 `hls_status` 为 `ready`，通过统一 HLS 删除服务删除播放列表目录并同步索引与审计

**示例：**

```bash
# 仅删除数据库记录
curl -X DELETE http://127.0.0.1:1123/api/recordings/42

# 同时删除本地文件
curl -X DELETE "http://127.0.0.1:1123/api/recordings/42?delete_file=true"
```

---

### GET /api/recordings/:id/stream

流式播放录制文件。支持 HTTP Range 请求（拖拽播放）。
数据源：`recording_files` 表

**查询参数：**

**返回：**

视频流（`video/mp4` / `video/x-flv` / `video/mp2t` 等，根据文件扩展名自动判断 MIME 类型）。

---

### GET /api/recordings/:id/hls

查询录制文件的 HLS 播放状态。
数据源：`recording_files` 表

**返回（HLS 已就绪）：**

```json
{
  "status": "ok",
  "data": {
    "is_ready": true,
    "playlist_path": "/data/videos/room1/hls_filename/playlist.m3u8",
    "relative_path": "room1/hls_filename/playlist.m3u8",
    "generated_at": "2026-05-25T12:00:00.000Z",
    "hls_status": "ready",
    "type": "recording_file"
  }
}
```

**返回（HLS 未就绪）：**

```json
{
  "status": "ok",
  "data": {
    "is_ready": false,
    "hls_status": "expired",
    "source_file": "/data/videos/room1/file.mp4",
    "type": "recording_file"
  }
}
```

---

### POST /api/recordings/:id/generate-hls

手动触发生成 HLS 播放文件。允许从 `pending`、`expired`、`deleted`、`missing`、
`failed` 状态生成；成功后状态恢复为 `ready`，并重新激活对应文件管理索引。
数据源：`recording_files` 表

**返回（成功）：**

```json
{
  "status": "ok",
  "data": {
    "playlist_path": "/data/videos/room1/hls_filename/playlist.m3u8",
    "already_exists": false,
    "hls_status": "ready"
  }
}
```

**返回（失败）：**

```json
{
  "status": "Error",
  "message": "HLS 生成失败"
}
```

---

### POST /api/recordings/:id/transcode

手动将录制文件加入转码队列。**无视 `auto_transcode` 全局设置**，强制入队。

**前置条件：**

- 文件状态为 `completed` 且文件存在于磁盘
- 文件格式为 `.ts` / `.flv` / `.m2ts`
- 文件未在转码队列中（无 `queued` / `processing` 状态的转码记录）

**返回：**

```json
{ "status": "ok", "message": "已加入转码队列" }
```

**错误：**

| 状态码 | 说明                   |
| ------ | ---------------------- |
| 400    | 文件格式不支持或不存在 |
| 404    | 记录不存在             |
| 409    | 文件已在转码队列中     |
| 500    | 服务端异常             |

**示例：**

```bash
curl -X POST http://127.0.0.1:1123/api/recordings/42/transcode
```

---

### GET /api/hls/\*

HLS 文件服务，提供 `.m3u8` 播放列表和 `.ts` 分片文件。

**说明：**

- 路径参数为相对于 `VIDEO_DOWNLOAD_DIR` 的路径
- 支持 HTTP Range 请求，实现断点续传
- MIME 类型自动识别：`.m3u8` 返回 `application/vnd.apple.mpegurl`，`.ts` 返回 `video/mp2t`

**示例：**

```bash
# 播放列表
curl http://127.0.0.1:1123/api/hls/room1/hls_filename/playlist.m3u8

# TS 分片
curl http://127.0.0.1:1123/api/hls/room1/hls_filename/segment_001.ts
```

---

### DELETE /api/recording_files/missing

一键删除所有缺失（`missing`）文件记录。

**示例：**

```bash
curl -X DELETE http://127.0.0.1:1123/api/recording_files/missing
```

**返回：**

```json
{ "status": "ok", "message": "已删除 5 条缺失记录" }
```

---

### PUT /api/recording_files/:id/associate

将孤文件（`orphaned`）关联到录制会话。

**请求体：**

| 参数       | 类型    | 必填 | 说明            |
| ---------- | ------- | ---- | --------------- |
| session_id | integer | 是   | 目标录制会话 ID |

---

## 全局设置

### GET /api/settings

查询所有全局设置项。

**示例：**

```bash
curl http://127.0.0.1:1123/api/settings
```

**返回：**

```json
{
  "status": "ok",
  "data": [
    { "id": 1, "key": "pool_size", "value": "3" },
    { "id": 2, "key": "watchdog_interval", "value": "30" }
  ],
  "map": { "pool_size": "3", "watchdog_interval": "30" }
}
```

### PUT /api/settings/:key

更新指定设置项的值。

**请求体：**

| 参数  | 类型   | 必填 | 说明   |
| ----- | ------ | ---- | ------ |
| value | string | 是   | 设置值 |

**示例：**

```bash
curl -X PUT http://127.0.0.1:1123/api/settings/pool_size \
  -H 'Content-Type: application/json' \
  -d '{"value": "5"}'
```

### 全局设置项说明

| 键                           | 类型   | 默认值   | 说明                                                         |
| ---------------------------- | ------ | -------- | ------------------------------------------------------------ |
| `downloader`                 | string | `ffmpeg` | 下载插件（已弃用多引擎，仅 `ffmpeg`，保留键名兼容旧配置）    |
| `pool_size`                  | number | `3`      | 下载线程池大小，限制最大同时录制数                           |
| `watchdog_interval`          | number | `30`     | 看门狗检查间隔（秒）                                         |
| `watchdog_timeout`           | number | `60`     | 录制状态检查超时（秒），超过此时长无活动则标记为完成         |
| `filtering_threshold`        | number | `10`     | 碎片过滤（MB），小于此大小的视频文件将被过滤删除             |
| `delay`                      | number | `60`     | 下播延迟检测（秒），检测到主播下播后延迟确认时间             |
| `auto_transcode`             | string | `true`   | 自动转码，录制完成后自动将 FLV 转换为 MP4                    |
| `transcode_delete_originals` | string | `false`  | 转码后删除原始文件，转码成功后自动删除 FLV 原始文件          |
| `max_upload_limit`           | number | `3`      | 单会话最大投稿次数（24小时）                                 |
| `auto_generate_hls`          | string | `true`   | 自动生成 HLS，录制完成后自动生成 HLS 播放文件                |
| `hls_enabled`                | string | `true`   | 是否启用 HLS 播放功能                                        |
| `hls_segment_duration`       | number | `10`     | HLS 分片时长（秒）                                           |
| `hls_cleanup_days`           | number | `30`     | HLS 独立保留期；`0` 禁用，正整数按生成时间每日清理           |
| `transcode_concurrency`      | number | `3`      | 转码并发数，同时进行的转码任务数                             |

---

## 投稿模板

### GET /api/upload_templates

查询所有投稿模板列表。

**示例：**

```bash
curl http://127.0.0.1:1123/api/upload_templates
```

**返回：**

```json
{
  "status": "ok",
  "data": [
    {
      "id": 1,
      "name": "默认模板",
      "title_template": "{room_name} 直播录像 {date}",
      "desc_template": "",
      "tid": "",
      "cookies_path": "",
      "priority": 0,
      "created_at": "2026-05-14T10:00:00.000Z"
    }
  ]
}
```

---

### POST /api/upload_templates

创建投稿模板。

**请求体：**

| 参数           | 类型   | 必填 | 说明                                                                                      |
| -------------- | ------ | ---- | ----------------------------------------------------------------------------------------- |
| name           | string | 是   | 模板名称                                                                                  |
| title_template | string | 否   | 标题模板，默认 `{room_name} 直播录像 {date}`                                              |
| desc_template  | string | 否   | 描述模板                                                                                  |
| tid            | string | 否   | 分区 ID                                                                                   |
| cookies_path   | string | 否   | Cookies 文件路径                                                                          |
| priority       | number | 否   | 优先级，数字越小越优先                                                                    |
| source_delete  | number | 否   | 投稿后删除源文件，0=不删除 1=删除                                                         |
| after_upload   | string | 否   | 投稿后操作：`none`=无操作 `backup`=备份到NAS `delete`=删除 `backup_and_delete`=备份后删除 |

`after_upload=backup` 或 `backup_and_delete` 依赖 `NAS_HOST`、`NAS_USER`、
`NAS_BACKUP_DIR`。未配置 NAS 时会跳过备份；`backup_and_delete` 不会继续删除本地文件。

**示例：**

```bash
curl -X POST http://127.0.0.1:1123/api/upload_templates \
  -H 'Content-Type: application/json' \
  -d '{"name": "默认模板", "title_template": "{room_name} 直播录像 {date}"}'
```

---

### PUT /api/upload_templates/:id

更新投稿模板。

---

### DELETE /api/upload_templates/:id

删除投稿模板。

---

## 稿件投递

### POST /api/sessions/:id/upload

对录制会话执行投稿。

**请求体：**

| 参数          | 类型    | 必填 | 说明                                                                                                                  |
| ------------- | ------- | ---- | --------------------------------------------------------------------------------------------------------------------- |
| template_id   | integer | 是   | 投稿模板 ID                                                                                                           |
| upload_source | string  | 否   | 投稿文件来源：`original`=源视频（默认，v1.8.0 起为唯一有效值；弹幕压制已迁至 danmaku-tool，不再产出可投稿的压制视频） |

**示例：**

```bash
# 使用源视频投稿（默认）
curl -X POST http://127.0.0.1:1123/api/sessions/25/upload \
  -H 'Content-Type: application/json' \
  -d '{"template_id": 1, "upload_source": "original"}'
```

**返回：**

接口立即返回，上传在后台异步执行。可通过 `GET /api/upload_records` 查询上传状态。

```json
{
  "status": "ok",
  "message": "[投稿] 25 → 模板 1「默认模板」已开始"
}
```

### GET /api/upload_records

查询投稿记录列表。

**参数（Query）：**

| 参数       | 类型    | 必填 | 说明                                           |
| ---------- | ------- | ---- | ---------------------------------------------- |
| session_id | integer | 否   | 按会话 ID 筛选                                 |
| status     | string  | 否   | 按状态筛选：`uploading` / `success` / `failed` |

**返回字段说明：**

| 字段         | 类型   | 说明                            |
| ------------ | ------ | ------------------------------- |
| upload_files | string | JSON 数组，投稿时的文件路径列表 |
| file_count   | number | 文件数量                        |
| total_size   | number | 总大小（字节）                  |
| bv_id        | string | B站视频 BV 号                   |
| output       | string | 投稿输出信息                    |

---

### DELETE /api/upload_records/:id

删除投稿记录。

---

## 转码记录

### GET /api/transcode_records

查询转码记录列表。支持分页。

**参数（Query）：**

| 参数   | 类型    | 必填 | 说明                                                         |
| ------ | ------- | ---- | ------------------------------------------------------------ |
| status | string  | 否   | 按状态筛选：`queued` / `processing` / `completed` / `failed` |
| limit  | integer | 否   | 返回记录数量，默认 100                                       |
| page   | integer | 否   | 页码，默认 1。传 `page` 时启用分页（LIMIT + OFFSET）         |

**返回字段说明：**

| 字段            | 类型     | 说明                                     |
| --------------- | -------- | ---------------------------------------- |
| id              | integer  | 记录 ID                                  |
| session_id      | integer  | 关联的录制会话 ID                        |
| original_path   | string   | 原文件路径（FLV）                        |
| transcoded_path | string   | 转码后文件路径（MP4）                    |
| status          | string   | 状态：queued/processing/completed/failed |
| enqueued_at     | datetime | 入队时间                                 |
| started_at      | datetime | 开始转码时间                             |
| completed_at    | datetime | 完成转码时间                             |
| room_name       | string   | 关联的直播间名称                         |

**响应结构：**

```json
{
  "status": "ok",
  "data": [ ... ],
  "total": 150
}
```

**示例：**

```bash
curl http://127.0.0.1:1123/api/transcode_records
curl http://127.0.0.1:1123/api/transcode_records?status=completed&page=2&limit=20
```

---

### DELETE /api/transcode_records/:id

删除转码记录。

**示例：**

```bash
curl -X DELETE http://127.0.0.1:1123/api/transcode_records/1
```

---

## 文件名模板

| 占位符        | 说明              | 示例              |
| ------------- | ----------------- | ----------------- |
| `{room_name}` | 直播间名称        | `主播名`          |
| `{datetime}`  | `YYYYMMDD_HHmmss` | `20260514_143022` |
| `{YYYY}`      | 年                | `2026`            |
| `{MM}`        | 月（补零）        | `05`              |
| `{DD}`        | 日（补零）        | `14`              |
| `{HH}`        | 时（补零，24h）   | `14`              |
| `{mm}`        | 分（补零）        | `30`              |
| `{ss}`        | 秒（补零）        | `22`              |

**自定义模板示例：**

```
主播名_{YYYY}-{MM}-{DD}_{HH}-{mm}-{ss}
```

**分段录制时**，文件名使用 strftime 格式，每个分片独立命名：

| 模板                              | 第一段文件名                  | 第二段文件名                  |
| --------------------------------- | ----------------------------- | ----------------------------- |
| `{room_name}_{datetime}`          | `KSG无言_20260514_143022.mp4` | `KSG无言_20260514_153022.mp4` |
| `{YYYY}-{MM}-{DD}_{HH}-{mm}-{ss}` | `2026-05-14_14-30-22.mp4`     | `2026-05-14_15-30-22.mp4`     |

不再使用序号 `_000` / `_001`，每个文件都有独立的时间戳。

---

## 弹幕管理

### POST /api/danmaku/batch

接收 Chrome Extension 批量推送的弹幕数据。

v1.9.0 起：无活跃采集会话时返回 **HTTP 409**，响应 `{ok:false, error:'no_active_session'}`。
扩展据此保留自己的缓冲区（`buffer.unshift`），等录制启动后自动续发。
后端同时把这批弹幕落到 `danmaku/_orphan/` 兜底文件（ADR-012）。

**请求体：**

| 字段       | 类型   | 必填 | 说明         |
| ---------- | ------ | ---- | ------------ |
| `room_url` | string | 是   | 直播间 URL   |
| `events`   | array  | 是   | 弹幕事件数组 |

**示例：**

```bash
curl -X POST http://127.0.0.1:1123/api/danmaku/batch \
  -H 'Content-Type: application/json' \
  -d '{"room_url":"https://live.kuaishou.com/u/xxx","events":[{"type":"comment","text":"666","username":"user1","ts_ms":1000}]}'
```

---

### GET /api/danmaku/status

获取当前弹幕采集的实时状态（弹幕压制已迁出，本接口不再包含压制队列信息）。

**返回：**

```json
{
  "status": "ok",
  "data": {
    "active_captures": { "count": 1 }
  }
}
```

---

### GET /api/danmaku/search

搜索指定会话的弹幕 JSONL 内容。

**查询参数：**

| 参数         | 类型   | 必填 | 说明                           |
| ------------ | ------ | ---- | ------------------------------ |
| `session_id` | number | 是   | 会话 ID                        |
| `keyword`    | string | 否   | 搜索关键词（匹配内容和用户名） |
| `limit`      | number | 否   | 每页条数，默认 50，最大 200    |
| `offset`     | number | 否   | 偏移量，默认 0                 |

---

### GET /api/danmaku_capture_records

查询弹幕采集记录。

**查询参数：**

| 参数         | 类型   | 说明       |
| ------------ | ------ | ---------- |
| `session_id` | number | 按会话筛选 |
| `status`     | string | 按状态筛选 |

---

### 孤儿弹幕回填（ADR-012，v1.9.0）

无活跃采集会话时收到的弹幕批次会落到 `danmaku/_orphan/` 兜底文件并登记
`orphan_pending` 记录，通过以下接口按时间戳区间匹配回填到历史会话。

#### GET /api/danmaku/orphan

孤儿弹幕记录列表。

**查询参数：**

| 参数     | 类型   | 说明                                                          |
| -------- | ------ | ------------------------------------------------------------- |
| `status` | string | 状态筛选；缺省返回全部 `orphan_*`                             |
| `limit`  | number | 条数，默认 100，最大 500                                      |

#### POST /api/danmaku/orphan/reconcile/:recordId

触发单条孤儿弹幕的时间戳区间匹配回填。

**查询参数：**

| 参数      | 类型 | 说明                                          |
| --------- | ---- | --------------------------------------------- |
| `dry_run` | 0/1  | 只预览分桶结果，不落盘、不改状态              |
| `force`   | 0/1  | 忽略置信度阈值强制回填（人工确认后使用）      |

置信度不足或无命中时返回 **HTTP 409**，`data` 内含分桶预览供人工判断。

#### POST /api/danmaku/orphan/reconcile-all

批量回填所有 `orphan_pending` 记录，支持 `dry_run` / `force`。

#### DELETE /api/danmaku/orphan/:recordId

人工丢弃某条孤儿弹幕：文件移动到 `danmaku/_discarded/` 归档（不硬删），状态置 `orphan_discarded`。

---

## 回放工具箱

> 回放工具箱已接通数据库、API、队列、前端工作台和快手回放客户端（`KuaishouReplayClient`）。`POST /api/replay/records/sync` 通过快手 `playback/list` API 拉取回放列表并自动 upsert；`extract` 步骤采用两级降级策略：先调用 `playback/detail` HTTP API 获取 playUrlV3，失败时自动降级到 Playwright 浏览器方案（`m3u8-extractor.js`）拦截网络 m3u8 流。快手访问态复用直播轮询的 `POLLING_KUAISHOU_COOKIE`。浏览器方案需配置 `REMOTE_BROWSER_WS_ENDPOINT`。回放下载、剪切和修复产物写入 `REPLAY_WORK_DIR`；未配置时默认使用 `VIDEO_DOWNLOAD_DIR` 同级的 `replay` 目录。

### GET /api/replay/principals

列出可处理回放的快手主播。后端从 `rooms.room_url` 中识别 `kuaishou.com` 主播 ID，并聚合 `replay_records` 最新状态。

### GET /api/replay/principals/:principalId/records

查询主播回放记录。

**查询参数：**

| 参数        | 类型   | 说明                                                |
| ----------- | ------ | --------------------------------------------------- |
| `page`      | number | 页码，默认 1                                        |
| `page_size` | number | 每页条数，默认 20，最大 100                         |
| `status`    | string | 状态筛选：`pending` / `extracted` / `downloaded` 等 |
| `date_from` | string | 按 `start_time` 起始时间筛选                        |
| `date_to`   | string | 按 `start_time` 结束时间筛选                        |

### GET /api/replay/records/:id

查询单条回放记录详情。

### POST /api/replay/records/sync

同步主播回放列表。

**请求体：**

| 参数           | 类型    | 必填 | 说明                     |
| -------------- | ------- | ---- | ------------------------ |
| `principal_id` | string  | 是   | 主播 ID                  |
| `count`        | number  | 否   | 拉取条数，默认 1         |
| `dry_run`      | boolean | 否   | 只验证参数，不写入数据库 |

### POST /api/replay/records/mark-completed

手动将一批回放记录标记为已完成。

**请求体：**

| 参数  | 类型     | 必填 | 说明             |
| ----- | -------- | ---- | ---------------- |
| `ids` | number[] | 是   | 回放记录 ID 列表 |

响应中的 `data.updated` 为已更新记录，`data.missing_ids` 为未找到的 ID。

### POST /api/replay/records/:id/actions/:action

将单条回放加入处理队列。

**动作：** `extract`、`download`、`cut`、`fix`、`upload`、`all`。

请求体可传：

| 字段    | 类型    | 必填 | 说明                                                                                                                                                                        |
| ------- | ------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `force` | boolean | 否   | 是否强制重跑。默认 `false`；`all` 会复用已有 m3u8、下载文件或切片产物，只继续后续步骤。传 `true` 时从提取/下载开始覆盖执行，下载步骤会向 yt-dlp 传递 `--force-overwrites`。 |

### POST /api/replay/records/:id/cancel

取消正在运行的回放处理任务。后端会向当前子进程发送 `SIGTERM`，必要时升级为 `SIGKILL`，并将记录状态更新为 `cancelled`。

### GET /api/replay/tasks

查询回放处理队列状态。

**返回：**

```json
{
  "status": "ok",
  "data": {
    "queue_length": 0,
    "processing": 0,
    "concurrency": 1,
    "active": []
  }
}
```

### POST /api/replay/tasks/enqueue

按主播批量加入最近的未完成回放处理任务。

非强制入队会跳过已完成、已备份、已在队列中、正在处理、正在上传或已有成功投稿记录的回放，避免 `replay_cron` 与手动全流程重复触发同一回放投稿。

**请求体：**

| 参数             | 类型    | 必填 | 说明                   |
| ---------------- | ------- | ---- | ---------------------- |
| `principal_id`   | string  | 是   | 主播 ID                |
| `count`          | number  | 否   | 入队数量，默认 1       |
| `skip_completed` | boolean | 否   | 跳过已投稿/已备份记录  |
| `dry_run`        | boolean | 否   | 只返回候选记录，不入队 |

### GET /api/replay/principals/:principalId/uploads

查询主播回放投稿记录。支持分页。

**参数（Query）：**

| 参数      | 类型    | 必填 | 说明                        |
| --------- | ------- | ---- | --------------------------- |
| page      | integer | 否   | 页码，默认 1                |
| page_size | integer | 否   | 每页条数，默认 20，上限 100 |

**响应结构：**

```json
{
  "status": "ok",
  "data": [ ... ],
  "total": 80,
  "page": 1,
  "page_size": 20
}
```

**`data` 字段说明：**

| 字段             | 类型           | 说明              |
| ---------------- | -------------- | ----------------- |
| id               | integer        | 投稿记录 ID       |
| replay_record_id | integer        | 关联的回放记录 ID |
| status           | string         | 投稿状态          |
| bv_id            | string \| null | Bilibili BV 号    |
| title            | string         | 投稿标题          |
| created_at       | datetime       | 创建时间          |

**示例：**

```bash
curl http://127.0.0.1:1123/api/replay/principals/kuaishou_123/uploads?page=1&page_size=20
```

### GET /api/replay/principals/:principalId/settings

查询主播级回放配置。默认值来自全局 `settings` 表。

### PUT /api/replay/principals/:principalId/settings

更新主播级配置。允许字段：`upload_template_id`、`auto_upload`、`auto_backup`、`max_count_per_run`。

---

## 文件管理

> 文件管理模块提供磁盘文件的安全删除能力。核心流程：查询文件列表 → 生成删除计划（dry-run）→ 确认执行异步删除 → 轮询任务进度。删除操作需要 `confirm: true` 二次确认，并通过审计日志记录所有操作。

每个 `recording_files` HLS 目录对应一条 `managed_files` 记录，`source_id` 为精确的录制文件
ID，`group_id` 为会话 ID。HLS 目录大小递归汇总目录内文件，不包含目录项自身大小。手动删除
与保留期删除共用相同的路径校验、生命周期变更和审计逻辑。

### GET /api/files/summary

磁盘空间概览：各目录占用 + 总计 + 可清理预估。

**返回：**

```json
{
  "status": "ok",
  "data": {
    "total_size": 107374182400,
    "categories": {
      "recording": { "count": 50, "size": 85899345920 },
      "hls": { "count": 30, "size": 21474836480 }
    },
    "safe_to_delete_size": 10737418240
  }
}
```

### GET /api/files

文件列表（分页、筛选）。

**参数（Query）：**

| 参数           | 类型    | 必填 | 说明                                         |
| -------------- | ------- | ---- | -------------------------------------------- |
| type           | string  | 否   | 文件类型（如 `video`、`subtitle`）           |
| category       | string  | 否   | 文件分类（如 `recording`、`hls`、`danmaku`） |
| status         | string  | 否   | 状态：`active` / `deleted` / `missing`       |
| exists_on_disk | boolean | 否   | 磁盘是否存在                                 |
| safe_to_delete | boolean | 否   | 是否可安全删除                               |
| ext            | string  | 否   | 扩展名筛选（如 `.mp4`、`.ts`）               |
| min_size       | integer | 否   | 最小文件大小（字节）                         |
| start_date     | string  | 否   | 起始日期，格式 `YYYY-MM-DD`                  |
| end_date       | string  | 否   | 结束日期，格式 `YYYY-MM-DD`                  |
| session_id     | integer | 否   | 按会话 ID 筛选                               |
| search         | string  | 否   | 文件名搜索                                   |
| page           | integer | 否   | 页码，默认 1                                 |
| limit          | integer | 否   | 每页条数，默认 50                            |
| sort           | string  | 否   | 排序字段（如 `file_size`、`mtime`）          |

**返回：**

```json
{
  "status": "ok",
  "data": [
    {
      "id": 1,
      "category": "recording",
      "file_type": "video",
      "file_path": "/data/videos/session_42/file.mp4",
      "file_name": "file.mp4",
      "file_size": 524288000,
      "exists_on_disk": true,
      "safe_to_delete": true,
      "mtime": "2026-06-20T10:00:00.000Z"
    }
  ],
  "total": 100,
  "page": 1,
  "limit": 50
}
```

### GET /api/files/:id

文件详情。

**返回：**

```json
{
  "status": "ok",
  "data": {
    "id": 1,
    "category": "recording",
    "file_type": "video",
    "source_table": "recording_files",
    "source_id": 101,
    "file_path": "/data/videos/session_42/file.mp4",
    "file_name": "file.mp4",
    "extension": ".mp4",
    "file_size": 524288000,
    "exists_on_disk": true,
    "safe_to_delete": true,
    "delete_block_reason": null,
    "mtime": "2026-06-20T10:00:00.000Z",
    "created_at": "2026-06-20T10:00:00.000Z"
  }
}
```

### POST /api/files/delete-plan

生成删除计划（dry-run）。不实际删除文件，仅返回预估结果。

**请求体：**

| 参数     | 类型     | 必填 | 说明                      |
| -------- | -------- | ---- | ------------------------- |
| file_ids | number[] | 否   | 文件 ID 列表              |
| filters  | object   | 否   | 筛选条件（同 GET /files） |

> `file_ids` 和 `filters` 至少提供一个。`file_ids` 最多 200 个。

**返回：**

```json
{
  "status": "ok",
  "data": {
    "plan_id": "plan_abc123",
    "files": [{ "id": 1, "file_name": "file.mp4", "file_size": 524288000, "safe_to_delete": true }],
    "total_files": 1,
    "estimated_release_size": 524288000,
    "warnings": []
  }
}
```

### POST /api/files/delete

执行异步删除。需要 `plan_id` + `confirm: true`。立即返回 `task_id`，前端通过 `GET /files/delete-tasks/:taskId` 轮询进度。

**请求体：**

| 参数    | 类型    | 必填 | 说明          |
| ------- | ------- | ---- | ------------- |
| plan_id | string  | 是   | 删除计划 ID   |
| confirm | boolean | 是   | 必须为 `true` |

**返回：**

```json
{
  "status": "ok",
  "data": {
    "task_id": "task_xyz789",
    "status": "processing",
    "total_files": 5,
    "processed": 0
  }
}
```

### GET /api/files/delete-tasks/:taskId

查询删除任务进度。

**返回：**

```json
{
  "status": "ok",
  "data": {
    "task_id": "task_xyz789",
    "status": "completed",
    "total_files": 5,
    "processed": 5,
    "succeeded": 4,
    "failed": 1,
    "errors": [{ "file_id": 3, "error": "文件不存在" }]
  }
}
```

### POST /api/files/:id/delete

单文件同步删除。直接删除指定文件并记录审计日志。

**返回：**

```json
{
  "status": "ok",
  "data": {
    "file_id": 1,
    "deleted": true,
    "released_size": 524288000
  }
}
```

### POST /api/files/scan

触发全量文件扫描。扫描所有已跟踪目录，同步磁盘状态到 `managed_files` 表。

**返回：**

```json
{
  "status": "ok",
  "data": {
    "scanned": 150,
    "added": 5,
    "updated": 10,
    "missing": 2
  }
}
```
