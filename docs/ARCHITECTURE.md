# 直播录制自动化流程架构

## 部署架构

项目支持两种正式部署方式：

| 方式   | 进程管理                          | 数据服务                        | 适用场景            |
| ------ | --------------------------------- | ------------------------------- | ------------------- |
| PM2    | `pm2` 管理 `server/app.js`        | 外部 PostgreSQL / Redis         | 现有本地或 NAS 环境 |
| Docker | 容器直接运行 `node server/app.js` | Compose 编排 PostgreSQL / Redis | 新部署、迁移和回滚  |

Docker 架构：

```text
                ┌────────────────────────────┐
                │        Docker Compose       │
                │                            │
Chrome 扩展 ───▶│ app: node server/app.js + ffmpeg │──▶ /data/video_downloads
                │      + uv/biliup           │──▶ /data/biliup
                │             │              │──▶ /app/logs
                │             ├── postgres   │──▶ postgres_data
                │             └── redis      │──▶ redis_data
                └────────────────────────────┘
```

- Docker 推荐使用 `DATABASE_URL` 与 `REDIS_URL`，同时保留旧的拆分变量。
- `APP_DATA_DIR` 默认 `/data`，录制文件默认 `/data/video_downloads`，回放工作目录默认 `/data/replay`。
- `BILIUP_WORK_DIR` 默认 `/data/biliup`，cookie 可放在
  `/data/biliup/cookies.json`。
- `/api/health` 用于 Docker healthcheck 和外部监控。

## 环境变量加载

环境变量统一由 `server/config/env.js` 初始化：

1. 先静默加载项目根目录 `.env`。
2. `NODE_ENV=development` 时再加载 `.env.dev`，并覆盖 `.env` 中同名配置。
3. 最后应用派生默认值：`APP_DATA_DIR`、`VIDEO_DOWNLOAD_DIR`、
   `REPLAY_WORK_DIR`、`BILIUP_WORK_DIR`，以及从 `DATABASE_URL` / `REDIS_URL` 拆分出的兼容变量。

应用入口、数据库连接、Redis 工具和维护脚本都应调用
`require('./server/config/env').initEnv()` 或按相对路径引入同一方法；不要在业务模块中直接
`require('dotenv').config()`。开发清理脚本固定以 development 模式调用该入口，确保使用
`.env.dev` 隔离配置。

## 整体流程

```text
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

### 弹幕数据流（Chrome 扩展 → 后端）

Chrome 扩展在快手直播间页面注入 `inject.js` 拦截 WebSocket 弹幕，经 `content.js` 转发给 `background.js`，批量推送到后端 `POST /api/danmaku/batch`。**扩展侧弹幕发送与后端录制状态联动**：仅在录制中时才推送弹幕数据，未录制时事件保留在内存缓冲区（上限 5000 条）。

```text
[Chrome Extension]                                                    [Server]
     │                                                                    │
     │  inject.js hook WebSocket → 弹幕事件                               │
     │  ──────────────────────────>│ content.js (5s 缓冲)                 │
     │                              │                                     │
     │  danmakuReady                │ background.js                       │
     │  (会话创建, isSending=false) │                                     │
     │                              │                                     │
     │  GET /api/notify/status      │  检查录制状态 (立即 + 每10s)        │
     │  ──────────────────────────────────────────────────────────────────>│
     │                              │  ◄── recording ──                   │
     │                              │  isSending=true                     │
     │                              │                                     │
     │  POST /api/danmaku/batch     │  每 5s flush（仅 isSending=true）   │
     │  ──────────────────────────────────────────────────────────────────>│
     │                              │                                     │  DanmakuRecorder
     │                              │                                     │  → VIDEO_DOWNLOAD_DIR/danmaku/[sessionId].jsonl
     │  录制结束 → flush → 停止发送 │                                     │
```

### 弹幕服务端处理流程

弹幕压制（ASS 生成 + 硬字幕烧录）已于 v1.7.0 迁出至独立的 [danmaku-tool](https://github.com/scriptsmay/danmaku-tool) 项目。本服务只负责**弹幕采集与查询**，录制结束后不再做任何字幕生成。

```text
录制会话结束
    │
    ▼
