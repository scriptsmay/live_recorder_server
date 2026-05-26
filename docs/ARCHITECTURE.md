# 直播录制自动化流程架构

## 部署架构

项目支持两种正式部署方式：

| 方式   | 进程管理                   | 数据服务                        | 适用场景            |
| ------ | -------------------------- | ------------------------------- | ------------------- |
| PM2    | `pm2` 管理 `app.js`        | 外部 PostgreSQL / Redis         | 现有本地或 NAS 环境 |
| Docker | 容器直接运行 `node app.js` | Compose 编排 PostgreSQL / Redis | 新部署、迁移和回滚  |

Docker 架构：

```
                ┌────────────────────────────┐
                │        Docker Compose       │
                │                            │
Chrome 扩展 ───▶│ app: node app.js + ffmpeg  │──▶ /data/video_downloads
                │      + uv/biliup           │──▶ /data/biliup
                │             │              │──▶ /app/logs
                │             ├── postgres   │──▶ postgres_data
                │             └── redis      │──▶ redis_data
                └────────────────────────────┘
```

- Docker 推荐使用 `DATABASE_URL` 与 `REDIS_URL`，同时保留旧的拆分变量。
- `APP_DATA_DIR` 默认 `/data`，录制文件默认 `/data/video_downloads`。
- `BILIUP_WORK_DIR` 默认 `/data/biliup`，cookie 可放在
  `/data/biliup/cookies.json`。
- `/api/health` 用于 Docker healthcheck 和外部监控。

## 环境变量加载

环境变量统一由 `config/env.js` 初始化：

1. 先静默加载项目根目录 `.env`。
2. `NODE_ENV=development` 时再加载 `.env.dev`，并覆盖 `.env` 中同名配置。
3. 最后应用派生默认值：`APP_DATA_DIR`、`VIDEO_DOWNLOAD_DIR`、
   `BILIUP_WORK_DIR`，以及从 `DATABASE_URL` / `REDIS_URL` 拆分出的兼容变量。

应用入口、数据库连接、Redis 工具和维护脚本都应调用
`require('./config/env').initEnv()` 或按相对路径引入同一方法；不要在业务模块中直接
`require('dotenv').config()`。开发清理脚本固定以 development 模式调用该入口，确保使用
`.env.dev` 隔离配置。

## 整体流程

```
[Chrome 扩展 / 轮询检测]               [Server API]                 [FFmpeg]                [Transcode Queue]      [Upload]
     │                                       │                            │                         │                    │
     │  POST /notify/live_download           │     spawn pipe stderr      │                         │                    │
     │  (Chrome 扩展)                        │                            │                         │                    │
     │ ────────────────────────────────────>│───────────────────────────>│                         │                    │
     │                                       │   stderr tee ──→ log       │    持续写入 .part        │                    │
     │                                       │                            │<────────────────────────│                    │
     │                                       │                            │                         │                    │
     │  pollingManager                       │                            │                         │                    │
     │  (轮询检测到开播 → 自动调用)          │                            │                         │                    │
     │ ────────────────────────────────────>│                            │                         │                    │
     │                                       │                            │                         │                    │
     │                                       │   ─── 看门狗 (每 30s) ─── │                         │                    │
     │                               │   ① mtime 僵死检查         │                         │                    │
     │                               │   ② 同步 fs 扫描分片       │                         │                    │
     │                               │   ③ 碎片文件清理           │                         │                    │
     │                               │                            │                         │                    │
     │                               │   进程退出 (stop/崩溃/断流)│                         │                    │
     │                               │<───────────────────────────│                         │                    │
     │                               │   close handler            │                         │                    │
     │                               │   (exitCode 安全兜底)      │                         │                    │
     │                               │                            │                         │                    │
     │                               │   FLV分片入队 ─────────────────────────────────────>│                    │
     │                               │   findAndAutoUpload()       ─────────────────────────────────────────────>│
     │                               │                            │   异步转码 (并发3)      │   biliup upload    │
```

## 1. 会话生命周期

