# 直播录制自动化流程架构 (v1.3)

## 整体流程

```
[Chrome 扩展]                   [Server API]                 [Downloader]              [Post-processing]
     │                               │                            │                         │
     │  POST /notify/live_download   │     spawn pipe stderr      │                         │
     │──────────────────────────────>│───────────────────────────>│                         │
     │                               │   stderr tee ──→ log       │    持续写入 .part        │
     │                               │   stderr ──→ heartbeat     │<────────────────────────│
     │                               │              tracker       │                         │
     │                               │                            │                         │
     │                               │   ─── 看门狗 (每 30s) ─── │                         │
     │                               │   ① heartbeat 优先检测     │                         │
     │                               │   ② mtime fallback         │                         │
     │                               │   ③ Worker Pool 异步扫描   │                         │
     │                               │   ④ checkDiskSpace()       │                         │
     │                               │                            │                         │
     │                               │   chokidar 事件驱动        │                         │
     │                               │   (文件新增/变更/删除)     │                         │
     │                               │   → recording_files 自动   │                         │
     │                               │     追踪 (双锁防并发)      │                         │
     │                               │                            │                         │
     │                               │   进程退出 (stop/崩溃/断流)│                         │
     │                               │<───────────────────────────│                         │
     │                               │   close handler            │                         │
     │                               │   + clearHeartbeat()       │                         │
     │                               │                            │                         │
     │                               │   findAndAutoUpload()       ───────────────────────>│
     │                               │                            │                         │  biliup upload
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

---

## 二、文件追踪

### 文件名生成

```
非分段: {room_name}_{datetime}.{ext}
分段:   {room_name}_%Y%m%d_%H%M%S.{ext}
```

- `ext` 由下载引擎决定：ffmpeg → `.mp4`，stream-gears → `.flv`
- stream-gears 内部固定追加 `.flv`，buildArgs 中已去掉 outputPath 的扩展名
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
stream-gears 写入 .part
        │
        │  分段边界 → FlvFile::Drop
        │  .part → .flv (rename)
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
      → 更新 session 状态
```

**注意**：stream-gears 的 FlvFile::Drop 在收到 SIGTERM 时可能不执行，导致 `.part` 不重命名。rooms.js stop 处理和启动清理包含 `.part → .flv` 的兜底重命名。

### 文件扫描 (scanRecordingFiles)

- 支持强制扫描和冷却（5 分钟冷却）
- 遍历 VIDEO_DOWNLOAD_DIR，匹配 `\\.(mp4|flv|ts|mkv|avi|mov)$`
- 跳过活跃录制房间（`status = 'recording'`）的输出目录下的文件
- 未追踪文件 → `orphaned`
- DB 有但磁盘无 → `missing`

---

## 三、下载引擎

### 工厂模式

```
DownloaderFactory.getActiveDownloader()
    │
    ├─ settings.downloader = 'ffmpeg'       → FFmpegDownloader (默认)
    └─ settings.downloader = 'stream-gears'  → 探测可用性
         ├─ pip install stream-gears 已安装  → StreamGearsDownloader
         └─ 未安装 → fallback 到 ffmpeg
```

### FFmpegDownloader

- spawn `ffmpeg` 子进程，`stdio: ['ignore', 'ignore', 'pipe']`, `detached: false`
- 参数：`-c copy -fflags +genpts -reconnect ...`
- 分段模式：`-f segment -segment_time N`
- 扩展名：`.mp4`
- 停止信号：SIGTERM → 进程正常退出 → close handler
- stderr pipe → 上层 tee 到日志文件 + 心跳解析器

### StreamGearsDownloader

- spawn `python3 stream_gears_wrapper.py` 子进程，`stdio: ['ignore', 'pipe', 'pipe']`, `detached: false`
- Python 脚本调用 Rust 库 `stream_gears.download()`
- 内部处理 FLV tag 修复、断线重试（指数退避 1s/2s/4s）
- 分段模式：`PySegment.time(seconds)`
- 扩展名：`.flv`
- 写入策略：`{file_name}.flv.part` → Drop 时 rename → `{file_name}.flv`
- **注意**：SIGTERM 时 Rust Drop 可能不执行，需兜底重命名
- stdout/stderr pipe → 上层 tee 到日志文件 + 心跳解析器

---

## 四、看门狗 (`lib/watchdog.js`)

看门狗是独立模块，单实例运行。职责边界如下：

### 运行周期