_handleDanmakuFinish()
    │
    ├── DanmakuRecorder.stopCapture()   停止采集，返回 captureId / eventCount
    └── 更新 danmaku_capture_records     status → completed，写入 ended_at / event_count

弹幕数据的后续消费
    │
    ├── GET /api/danmaku/search              搜索 JSONL 内容
    ├── GET /api/sessions/:id/danmaku-page   会话弹幕详情
    ├── GET /api/danmaku/sessions/:id/raw    下载原始 JSONL
    └── danmaku-tool（外部项目）              批量压制，直接读取 JSONL 路径
```

**目录结构**：

```text
VIDEO_DOWNLOAD_DIR/
  ├── danmaku/                          ← 弹幕数据集中目录（v1.8.0）
  │   └── [sessionId].jsonl             ← 弹幕原始数据（JSONL，扁平命名）
  └── [sessionId]/
      └── *.mp4 / *.ts                  ← 录制分段（纯净）
```

**关键设计决策**：

- 弹幕采集与录制流程完全解耦，录制模块只负责「采集 + 落 JSONL」
- 新录制目录结构为 `VIDEO_DOWNLOAD_DIR/[sessionId]/`；历史的 `VIDEO_DOWNLOAD_DIR/[roomId]/[sessionId]/` 不迁移，继续通过 `recording_sessions.output_dir` 兼容读取
- 弹幕 JSONL 集中扁平存放于 `VIDEO_DOWNLOAD_DIR/danmaku/[sessionId].jsonl`（v1.8.0）；路径由 `server/lib/utils/tool.js` 的 `getDanmakuJsonlPath(sessionId)` 唯一推导，读取与写入均走该函数，不再兼容会话子目录旧路径（历史数据由 `scripts/migrate-danmaku-paths.js` 一次性迁移）
- **danmaku-tool 的批量压制直接依赖上述 JSONL 路径**，本服务变更弹幕路径时必须同步改造 danmaku-tool（见知识库 ADR-011）
- 已于 v1.8.0 DROP：`danmaku_burn_records`、`danmaku_free_burn_records` 表与 `recording_files.danmaku_ass_path`、`danmaku_capture_records.ass_path` 列；废弃环境变量 `DANMAKU_OUTPUT_DIR` 一并移除。`DANMAKU_ARCHIVE_DIR` 未废弃 —— 仍在生产挂载（`/data/danmaku_archive`），file-manage 以 `file_type=danmaku_archive` 索引归档文件并标记不可自动清理

## 1. 会话生命周期

**会话的文件列表以 `recording_files` 表为唯一数据源**。`recordings` 表已废弃，数据已迁移到 `recording_files` 表。

```text
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

```text
VIDEO_DOWNLOAD_DIR/
├── danmaku/                     # 弹幕 JSONL 集中目录（v1.8.0，扫描时跳过）
│   └── [sessionId].jsonl        # 弹幕原始数据（扁平命名）
├── [sessionId]/                 # 会话ID目录（新结构）
│   ├── {room_name}_{datetime}.ts      # 非分段录制
│   └── {room_name}_%Y%m%d_%H%M%S.ts  # 分段录制
```

历史录制可能仍位于 `VIDEO_DOWNLOAD_DIR/[roomId]/[sessionId]/`。代码不得再从 `room_id` 推导历史路径，应始终以 `recording_sessions.output_dir` 和 `recording_files.file_path` 为准。

- 录制输出固定为 TS 格式(经 ffmpeg 录制)，容错性更强
- 转码后输出 MP4 格式(通过 TranscodeQueue 异步处理)
- 续播时（非分段 + delay 内）复用上一次的 outputFilePattern

**优势**：

- 避免文件名冲突：每个会话有独立的目录
- 目录更浅：会话 ID 全局唯一，去掉 roomId 层不会引入覆盖风险
- 便于管理：文件管理、投稿、弹幕数据都直接围绕 session 组织
- 扫描效率提升：看门狗可以只扫描特定会话目录
- 投稿简化：直接从会话目录获取文件