**会话的文件列表以 `recording_files` 表为唯一数据源**。`recordings` 表已废弃，数据已迁移到 `recording_files` 表。

```
                      ┌── 新录制请求 ──────────────────┐
                      │                                │
                      ▼                                │
              ┌──────────────┐                         │
              │  Session     │   在 delay 窗口内        │
              │  (recording) │◄────────────────────────┘
              │              │
              │  看门狗实时   │── 每 30s ──→ scanActiveSegments()
              │  追踪分片     │             写入 recording_files
              │              │
              │  GET /api    │── 会话详情直接查询 recording_files
              │  /sessions   │
              └──────┬───────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   completed    interrupted    recording
   (正常结束)   (异常中断)    (进行中)
```

### 状态定义

| 状态          | 含义     | 触发条件                                             |
| ------------- | -------- | ---------------------------------------------------- |
| `recording`   | 录制中   | POST /notify/live_download 成功                      |
| `completed`   | 正常完成 | close handler 收到 exit code 0                       |
| `interrupted` | 异常中断 | close handler 收到非 0 退出码 / SIGTERM / 看门狗清理 |

### 延迟续播

- 读取 `settings.delay`（默认 60 秒）
- 新录制请求时查询最近一次会话 `ended_at > NOW() - delay`
- 匹配 `status IN ('completed', 'interrupted')`
- 复用会话 ID，不清 zero totals，close handler 累加
- **注意**：续播不 append 到旧文件。FLV/MP4 容器无文件级 append 机制，每次启动录制均使用文件名模板生成新文件。

---

## 2. 文件追踪

### 文件路径结构

录制文件采用层级目录结构存储：

```
VIDEO_DOWNLOAD_DIR/
├── [roomId]/                    # 房间ID目录
│   ├── [sessionId]/             # 会话ID目录
│   │   ├── {room_name}_{datetime}.ts      # 非分段录制
│   │   └── {room_name}_%Y%m%d_%H%M%S.ts  # 分段录制
```

- 录制输出固定为 TS 格式(经 ffmpeg 录制)，容错性更强
- 转码后输出 MP4 格式(通过 TranscodeQueue 异步处理)
- 续播时（非分段 + delay 内）复用上一次的 outputFilePattern

**优势**：

- 避免文件名冲突：每个会话有独立的目录
- 便于管理：按房间和会话组织文件
- 扫描效率提升：看门狗可以只扫描特定会话目录
- 投稿简化：直接从会话目录获取文件

### recording_files 表状态流转

```
                 ┌──────────────┐
     未跟踪      │  (无记录)    │
     磁盘扫描    └──────┬───────┘
         发现新文件      │ 活跃录制目录？
          │         ┌───┴───┐
          │  是     │  否   │
          │         │       │
          ▼         ▼       ▼
    (跳过, wait   orphaned  ──→ close handler 或
      close handler)             启动清理时追踪
```

### 分片追踪时序

```
FFmpeg 写入分段文件(.flv)
        │
        │  分段边界(segment)
        │  直接输出 .flv
        │
        ▼
  [1] scanActiveSegments (看门狗 30s 周期)
      → 发现新 .flv，写入 recording_files (completed)
      → 更新 session total_segments + 1

  [2] close handler (进程退出时)
      → 扫描目录
      → 跳过已在 recording_files 中的文件
      → 处理剩余未追踪文件
      → FLV文件逐个入队 TranscodeQueue
      → 更新 session 状态

  [3] TranscodeQueue (异步转码)
      → 从 Redis 队列取出任务(并发3)
      → ffmpeg -i input.flv -c copy output.mp4
      → 更新 recording_files 表路径
      → 删除原 FLV 文件(如果配置了 transcode_delete_originals=true)
```

**注意**：FFmpeg 在收到 SIGTERM 时会正常关闭分段文件。rooms.js stop 处理和启动清理包含 `.part` 文件的兜底重命名。

### 文件扫描 (scanRecordingFiles)

