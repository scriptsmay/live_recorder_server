# 直播录制自动化流程架构

## 整体流程

```
[Chrome 扩展]                   [Server API]                 [FFmpeg]                [Transcode Queue]      [Upload]
     │                               │                            │                         │                    │
     │  POST /notify/live_download   │     spawn pipe stderr      │                         │                    │
     │──────────────────────────────>│───────────────────────────>│                         │                    │
     │                               │   stderr tee ──→ log       │    持续写入 .part        │                    │
     │                               │                            │<────────────────────────│                    │
     │                               │                            │                         │                    │
     │                               │   ─── 看门狗 (每 30s) ─── │                         │                    │
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

## 一、会话生命周期

**会话的文件列表以 `recording_files` 表为数据源**（而非 `recordings` 表）。`recording_files` 跟踪实际磁盘文件，`recordings` 仅为元数据表供流媒体播放等下游使用。

```
                      ┌── 新录制请求 ──────────────────┐
                      │                                │
                      ▼                                │
              ┌──────────────┐                         │
              │  Session     │   在 delay 窗口内        │
              │  (recording) │◄────────────────────────┘
              │              │
              │  看门狗实时   │── 每 30s ──→ scanActiveSegments()
              │  追踪分片     │             写入 recording_files + recordings
              │              │
              │  GET /api    │── 会话详情直接查询 recording_files
              │  /sessions   │   （不查 recordings 表）
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
- **注意**：续播不 append 到旧文件。FLV/MP4 容器无文件级 append 机制，服务器重启恢复时生成新文件（`_resume_N`）

---

## 二、文件追踪

### 文件名生成

```
非分段: {room_name}_{datetime}.flv
分段:   {room_name}_%Y%m%d_%H%M%S.flv
```

- 录制输出固定为 FLV 格式(经 ffmpeg 录制)
- 转码后输出 MP4 格式(通过 TranscodeQueue 异步处理)
- 续播时（非分段 + delay 内）复用上一次的 outputFilePattern

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
      → 写入 recordings
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
      → 更新 recording_files 和 recordings 表路径
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

## 三、下载引擎

### FFmpegDownloader (唯一引擎)

- spawn `ffmpeg` 子进程，`stdio: ['ignore', 'ignore', 'pipe']`, `detached: false`
- 参数：`-c copy -fflags +genpts -reconnect ...`
- 分段模式：`-f segment -segment_time N`
- 扩展名：`.flv` (录制输出) → `.mp4` (转码后)
- 停止信号：SIGTERM → 进程正常退出 → close handler
- stderr pipe → 上层 tee 到日志文件

---

## 四、流式转码架构

### TranscodeQueue (`lib/core/TranscodeQueue.js`)

**设计理念**: 将集中式转码改为异步队列处理,分散CPU压力,提升用户体验。

**工作流程**:

```
录制结束 → FLV分片文件入队(Redis LPUSH) → TranscodeQueue.processQueue()
                                              │
                                              ├─ 检查并发数(transcode_concurrency)
                                              ├─ 从队列取出任务(Redis RPOP)
                                              ├─ ffmpeg -i input.flv -c copy output.mp4
                                              ├─ 更新DB路径(recording_files + recordings)
                                              └─ 删除原FLV文件(如果配置了)
```

**关键特性**:

- **Redis队列**: 使用 `transcode_queue` List存储任务,支持服务重启后恢复
- **并发控制**: 通过 `transcode_concurrency` 设置(默认3),使用Redis计数器 `transcode_processing_count` 跟踪
- **异步处理**: 在主进程内非阻塞执行,不阻塞录制和API响应
- **实时入队**: 分段文件记录到数据库后立即入队,无需等待录制结束
- **错误容忍**: 单个分片转码失败不影响其他分片

**配置项**:

| 设置项                       | 默认值 | 说明                 |
| ---------------------------- | ------ | -------------------- |
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

| 指标          | 旧方案(集中转码)      | 新方案(流式转码)    |
| ------------- | --------------------- | ------------------- |
| 4小时直播转码 | 8-20分钟(集中处理)    | 分散处理,几乎无等待 |
| CPU峰值       | 高(一次性转码240分片) | 低(并发3,持续处理)  |
| 用户体验      | 录制结束后需等待      | 立即可操作部分文件  |
| 失败影响      | 一个失败整体失败      | 单个失败不影响其他  |

---

## 五、看门狗 (`lib/watchdog.js`)

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

### 不属于看门狗（但在 `app.js` 启动时运行）

