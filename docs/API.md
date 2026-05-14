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
| title | string | 是 | 直播标题 |
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
    "filename": "主播名_20260514_143022.mp4",
    "path": "/data/videos/主播名_20260514_143022.mp4"
  }
}
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