- `watchdog.start()` → 100ms 后首次执行 → 之后每 `watchdog_interval`（默认 30s）循环
- 最少 10 秒，防止设置错误
- 同一时间只有 1 个定时器在跑（模块级 `watchdogTimer` 变量控制）

### 属于看门狗（`lib/watchdog.js`）

| 函数                     | 触发        | 职责                                                             |
| ------------------------ | ----------- | ---------------------------------------------------------------- |
| `checkDiskSpace()`       | 每周期      | `df -k` 检查磁盘剩余空间，`<1GB` 设 `disk:critical` Redis key    |
| `checkStaleRecordings()` | 每周期      | 心跳优先 → mtime 降级 → `_markStale()` 清理死录制                |
| `scanActiveSegments()`   | 每周期      | Worker Pool 异步扫描活跃目录，追踪新分片                          |
| `cleanupFragmentFiles()` | 每周期      | Worker Pool 异步扫描，删除小于阈值碎片的文件                      |
| `runFileScan()`          | 启动 + 手动 | 调用 `scanRecordingFiles()` 扫描下载目录，标记孤文件 / 缺失文件  |

### 不属于看门狗（但在 `app.js` 启动时运行）

| 函数                       | 所在文件            | 触发       | 职责                                                                 |
| -------------------------- | ------------------- | ---------- | -------------------------------------------------------------------- |
| `cleanupStaleRecordings()` | `app.js`            | 启动       | 重命名 `.part`、追踪遗留文件、尝试恢复会话（**v1.3 移除 pkill**）   |
| `cleanupStaleRedis()`      | `app.js`            | 启动       | 清理 Redis 过期 `active_task:*`                                      |
| `scanRecordingFiles()`     | `lib/scan-files.js` | 启动 / API | Worker Pool 异步扫描，`watchdog.runFileScan()` 和 API 共用            |

### 周期性执行链

```
watchdog.start()
  └─ setTimeout(runWatchdog, 100)
       ├─ checkDiskSpace()          ← 磁盘空间监控
       ├─ checkStaleRecordings()    ← 心跳 + mtime 僵死检查
       ├─ scanActiveSegments()      ← Worker Pool 异步扫描
       ├─ cleanupFragmentFiles()    ← Worker Pool 异步清理
       └─ setTimeout(runWatchdog, interval)  ← 下次周期
```

### 启动时执行链（非周期）

```
startup()
  ├─ migrate()                      ← DB 迁移
  ├─ cleanupStaleRecordings()       ← 重命名 .part + 追踪遗留文件 + 恢复会话 (无 pkill)
  ├─ cleanupStaleRedis()            ← 清理 Redis 过期 key
  └─ watchdog.runFileScan()         ← Worker Pool 扫描下载目录
```

### checkStaleRecordings() — v1.3 心跳优先策略

1. **进程存活检查**：`process.kill(pid, 0)`
2. **心跳优先检测**（v1.3 新增）：
   - 读取 `heartbeat-tracker` 中该房间的 `lastHeartbeatAt`
   - 若 `now - lastHeartbeatAt > watchdog_timeout`（默认 **120s**）→ 僵死
   - 若 stream-gears 连续 retry 超过 **3 分钟** → 链路已死，触发重连
3. **mtime 降级**（v1.3 改为 fallback）：
   - 仅当进程存活且无心跳数据时，回退到 mtime 检测
   - 分段/非分段模式同 v1.2
4. **清理条件**：进程死亡 或 心跳超时 或 文件僵死（mtime fallback）
5. **清理动作**（`_markStale()` v1.3 统一提取）：
   - 杀死进程（SIGTERM → 5s → SIGKILL）
   - 房间设为 idle，清理 Redis room/active_task cache
   - `clearHeartbeat()` 清除心跳记录
   - 会话标为 interrupted，recording_files 标为 interrupted

### scanActiveSegments() — v1.3 Worker Pool

- 使用 `FSWorkerPool`（2 个 Worker Thread）异步扫描活跃房间目录
- Worker 满时降级至 `find` 子进程
- 发现未追踪的 `.flv`/`.mp4` → 写入 recording_files + recordings + 更新 session 合计
- 小于 `filtering_threshold` 的碎片跳过不追踪

### cleanupFragmentFiles() — v1.3 Worker Pool

- 使用 Worker Pool 异步扫描整个 `VIDEO_DOWNLOAD_DIR`
- 找到小于 `filtering_threshold` 的 `.flv`/`.mp4` 文件
- 跳过创建不足 2 分钟的新文件（防止误删刚完成的分片）
- 删除磁盘文件 + 关联的 `recordings` + `recording_files` 记录
- 更新 session 合计