- 支持强制扫描和冷却（5 分钟冷却）
- 遍历 VIDEO_DOWNLOAD_DIR，匹配 `\\.(mp4|flv|ts|mkv|avi|mov)$`
- 跳过活跃录制房间（`status = 'recording'`）的输出目录下的文件
- 未追踪文件 → `orphaned`
- DB 有但磁盘无 → `missing`

---

## 3. 下载引擎

### FFmpegDownloader (唯一引擎)

- spawn `ffmpeg` 子进程，`stdio: ['ignore', 'ignore', 'pipe']`, `detached: false`
- 参数：`-c copy -fflags +genpts+igndts+discardcorrupt -reconnect ...`
- 分段模式：`-f segment -segment_time N -segment_format mpegts`
- 扩展名：`.ts` (录制输出，容错性更强) → `.mp4` (转码后)
- 停止信号：SIGTERM → 进程正常退出 → close handler
- stderr pipe → 上层 tee 到日志文件
- 支持网络重连：`-reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1`
- 用户代理伪装：避免被 CDN 403 拦截
- 协议白名单：`-protocol_whitelist rtmp,crypto,file,http,https,tcp,tls,udp,rtp,httpproxy`

---

## 4. 流式转码架构

### TranscodeQueue (`lib/core/TranscodeQueue.js`)

**设计理念**: 将集中式转码改为异步队列处理,结合边下边转码,最大化分散CPU压力,提升用户体验。

**工作流程**:

```
[FFmpeg 录制中]                          [转码流程]
     │                                      │
     │  新分段打开 (stderr 日志)             │
     │  [segment @ ...] Opening 'x.flv'     │
     │─────────────────────────────────────>│
     │                                      │
     │  当前正在写入 segment 2.flv          │
     │  (上一个 segment 1.flv 已完成)      │
     │                                      │
     │  ───────────────────────────────────>│  segment 1.flv 入队
     │                                      │  TranscodeQueue.processQueue()
     │  segment 3.flv 打开...               │  ├─ 检查并发数
     │─────────────────────────────────────>│  ├─ 取出任务
     │                                      │  ├─ ffmpeg -i 1.flv -c copy 1.mp4
     │                                      │  ├─ 更新 DB 路径
     │  ... 继续录制...                    │  └─ 删除原文件
     │                                      │
     │  录制结束                            │
     │─────────────────────────────────────>│  最后一个分段入队
     │  finishSession 兜底                  │
```

**关键特性**:

- **边下边转码**: 监听 FFmpeg stderr 日志,新分段打开时入队上一个已完成的分段,避免对正在写入文件的错误处理
- **Redis队列**: 使用 `transcode_queue` List存储任务,支持服务重启后恢复
- **并发控制**: 通过 `transcode_concurrency` 设置(默认3),使用Redis计数器 `transcode_processing_count` 跟踪
- **异步处理**: 在主进程内非阻塞执行,不阻塞录制和API响应
- **智能去重**: `finishSession` 中会跳过已通过边下边转码处理过的文件,避免重复入队
- **双重保障**: 边下边转码为主,`finishSession` 批量处理为兜底,确保无遗漏
- **错误容忍**: 单个分片转码失败不影响其他分片

**配置项**:

| 设置项                       | 默认值 | 说明                 |
| ---------------------------- | ------ | -------------------- |
| `auto_transcode`             | `true` | 是否启用自动转码     |
| `transcode_concurrency`      | `3`    | 转码并发数           |
| `transcode_delete_originals` | `true` | 转码后是否删除原文件 |

**监控API** (可选扩展):

```javascript
// 获取队列长度
await transcodeQueue.getQueueLength();

// 获取当前处理中任务数
await transcodeQueue.getCurrentProcessingCount();
```

**收益对比**:

| 指标          | 旧方案(集中转码)      | 新方案(边下边转码)     |
| ------------- | --------------------- | ---------------------- |
| 4小时直播转码 | 8-20分钟(集中处理)    | 录制期间并行完成       |
| CPU峰值       | 高(一次性转码240分片) | 低(并发3,持续均衡处理) |
| 用户体验      | 录制结束后需等待      | 立即可操作已完成分段   |
| 失败影响      | 一个失败整体失败      | 单个失败不影响其他     |