### recording_files 表状态流转

```text
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

### HLS 生命周期与保留期清理

HLS 使用独立于原始录制文件 `status` 的 `recording_files.hls_status`：

```text
pending -> generating -> ready -> deleting -> expired / deleted
                         -> missing
generating -> failed
```

- 看门狗仅为 `pending` 自动生成；播放列表意外缺失时标记 `missing`，不自动重建。
- 手动生成可将 `expired`、`deleted`、`missing`、`failed` 恢复为 `ready`。
- `HLSCleanupService` 在启动 5 分钟后首次运行，之后每 24 小时读取一次
  `hls_cleanup_days`；`0` 表示禁用，且不受 `file_cleanup_enabled` 控制。
- 用户删除和保留期删除使用同一服务：advisory lock → `deleting` → 递归统计大小 →
  删除目录 → 事务同步 `recording_files`、`managed_files` 和审计日志。
- 每个录制分段的 HLS 目录独立索引，`managed_files.source_id` 精确指向
  `recording_files.id`，同一会话可对应多条 HLS 记录。

### 文件自动清理与空目录回收

- `FileCleanupScheduler` 每日扫描文件索引并执行可安全删除文件的保留期规则。
- `file_cleanup_empty_dirs_enabled` 是独立开关；开启后同一调度周期自底向上扫描
  `VIDEO_DOWNLOAD_DIR` 和 `REPLAY_WORK_DIR`，只用非递归 `rmdir` 回收空目录，不会连带开启视频文件删除。
- 清理服务保护录制中的会话、HLS 生命周期目录和非终态回放工作目录；符号链接、根目录、
  非空目录和竞争写入目录均跳过。成功、跳过和失败结果写入 `file_delete_audit_logs`。
- 文件管理删除单个文件成功后会尝试回收其父目录；回收失败不回滚文件删除。

### 分片追踪时序

```text
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
- 用户代理伪装：通过 `server/lib/core/config/userAgents.js` 配置化，避免被 CDN 403 拦截
- 协议白名单：`-protocol_whitelist rtmp,crypto,file,http,https,tcp,tls,udp,rtp,httpproxy`
- **流类型自动检测**：支持 FLV 和 HLS/m3u8 两种流格式
  - URL 特征检测（`.m3u8`、`.flv`、`/hls/`、`/flv/` 路径）
  - HTTP 头检测（Content-Type + 响应体 `#EXTM3U` 标记）
  - `detectStreamType(url)` 异步方法供外部预检
  - `buildArgs()` 根据 `streamType` 选项选择参数策略
- **HLS 专用参数**：更长超时（60s）、`-live_start_index -1`、`-avoid_negative_ts make_zero`、协议白名单含 `hls`

---

## 4. 流式转码架构

### TranscodeQueue (`server/lib/core/TranscodeQueue.js`)

**设计理念**: 将集中式转码改为异步队列处理,结合边下边转码,最大化分散CPU压力,提升用户体验。

**工作流程**:

```text
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

## 5. 看门狗 (`server/lib/core/watchdog.js`)

看门狗是独立模块，单实例运行。职责边界如下：

### 运行周期

- `watchdog.start()` → 100ms 后首次执行 → 之后每 `watchdog_interval`（默认 30s）循环
- 最少 10 秒，防止设置错误
- 同一时间只有 1 个定时器在跑（模块级 `watchdogTimer` 变量控制）

### 属于看门狗（`server/lib/core/watchdog.js`）

| 函数                      | 触发        | 职责                                                                   |
| ------------------------- | ----------- | ---------------------------------------------------------------------- |
| `checkStaleRecordings()`  | 每周期      | 检查进程是否存活 + mtime 文件僵死检查，清理死录制                      |
| `scanActiveSegments()`    | 每周期      | 追踪已完成的分段（mtime 稳定 2 分钟以上才标记 `completed`）            |
| `cleanupFragmentFiles()`  | 每周期      | 同步 fs 遍历下载目录，删除小于阈值的碎片文件                           |
| `syncMissingFiles()`      | 每周期      | 检测 DB 中有但磁盘已删除的文件 → 标记 `missing`                        |
| `scanPendingAutoUpload()` | 每周期      | 已完成且转码就绪的会话，按直播间模板尝试自动投稿（见 `UploadService`） |
| `runFileScan()`           | 启动 + 手动 | 调用 `scanRecordingFiles()` 扫描下载目录，标记孤文件 / 缺失文件        |

### 不属于看门狗（但在 `server/app.js` 启动时通过 `lifecycle.js` 运行）

| 函数                       | 所在文件                       | 触发       | 职责                                                       |
| -------------------------- | ------------------------------ | ---------- | ---------------------------------------------------------- |
| `cleanupStaleRecordings()` | `server/lib/core/lifecycle.js` | 启动       | 重命名 `.part`、追踪遗留文件、尝试恢复会话                 |
| `cleanupStaleRedis()`      | `server/lib/core/lifecycle.js` | 启动       | 清理 Redis 过期 `active_task:*`                            |
| `scanRecordingFiles()`     | `server/lib/scan-files.js`     | 启动 / API | 同步 fs 遍历下载目录，`watchdog.runFileScan()` 和 API 共用 |

### 周期性执行链

```text
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