---

## 五、v1.3 新增模块

### lib/heartbeat-parser.js

- 解析 FFmpeg stderr：`/frame=\d+\s+fps=[\d.]+\s+bitrate=[\d.]+kbits/`
- 解析 Stream-Gears stderr：`/download speed|retry|flv tag/i`
- 提供 `isRetry(chunk)` 检测重试状态
- `RETRY_TIMEOUT_MS = 180000`（3 分钟重试超限阈值）

### lib/heartbeat-tracker.js

- 内存 `Map<roomKey, { lastHeartbeatAt, retryStartAt }>`
- `updateHeartbeat(roomKey, chunk)` — 写入心跳时间戳 + 检测重试
- `getHeartbeatInfo(roomKey)` — 返回 `{ age, inRetryLoop, shouldReconnect }`
- `clearHeartbeat(roomKey)` — 录制结束时清理
- 看门狗通过 `shouldReconnect` 判定 stream-gears 重试超限（3 分钟无有效数据）

### lib/file-watcher.js

- 基于 `chokidar` 的事件驱动文件监听，替换轮询
- 监听事件：`add` → 插入 `recording_files`（双锁保护），`change` → 更新文件大小，`unlink` → 标记 missing
- **防并发双锁**：`Map<sessionId, Set<filePath>>` 内存锁 + `Redis SETNX watch:file:{hash} 1 EX 10`
- 仅在分段模式下启用（`watchRoom` / `unwatchRoom`）
- 唯一责任人：**close handler** 拥有 `.part` → `.flv/mp4` 重命名权；**watchdog** 严禁 rename

### lib/workers/fs-scanner.js + lib/fs-worker-pool.js

- Worker Thread 池（默认 2 个 Worker）
- 工作：接收主线程 `{ dir, filter }` 消息，递归遍历目录，`fs.statSync` 收集文件信息
- **降级策略**：无空闲 Worker 时自动 fallback 至子进程 `find . -type f`
- 用于 `scanRecordingFiles()`、`scanActiveSegments()`、`cleanupFragmentFiles()`

---

## 六、启动清理 (cleanupStaleRecordings) — v1.3

在 `startup()` 中运行，按顺序（**v1.3 移除 pkill**，依赖 `tini`/管道绑定回收子进程）：

1. **处理 .part 残留**：遍历脏房间输出目录，重命名 `.part` → `.flv`
2. **追踪遗留文件**：将 untracked 的 `.flv`/`.mp4` 写入 `recording_files`
3. **房间复位**：`status = 'idle'`, `ffmpeg_pid = NULL`, `output_path = ''`
4. **尝试恢复会话**：对 `status='recording'` 的会话调用 `tryResumeSession`（最多 3 次）
5. **标记录制中断**：`recordings` + `recording_files` 中 `status='recording'` 的标为 `interrupted`

---

## 七、投稿流程

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

## 八、边界情况与容错

| 场景                                 | 处理方式                                        |
| ------------------------------------ | ----------------------------------------------- |
| 进程收到 SIGTERM 后 Rust Drop 不执行 | rooms.js stop 同步扫描 + 重命名 .part           |
| 看门狗误杀正在写 .part 的进程        | mtime 检查包含 .part 文件                       |
| 文件扫描发现活跃录制中的文件         | 跳过该目录，由 close handler 追踪               |
| 录制中途服务器重启                   | startup 清理 + 尝试恢复会话                     |
| stream-gears 不可用                  | 自动回退到 ffmpeg                               |
| 并发录制超过池大小                   | HTTP 429 "Pool full"                            |
| Redis 残留 active_task               | cleanupStaleRedis 启动时清理                    |
| DB 重复 recording_files               | UNIQUE(file_path) 约束 + ON CONFLICT DO NOTHING |
| VBR/黑屏 mtime 停滞误杀               | stderr 心跳解析优先，mtime 降级为 fallback       |
| stream-gears 断线重试 5 分钟假活      | 连续 retry 超过 3 分钟 → 标记为 must reconnect   |
| 并发扫描同一文件（EBUSY/重复入库）    | 内存 Map 锁 + Redis SETNX 10s 双保险             |
| 主线程 fs 操作阻塞 Event Loop         | Worker Thread 池（2 Worker）+ find 子进程降级     |
| 磁盘空间不足                          | checkDiskSpace() 设 disk:critical，暂停新录制    |
| 上传限流重启丢失                      | Redis INCR 持久化 + 24h 过期                      |