**日志输出**:

- `[分段录制] 检测到新分段: ...` - 新分段文件打开
- `[边下边转码] 入队: ... → ...` - 已完成的分段入队转码
- `[finishSession] 入队转码: ... → ...` - 最后一个分段入队

---

## 5. 看门狗 (`lib/watchdog.js`)

看门狗是独立模块，单实例运行。职责边界如下：

### 运行周期

- `watchdog.start()` → 100ms 后首次执行 → 之后每 `watchdog_interval`（默认 30s）循环
- 最少 10 秒，防止设置错误
- 同一时间只有 1 个定时器在跑（模块级 `watchdogTimer` 变量控制）

### 属于看门狗（`lib/watchdog.js`）

| 函数                      | 触发        | 职责                                                                   |
| ------------------------- | ----------- | ---------------------------------------------------------------------- |
| `checkStaleRecordings()`  | 每周期      | 检查进程是否存活 + mtime 文件僵死检查，清理死录制                      |
| `scanActiveSegments()`    | 每周期      | 追踪已完成的分段（mtime 稳定 2 分钟以上才标记 `completed`）            |
| `cleanupFragmentFiles()`  | 每周期      | 同步 fs 遍历下载目录，删除小于阈值的碎片文件                           |
| `syncMissingFiles()`      | 每周期      | 检测 DB 中有但磁盘已删除的文件 → 标记 `missing`                        |
| `scanPendingAutoUpload()` | 每周期      | 已完成且转码就绪的会话，按直播间模板尝试自动投稿（见 `UploadService`） |
| `runFileScan()`           | 启动 + 手动 | 调用 `scanRecordingFiles()` 扫描下载目录，标记孤文件 / 缺失文件        |

### 不属于看门狗（但在 `app.js` 启动时通过 `lifecycle.js` 运行）

| 函数                       | 所在文件                | 触发       | 职责                                                       |
| -------------------------- | ----------------------- | ---------- | ---------------------------------------------------------- |
| `cleanupStaleRecordings()` | `lib/core/lifecycle.js` | 启动       | 重命名 `.part`、追踪遗留文件、尝试恢复会话                 |
| `cleanupStaleRedis()`      | `lib/core/lifecycle.js` | 启动       | 清理 Redis 过期 `active_task:*`                            |
| `scanRecordingFiles()`     | `lib/scan-files.js`     | 启动 / API | 同步 fs 遍历下载目录，`watchdog.runFileScan()` 和 API 共用 |

### 周期性执行链

```
watchdog.start()
  └─ setTimeout(runWatchdog, 100)
       ├─ checkStaleRecordings()    ← mtime 僵死检查
       ├─ scanActiveSegments()      ← 追踪已完成分段（含 2 分钟稳定期）
       ├─ cleanupFragmentFiles()    ← 同步 fs 清理
       ├─ syncMissingFiles()        ← 检测被删除文件
       ├─ scanPendingAutoUpload()  ← 转码完成后自动投稿
       └─ setTimeout(runWatchdog, interval)  ← 下次周期
```

### 启动时执行链（非周期）

```
app.js
  └─ bootstrap()
       ├─ migrate()                      ← DB 迁移（死锁自动重试 3 次）
       ├─ cleanupStaleRedis()             ← 清理 Redis 过期 active_task
       ├─ cleanupStaleRecordings()        ← 重命名 .part、恢复会话
       ├─ transcodeQueue.init()           ← 初始化转码队列(加载并发配置)
       ├─ watchdog.start()                ← 启动看门狗
       └─ pollingManager.start()          ← 启动轮询管理器(加载 polling_enabled 房间)
```

### checkStaleRecordings()

1. **进程存活检查**：`process.kill(pid, 0)`
2. **文件僵死检查**：
   - 分段模式：取输出目录下所有 `.mp4`/`.flv`/`.part` 文件的最新 mtime
   - 非分段模式：取 `output_path` 的 mtime
   - 超过 `watchdog_timeout`（默认 60 秒）无变更 → 僵死
