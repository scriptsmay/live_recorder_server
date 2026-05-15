# API 文档

## 基础信息

- 基础地址：`http://<host>:<port>/api`
- 默认端口：`1123`
- 请求格式：`application/json`

---

## 直播间管理

### GET /api/rooms

查询直播间列表。

**参数（Query）：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| status | string | 否 | 按状态筛选：`idle` / `recording` / `paused` |

**示例：**

```bash
curl http://127.0.0.1:1123/api/rooms
curl http://127.0.0.1:1123/api/rooms?status=recording
```

---

### POST /api/rooms

创建直播间。如果 `room_url` 已存在则自动更新（upsert）。

**请求体：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| room_url | string | 是 | 直播间地址（唯一标识） |
| room_name | string | 否 | 直播间名称 |
| filename_template | string | 否 | 文件名模板，默认 `{room_name}_{datetime}` |
| segment_duration | integer | 否 | 分段录制时长（秒）。0 或留空表示不分段，3600=每小时一个文件 |

**示例：**

```bash
curl -X POST http://127.0.0.1:1123/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"room_url": "https://live.example.com/room1", "room_name": "主播名"}'
```

---

### GET /api/rooms/:id

查询单个直播间详情。

---

### PUT /api/rooms/:id

更新直播间信息。

**请求体：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| room_name | string | 否 | 直播间名称 |
| filename_template | string | 否 | 文件名模板 |
| segment_duration | integer | 否 | 分段录制时长（秒） |

---

### DELETE /api/rooms/:id

删除直播间（仅限 `idle` 状态）。

---

## 录制控制

### POST /api/rooms/:id/pause

暂停录制（向 ffmpeg 进程发送 `SIGSTOP`）。

### POST /api/rooms/:id/resume

恢复录制（向 ffmpeg 进程发送 `SIGCONT`）。

### POST /api/rooms/:id/stop

停止录制（向 ffmpeg 进程发送 `SIGTERM`，标记录制结束）。

---

## 录制触发

### POST /api/notify/live_download

触发直播流录制。如果 `room_url` 对应的直播间不存在，会自动创建。

**请求体：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 直播流 URL（m3u8 / rtmp 等） |
| title | string | 是 | 直播标题（用于直播间名称） |
| caption | string | 否 | 直播描述/备注，存储到录制会话中 |
| room_url | string | 否 | 直播间地址。不传则用 `url` 作为标识 |

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

### GET /api/notify/status

查询直播间录制状态（轻量只读，不会创建房间）。

**参数（Query）：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 直播间地址（`room_url`） |

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
    "room": { "id": 1, "room_url": "https://live.example.com/room1", "room_name": "主播名" }
  }
}
```

**返回（录制中）：**

```json
{
  "exists": true,
  "data": {
    "status": "recording",
    "room": { "id": 1, "room_url": "https://live.example.com/room1", "room_name": "主播名" },
    "session": { "id": 42, "started_at": "2026-05-14T14:30:22.000Z" }
  }
}
```

**返回（不存在）：**

```json
{ "exists": false }
```

---

### GET /api/recording_files

查询录制文件跟踪记录。

**参数（Query）：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| status | string | 否 | 按状态筛选：`pending` / `recording` / `completed` / `interrupted` / `missing` / `orphaned` |
| session_id | integer | 否 | 按会话 ID 筛选 |

### PUT /api/recording_files/:id/associate

将孤文件（`orphaned`）关联到录制会话。

**请求体：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| session_id | integer | 是 | 目标录制会话 ID |

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

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| value | string | 是 | 设置值 |

**示例：**

```bash
curl -X PUT http://127.0.0.1:1123/api/settings/pool_size \
  -H 'Content-Type: application/json' \
  -d '{"value": "5"}'
```

---

## 文件名模板

默认模板：`{room_name}_{datetime}`

支持以下占位符：

| 占位符 | 说明 | 示例 |
|--------|------|------|
| `{room_name}` | 直播间名称 | `主播名` |
| `{datetime}` | `YYYYMMDD_HHmmss` | `20260514_143022` |
| `{YYYY}` | 年 | `2026` |
| `{MM}` | 月（补零） | `05` |
| `{DD}` | 日（补零） | `14` |
| `{HH}` | 时（补零，24h） | `14` |
| `{mm}` | 分（补零） | `30` |
| `{ss}` | 秒（补零） | `22` |

**自定义模板示例：**

```
主播名_{YYYY}-{MM}-{DD}_{HH}-{mm}-{ss}
```

**分段录制时**，文件名使用 strftime 格式，每个分片独立命名：

| 模板 | 第一段文件名 | 第二段文件名 |
|------|-------------|-------------|
| `{room_name}_{datetime}` | `KSG无言_20260514_143022.mp4` | `KSG无言_20260514_153022.mp4` |
| `{YYYY}-{MM}-{DD}_{HH}-{mm}-{ss}` | `2026-05-14_14-30-22.mp4` | `2026-05-14_15-30-22.mp4` |

不再使用序号 `_000` / `_001`，每个文件都有独立的时间戳。