| 函数                       | 所在文件            | 触发       | 职责                                                       |
| -------------------------- | ------------------- | ---------- | ---------------------------------------------------------- |
| `cleanupStaleRecordings()` | `app.js`            | 启动       | 重命名 `.part`、追踪遗留文件、尝试恢复会话                 |
| `cleanupStaleRedis()`      | `app.js`            | 启动       | 清理 Redis 过期 `active_task:*`                            |
| `scanRecordingFiles()`     | `lib/scan-files.js` | 启动 / API | 同步 fs 遍历下载目录，`watchdog.runFileScan()` 和 API 共用 |

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
startup()
  ├─ migrate()                      ← DB 迁移（死锁自动重试 3 次）
  ├─ cleanupStaleRedis()            ← 清理 Redis 过期 active_task
  ├─ cleanupStaleRecordings()       ← 重命名 .part、恢复会话
  ├─ transcodeQueue.init()          ← 初始化转码队列(加载并发配置)
  └─ watchdog.start()               ← 启动看门狗
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
- 发现未追踪的 `.flv`/`.mp4` → 写入 recording_files + recordings + 更新 session 合计
- **mtime 稳定期**：文件最近 2 分钟内有修改则跳过（防止标记还在写入的当前分段）
- 小于 `filtering_threshold` 的碎片跳过不追踪

### cleanupFragmentFiles()

- 同步 `fs.readdirSync` + `fs.statSync` 扫描整个 `VIDEO_DOWNLOAD_DIR`
- 找到小于 `filtering_threshold` 的 `.flv`/`.mp4` 文件
- 跳过创建不足 2 分钟的新文件（防止误删刚完成的分片），跳过刚由 `.part` 重命名而来的文件
- 删除磁盘文件 + 关联的 `recordings` + `recording_files` 记录
- 更新 session 合计

### syncMissingFiles()

- 查询 `recording_files` 中所有非 `missing`/`deleted` 状态的记录
- 逐个检查磁盘文件是否存在
- 不存在的文件更新为 `status = 'missing'`
- 配合 `cleanupFragmentFiles` 和手动删除文件后自动标记

---

## 五、启动清理 (cleanupStaleRecordings)

在 `startup()` 中运行，按顺序：

1. **处理 .part 残留**：遍历脏房间输出目录，重命名 `.part` → `.flv`
2. **追踪遗留文件**：将 untracked 的 `.flv`/`.mp4` 写入 `recording_files`
3. **房间复位**：`status = 'idle'`, `ffmpeg_pid = NULL`, `output_path = ''`
4. **尝试恢复会话**：对 `status='recording'` 的会话调用 `tryResumeSession`（最多 3 次）
5. **标记录制中断**：`recordings` + `recording_files` 中 `status='recording'` 的标为 `interrupted`

---

## 六、投稿流程

### 触发

- 录制完成自动触发（`findAndAutoUpload`）
- 手动触发（POST /api/sessions/:id/upload）
- 受 `max_upload_limit` Redis INCR 持久化计数限制（`upload_count:{sessionId}`，24h 过期）

### 模板

- `upload_templates` 表存储投稿参数
- 支持变量替换：`{room_name}` `{date}` `{datetime}` 等
- 投稿后处理：`none` / `backup` / `delete` / `backup_and_delete`

### 执行

- 调用 `biliup upload` 子进程
- 输出记录到 `upload_records` 表
- 解析 BV 号（正则 `/BV[0-9A-Za-z]{10}/`），关联到投稿记录

---

## 七、边界情况与容错

| 场景                                 | 处理方式                                        |
| ------------------------------------ | ----------------------------------------------- |
| 进程收到 SIGTERM 后 Rust Drop 不执行 | rooms.js stop 同步扫描 + 重命名 .part           |
| 看门狗误杀正在写 .part 的进程        | mtime 检查包含 .part 文件                       |
| 文件扫描发现活跃录制中的文件         | 跳过该目录，由 close handler 追踪               |
| 录制中途服务器重启                   | startup 清理 + 尝试恢复会话                     |
| stream-gears 不可用                  | 自动回退到 ffmpeg                               |
| 并发录制超过池大小                   | HTTP 429 "Pool full"                            |
| Redis 残留 active_task               | cleanupStaleRedis 启动时清理                    |
| DB 重复 recording_files              | UNIQUE(file_path) 约束 + ON CONFLICT DO NOTHING |
| stream-gears FLV 解析崩溃            | 自动回退到 ffmpeg，同一会话继续录制             |
| stream URL 失效/过期                 | ffmpeg 重连机制自动处理（reconnect_streamed）   |
| 磁盘空间不足                         | checkDiskSpace() 设 disk:critical，暂停新录制   |
| 上传限流重启丢失                     | Redis INCR 持久化 + 24h 过期                    |