3. **清理条件**：进程死亡 或 文件僵死
4. **清理动作**：
   - 杀死进程（SIGTERM → 5s → SIGKILL）
   - 房间设为 idle，清理 Redis room/active_task cache
   - 会话标为 interrupted，recording_files 标为 interrupted

### scanActiveSegments()

- 同步 `fs.readdirSync` + `fs.statSync` 扫描所有活跃录制房间的输出目录
- 发现未追踪的 `.flv`/`.mp4` → 写入 recording_files + 更新 session 合计
- **mtime 稳定期**：文件最近 2 分钟内有修改则跳过（防止标记还在写入的当前分段）
- 小于 `filtering_threshold` 的碎片跳过不追踪

### cleanupFragmentFiles()

- 同步 `fs.readdirSync` + `fs.statSync` 扫描整个 `VIDEO_DOWNLOAD_DIR`
- 找到小于 `filtering_threshold` 的 `.flv`/`.mp4` 文件
- 跳过创建不足 2 分钟的新文件（防止误删刚完成的分片），跳过刚由 `.part` 重命名而来的文件
- 删除磁盘文件 + 关联的 `recording_files` 记录
- 更新 session 合计

### syncMissingFiles()

- 查询 `recording_files` 中所有非 `missing`/`deleted` 状态的记录
- 逐个检查磁盘文件是否存在
- 不存在的文件更新为 `status = 'missing'`
- 配合 `cleanupFragmentFiles` 和手动删除文件后自动标记

---

## 6. 直播轮询（Polling）

`lib/core/polling/`

策略模式实现的多平台开播检测与自动录制系统。

### 架构

```
PollingManager (单例)
├── CHECKERS 注册表
│   ├── huya  → HuyaChecker  (mp.huya.com/cache.php)
│   ├── douyu → (待实现)
│   └── ...
└── timers 调度表
    └── room:{id} → setInterval(pollRoom, interval)
```

### PlatformChecker 基类

| 方法                       | 说明                                               |
| -------------------------- | -------------------------------------------------- |
| `static getPlatformId()`   | 平台标识符，如 `'huya'`                            |
| `static canHandleUrl(url)` | 判断 URL 是否属于本平台                            |
| `async checkStatus()`      | 返回 `{ isLive, roomName, roomTitle, streamInfo }` |

### HuyaChecker 实现要点

- 通过虎牙移动 API `mp.huya.com/cache.php` 查询
- 自动解析短房间号（字符串 ID → 数字 ID）
- 流地址构建：`{sFlvUrl}/{streamName}.{sFlvUrlSuffix}?{sFlvAntiCode}`
- **去掉 `-imgplus`**：移动端 anticode 会导致 ffmpeg ~6 秒断连

### 轮询流程

```
app.js
  └─ bootstrap()
       └─ pollingManager.start()
            └─ loadPollingRooms()                       # DB: polling_enabled=true
                 └─ pollRoom(room) × N                   # 仅检查1次，无定时器

router/rooms.js (新增/修改房间)
  └─ pollingManager.reloadRoom(roomId)
       └─ startRoomPolling(room)
            ├─ pollRoom(room)                       # 首次立即执行（0~5s jitter）
            │    └─ checkRoom(room)
            │         ├─ PlatformChecker.checkStatus()   # 平台 API
            │         ├─ 状态转换检测 (wasLive→isLive)
            │         ├─ Redis SET (TTL=interval×2)      # 瞬时状态缓存
            │         └─ _tryStartRecording()             # 开播触发录制
            └─ setInterval(pollRoom, intervalMs)          # 定时轮询
```

**说明**：

- 启动时只检查1次状态，不设定时器
- 新增或修改房间时由 `reloadRoom()` 控制定时轮询

### 数据存储策略

| 数据                | 存储                    | 原因         |
| ------------------- | ----------------------- | ------------ |
| 直播状态 / 轮询时间 | Redis，TTL=`interval*2` | 瞬时数据     |
| 房间配置            | DB `rooms` 表           | 持久配置     |
| room_name           | DB，仅在首次为空时填充  | 用户可自定义 |