```text
server/app.js
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

`server/lib/core/polling/`

策略模式实现的多平台开播检测与自动录制系统。

### 架构

```text
PollingManager (单例)
├── CHECKERS 注册表
│   ├── huya     → HuyaChecker     (mp.huya.com/cache.php)
│   ├── bilibili → BilibiliChecker (api.live.bilibili.com)
│   ├── douyu    → DouyuChecker    (playweb.douyucdn.cn/hlsH5Preview) [不可用 - 平台流2分钟超时]
│   │                          signers/douyu.js (完整签名 + 单飞机制)
│   │                          signers/douyu-vip.js (VIP房间 JS 签名)
│   ├── douyin   → DouyinChecker   (webcast/room/web/enter + HTML 降级)
│   └── kuaishou → KuaishouAPIChecker (live_api/liveroom/livedetail + profile/public)
└── timers 调度表
    └── room:{id} → setInterval(pollRoom, interval)
```

### PlatformChecker 基类

| 方法                              | 说明                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `static getPlatformId()`          | 平台标识符，如 `'huya'`                                                          |
| `static canHandleUrl(url)`        | 判断 URL 是否属于本平台                                                          |
| `static fetchJson()`              | 统一 HTTP GET 请求（JSON，含超时、UA、错误处理）                                 |
| `static fetchText()`              | 统一 HTTP GET 请求（Text，用于 HTML 解析）                                       |
| `static normalizeResult()`        | 补齐默认字段，返回统一格式                                                       |
| `static extractLastPathSegment()` | 提取 URL 路径最后一段（房间号）                                                  |
| `async checkStatus()`             | 返回 `{ isLive, recordable, roomName, roomTitle, streamUrl, streamInfo, error }` |

### 统一返回规范

| 字段         | 必填 | 说明                                                       |
| ------------ | ---- | ---------------------------------------------------------- |
| `isLive`     | 是   | 是否开播（主播正在直播）                                   |
| `recordable` | 否   | 是否可录制，默认 `true`；设为 `false` 表示开播但无法获取流 |
| `roomName`   | 否   | 主播名或房间名                                             |
| `roomTitle`  | 否   | 直播标题                                                   |
| `roomCover`  | 否   | 封面地址                                                   |
| `streamUrl`  | 否   | FFmpeg 可录制地址；不可录制时返回 `null`                   |
| `streamInfo` | 否   | 平台、画质、CDN、原始接口字段摘要                          |
| `error`      | 否   | 非致命错误说明（如签名失败、不可录制类型）                 |

### HuyaChecker 实现要点

- 通过虎牙移动 API `mp.huya.com/cache.php` 查询
- 自动解析短房间号（字符串 ID → 数字 ID）
- 流地址构建：`{sFlvUrl}/{streamName}.{sFlvUrlSuffix}?{sFlvAntiCode}`
- **去掉 `-imgplus`**：移动端 anticode 会导致 ffmpeg ~6 秒断连

### BilibiliChecker 实现要点

- 通过 B站 公开 API 查询，无需登录
- API 调用顺序：`room_init` → `Master/info` → `getH5InfoByRoom` → `playUrl`
- 自动处理短房间号映射（通过 `room_init` 返回真实 room_id）
- 流地址优先选择 FLV，无 FLV 时使用 HLS
- 回退到 `getRoomPlayInfo` V2 接口获取更完整的流信息

### DouyuChecker 实现要点

- 通过斗鱼 betard API 查询房间状态，hlsH5Preview API 获取流地址
- **完整签名算法** (`signers/douyu.js`)：从 `getEncryption` 接口获取密钥，MD5 迭代生成签名
- **单飞机制**：密钥缓存（5分钟 TTL）+ 并发请求合并，避免 Thundering Herd
- **VIP 房间支持** (`signers/douyu-vip.js`)：通过 `vm` 模块执行 JS 签名代码（`ub98484234()`）
- **CDN 自动选择**：检测到 scdn 时自动切换到可用 CDN
- **互动游戏检测**：可选启用，通过 interactive API 排除非直播内容
- **画质选择**：支持 `rate` 参数选择画质等级
- **流格式检测**：自动判断 HLS (m3u8) 或 FLV 格式

### KuaishouAPIChecker 实现要点

- HTTP API 直连，不依赖浏览器：`live_api/liveroom/livedetail` 为主，失败时回退 `live_api/profile/public`。
- `POLLING_KUAISHOU_COOKIE` 作为快手直播轮询和回放工具箱共享的访问态 cookie。
- 超时可通过 `KUAISHOU_API_TIMEOUT_MS` 调整（默认 15000）；房间/平台轮询间隔与 backoff 使用系统常量，不暴露为用户配置。
- 房间名为空时回退抓取 `/u/{principalId}` 页面 title，结果缓存到 Redis（TTL 24h）。
- 风控、验证码、`请求过快`、`400002` 均视为未知状态并抛错，不写成 `isLive=false`。
- FLV 选择优先 H.264，缺失时 fallback 到 HEVC/H.265。
- 快手平台级并发固定为 1；跨房间通过 Redis `kuaishou:checker:platform_lock` 和 `kuaishou:checker:platform_last_poll` 串行限速。
- 任一房间触发风控后写入房间 backoff 和平台级 backoff，保留上一轮 Redis 直播状态。

> v1.8.3 起浏览器版 `KuaishouChecker`（Browserless + `__INITIAL_STATE__`）已移除，快手仅保留 API 直连。`RemoteBrowserClient` 仍保留，供回放 m3u8 提取使用。

### 轮询流程

```text
server/app.js
  └─ bootstrap()
       └─ pollingManager.start()
            └─ loadPollingRooms()                       # DB: polling_enabled=true
                 └─ pollRoom(room) × N                   # 仅检查1次，无定时器

