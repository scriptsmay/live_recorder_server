# API 文档

## 基础信息

- 基础地址：`http://<host>:<port>/api`
- 默认端口：`1123`
- 请求格式：`application/json`

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

| 参数                 | 类型    | 必填 | 说明                                                            |
| -------------------- | ------- | ---- | --------------------------------------------------------------- |
| room_url             | string  | 是   | 直播间地址（唯一标识）                                          |
| room_name            | string  | 否   | 直播间名称                                                      |
| filename_template    | string  | 否   | 文件名模板，默认 `{room_name}_{datetime}`                       |
| segment_duration     | integer | 否   | 分段录制时长（秒）。0 或留空表示不分段，3600=每小时一个文件     |
| notification_enabled | boolean | 否   | 是否启用通知，默认 true                                         |
| monitoring_enabled   | boolean | 否   | 是否启用监听，默认 true（关闭后即使收到录制通知也不会启动下载） |
| upload_template_id   | integer | 否   | 关联的投稿模板 ID；不设置则不自动投稿（可手动投稿）             |
| polling_enabled      | boolean | 否   | 是否启用轮询检测开播状态，默认 false                            |
| polling_platform     | string  | 否   | 轮询平台：`huya`（当前仅支持虎牙）                              |
| polling_interval     | integer | 否   | 轮询间隔（秒），默认 60，最小 30                                |

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

---

## 通知配置

服务端通知由录制、投稿和投稿后处理流程自动触发，支持以下通道：

| 环境变量                  | 说明                                               |
| ------------------------- | -------------------------------------------------- |
| `MESSAGE_FEISHU_WEBHOOK`  | 飞书机器人 webhook；未配置则跳过飞书通知           |
| `MESSAGE_GOTIFY_SERVER`   | Gotify 服务地址，例如 `https://gotify.example.com` |
| `MESSAGE_GOTIFY_TOKEN`    | Gotify app token；未配置则跳过 Gotify 通知         |
| `MESSAGE_GOTIFY_PRIORITY` | Gotify 优先级，默认 `5`                            |

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

### GET /api/recordings/:id/stream

流式播放录制文件。支持 HTTP Range 请求（拖拽播放）。
查询优先级：先查 `recordings` 表，未命中则查 `recording_files` 表。

**返回：**

视频流（`video/mp4` / `video/x-flv` / `video/mp2t` 等，根据文件扩展名自动判断 MIME 类型）。

---

### GET /api/recordings/:id/hls

查询录制文件的 HLS 播放状态。
查询优先级：先查 `recordings` 表，未命中则查 `recording_files` 表。

**返回（HLS 已就绪）：**

```json
{
  "status": "ok",
  "data": {
    "is_ready": true,
    "playlist_path": "/data/videos/room1/hls_filename/playlist.m3u8",
    "relative_path": "room1/hls_filename/playlist.m3u8",
    "generated_at": "2026-05-25T12:00:00.000Z",
    "type": "recording"
  }
}
```

**返回（HLS 未就绪）：**

```json
{
  "status": "ok",
  "data": {
    "is_ready": false,
    "source_file": "/data/videos/room1/file.mp4",
    "type": "recording"
  }
}
```

---

### POST /api/recordings/:id/generate-hls

手动触发生成 HLS 播放文件。
查询优先级：先查 `recordings` 表，未命中则查 `recording_files` 表。

**返回（成功）：**

```json
{
  "status": "ok",
  "data": {
    "playlist_path": "/data/videos/room1/hls_filename/playlist.m3u8",
    "already_exists": false
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

### GET /api/hls/*

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
| `max_resume_retries`         | number | `3`      | 会话恢复重试次数，服务器启动时自动恢复录制会话的最大重试次数 |
| `auto_transcode`             | string | `true`   | 自动转码，录制完成后自动将 FLV 转换为 MP4                    |
| `transcode_delete_originals` | string | `false`  | 转码后删除原始文件，转码成功后自动删除 FLV 原始文件          |
| `submit_api`                 | string | -        | 外部投稿 API 地址                                            |
| `lines`                      | string | `1`      | 上传线路                                                     |
| `threads`                    | string | `8`      | 上传线程数                                                   |
| `pool2_size`                 | string | `1`      | 上传线程池大小                                               |
| `max_upload_limit`           | number | `3`      | 单会话最大投稿次数（24小时）                                 |
| `auto_generate_hls`          | string | `true`   | 自动生成 HLS，录制完成后自动生成 HLS 播放文件               |
| `hls_enabled`                | string | `true`   | 是否启用 HLS 播放功能                                       |
| `hls_segment_duration`       | number | `10`     | HLS 分片时长（秒）                                          |
| `hls_cleanup_days`           | number | `30`     | HLS 文件自动清理天数，超过此时长自动删除                     |
| `transcode_concurrency`      | number | `3`      | 转码并发数，同时进行的转码任务数                            |

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

| 参数        | 类型    | 必填 | 说明                        |
| ----------- | ------- | ---- | --------------------------- |
| template_id | integer | 否   | 投稿模板 ID，不传则自动选择 |

**示例：**

```bash
curl -X POST http://127.0.0.1:1123/api/sessions/25/upload \
  -H 'Content-Type: application/json' \
  -d '{"template_id": 1}'
```

**返回：**

```json
{
  "status": "ok",
  "data": {
    "record_id": 10,
    "bv_id": "BV1234567890",
    "message": "投稿成功"
  }
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

查询转码记录列表。

**参数（Query）：**

| 参数   | 类型    | 必填 | 说明                                                         |
| ------ | ------- | ---- | ------------------------------------------------------------ |
| status | string  | 否   | 按状态筛选：`queued` / `processing` / `completed` / `failed` |
| limit  | integer | 否   | 返回记录数量，默认 100                                       |

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

**示例：**

```bash
curl http://127.0.0.1:1123/api/transcode_records
curl http://127.0.0.1:1123/api/transcode_records?status=completed
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