### 安全机制

- **停止 → 关监听**：`POST /api/rooms/:id/stop` 自动 `monitoring_enabled=false`
- **状态转换判定**：仅 `!wasLive && isLive` 触发录制
- **防重复**：`RecorderService.startRecording()` 有 Redis `active_task` 保护
- **jitter**：0~5s 随机延迟防惊群

### 扩展新平台

1. 继承 `PlatformChecker` 实现三个接口方法
2. 注册到 `PollingManager.CHECKERS`
3. 前端 `detectPlatform()` 添加 URL 规则

---

## 7. 启动清理 (cleanupStaleRecordings)

在 `startup()` 中运行，按顺序：

1. **处理 .part 残留**：遍历脏房间输出目录，重命名 `.part` → `.flv`
2. **追踪遗留文件**：将 untracked 的 `.flv`/`.mp4` 写入 `recording_files`
3. **房间复位**：`status = 'idle'`, `ffmpeg_pid = NULL`, `output_path = ''`
4. **尝试恢复会话**：对 `status='recording'` 的会话调用 `tryResumeSession`（最多 3 次）
5. **标记录制中断**：`recording_files` 中 `status='recording'` 的标为 `interrupted`

---

## 8. 投稿流程

### 触发

- 录制完成自动触发（`findAndAutoUpload`，仅当直播间已配置 `upload_template_id`）
- 手动触发（POST /api/sessions/:id/upload）
- 受 `max_upload_limit` Redis INCR 持久化计数限制（`upload_count:{sessionId}`，24h 过期）

### 模板

- `upload_templates` 表存储投稿参数
- 支持变量替换：`{room_name}` `{date}` `{datetime}` 等
- 投稿后处理：`none` / `backup` / `delete` / `backup_and_delete`
- Docker 部署可仅依赖 volume 持久化录制文件；未配置 `NAS_*` 时，
  `backup` / `backup_and_delete` 会返回 `skipped`，且不会执行本地删除。

### 通知

- 通知通道：飞书 webhook、Gotify。
- 未配置通知参数时静默跳过对应通道。
- Gotify 使用 `MESSAGE_GOTIFY_SERVER`、`MESSAGE_GOTIFY_TOKEN`、
  `MESSAGE_GOTIFY_PRIORITY`。

### 执行

- 调用 `biliup upload` 子进程
- 输出记录到 `upload_records` 表
- 解析 BV 号（正则 `/BV[0-9A-Za-z]{10}/`），关联到投稿记录

---

## 9. 边界情况与容错

| 场景                                 | 处理方式                                               |
| ------------------------------------ | ------------------------------------------------------ |
| 进程收到 SIGTERM 后 Rust Drop 不执行 | rooms.js stop 同步扫描 + 重命名 .part                  |
| 看门狗误杀正在写 .part 的进程        | mtime 检查包含 .part 文件                              |
| 文件扫描发现活跃录制中的文件         | 跳过该目录，由 close handler 追踪                      |
| 录制中途服务器重启                   | startup 清理 + 尝试恢复会话                            |
| 并发录制超过池大小                   | HTTP 429 "Pool full"                                   |
| Redis 残留 active_task               | cleanupStaleRedis 启动时清理                           |
| DB 重复 recording_files              | UNIQUE(file_path) 约束 + ON CONFLICT DO NOTHING        |
| stream URL 失效/过期                 | ffmpeg 重连机制自动处理（reconnect_streamed）          |
| 磁盘空间不足                         | checkDiskSpace() 设 disk:critical，暂停新录制          |
| 上传限流重启丢失                     | Redis INCR 持久化 + 24h 过期                           |
| 轮询检测到开播但 ffmpeg 断连         | 去掉 `-imgplus` 绕过移动端平台检测；reconnect 自动重连 |
| 重启时轮询状态与直播一致无法触发录制 | 启动时从 Redis/DB 加载 last_live_status 做状态对比     |
| 手动停止后被轮询二次触发录制         | stop 自动将 monitoring_enabled 设为 false              |