server/router/rooms.js (新增/修改房间)
  └─ pollingManager.reloadRoom(roomId)
       └─ startRoomPolling(room)
            ├─ pollRoom(room)                       # 首次立即执行（0~5s jitter）
            │    └─ checkRoom(room)
            │         ├─ PlatformChecker.checkStatus()   # 平台 API
            │         │    └─ KuaishouAPIChecker 使用平台级 Redis 锁串行访问快手 API
            │         ├─ 状态转换检测 (wasLive→isLive)
            │         ├─ Redis SET (TTL=interval×2)      # 瞬时状态缓存
            │         └─ _tryStartRecording()             # 开播触发录制
            └─ setInterval(pollRoom, intervalMs)          # 定时轮询
```

**说明**：

- 启动时只检查1次状态，不设定时器
- 新增或修改房间时由 `reloadRoom()` 控制定时轮询

### 数据存储策略

| 数据                 | 存储                    | 原因           |
| -------------------- | ----------------------- | -------------- |
| 直播状态 / 轮询时间  | Redis，TTL=`interval*2` | 瞬时数据       |
| 快手平台锁 / backoff | Redis，短 TTL           | 风控与并发保护 |
| 房间配置             | DB `rooms` 表           | 持久配置       |
| room_name            | DB，仅在首次为空时填充  | 用户可自定义   |

### 安全机制

- **停止 → 关监听**：`POST /api/rooms/:id/stop` 自动 `monitoring_enabled=false`
- **状态转换判定**：仅 `!wasLive && isLive` 触发录制
- **防重复**：`RecorderService.startRecording()` 有 Redis `active_task` 保护
- **jitter**：0~5s 随机延迟防惊群
- **快手平台级串行**：快手房间不并发检查，并限制跨房间连续 API 请求间隔

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

- 通知通道：飞书 webhook、Gotify、自定义 Webhook（v1.7.0 新增）。
- 未配置通知参数时静默跳过对应通道。
- Gotify 使用 `MESSAGE_GOTIFY_SERVER`、`MESSAGE_GOTIFY_TOKEN`、
  `MESSAGE_GOTIFY_PRIORITY`。
- Webhook 通过前端设置页配置 `webhook_enabled` 和 `webhook_url`，所有通知事件同步 POST JSON。
- 飞书和 Gotify 支持通过 `settings` 表的 `feishu_webhook_enabled`/`gotify_enabled` 开关独立控制。
- 回放队列每个处理步骤完成后发送「直播回放处理完成」通知；通知异常只写入
  `logs/replay_{recordId}.log`，不阻断后续步骤。

### 执行

- API 接口立即返回，上传在后台异步执行（`UploadService._runUpload`）
- 调用 `biliup upload` 子进程
- 输出记录到 `upload_records` 表，状态流转：`uploading` → `success` / `failed`
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

---

## 10. 回放工具箱

`server/lib/core/replay/` 模块，将快手直播回放的全流程自动化。

### 架构

```text
前端 (Vue 3 SPA)                          后端
─────────────────                         ─────
/replay-toolbox                           server/router/replay.js
  └── /:principalId                       ├── ReplayService (CRUD)
        ├── /records                      ├── KuaishouReplayClient (API)
        ├── /uploads                      ├── m3u8-extractor.js (Playwright)
        ├── /tasks                        ├── video-processor.js (yt-dlp/ffmpeg)
        └── /settings                     ├── ReplayUploadService (biliup)
                                          └── ReplayProcessQueue (Redis)
```

### 处理流水线

```text
[同步] playback/list API → replay_records (pending)
         │
         ▼
[提取] KuaishouReplayClient.extractM3u8()
         ├─ 方案1: HTTP API (playback/detail → playUrlV3)
         └─ 方案2: Playwright 浏览器兜底 (m3u8-extractor.js)
         │
         ▼
[下载] yt-dlp → raw_file_path (.mp4)
         │
         ▼
[切片] mkvmerge --split (优先) / ffmpeg -f segment (降级)
         │
         ▼
[修复] ffmpeg 分辨率统一 (720p)
         │
         ▼
[投稿] ReplayUploadService → biliup → bv_id
         │
         ▼
[完成] status = 'completed'
```

### 状态机

```text
pending → extracted → downloaded → cut → fixed → uploaded → completed
                                       └──────────────────────────────→ failed
```

### m3u8 提取两级降级

1. **HTTP API 优先**：直接调用 `playback/detail` 接口，解析 `playUrlV3` 选择最佳清晰度
2. **Playwright 浏览器兜底**：通过 `RemoteBrowserClient` 打开回放页面，拦截 API 响应或网络 m3u8 流

浏览器方案复用直播轮询的 `REMOTE_BROWSER_WS_ENDPOINT` 配置。

### 关键设计

- **数据隔离**：`replay_records` / `replay_settings` / `replay_upload_records` 三张独立表，与录制模块仅共享 `upload_templates`
- **目录隔离**：回放产物写入 `REPLAY_WORK_DIR`（默认 `/data/replay`），与录制文件完全分离
- **队列单并发**：`ReplayProcessQueue` 强制最大 1 并发，N100 NAS 磁盘 IO 保护
- **中间态清理**：状态跃迁成功后异步清理上一步临时文件（`cleanup.js`）
- **主播自动发现**：从 `rooms.room_url` 识别快手主播，零配置联动
