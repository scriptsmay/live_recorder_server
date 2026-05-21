# Code Review: Live Recorder Server

> 审查时间：2026-05-21 | 项目版本：v1.1.5 | 审查范围：主业务流程 + 看门狗机制

---

## 1. 主业务流程分析：`POST /api/notify/live_download`

### 1.1 链路总览

```
Chrome扩展 / 轮询系统
       │
       ▼  POST /api/notify/live_download  { url, title, caption, room_url }
       │
 router/api.js ── 直接委托 RecorderService.startRecording()
       │                 ↓
 RecorderService.startRecording()  ── 参数校验 + 前置条件检查
       │
       ▼  通过检查后
 RecorderService.startRoomRecording()  ── 核心录制启动
       │
       ├── ① 创建/复用录制会话 (RecordingManager.createSession)
       ├── ② 启动 FFmpeg 进程 (RecordingManager.startRecordingProcess)
       ├── ③ 写数据库：rooms.status='recording' + recording_sessions.status='recording'
       ├── ④ 写 Redis：active_task:{roomKey} 记录活跃任务
       └── ⑤ 注册 FFmpeg close 回调 → finishSession()
```

### 1.2 详细数据流

#### 阶段一：入口校验（`startRecording`）

| 检查项 | 实现方式 | 返回 |
|--------|----------|------|
| 必填参数 | `if (!url \|\| !title \|\| !room_url)` | 400 |
| DOWNLOAD_DIR | 环境变量检查 | 500 |
| 活跃任务去重 | Redis `active_task:{roomKey}` EXISTS 检查 | 400 "请勿重复开启" |
| 线程池容量 | Redis `keys active_task:*` 数量 ≥ pool_size 设置 | 429 "Pool full" |
| 数据库可用性 | `getOrCreateRoom` catch | 500 |
| 监控暂停 | `room.monitoring_enabled === false` | 400 |
| 重复录制 | `room.status === 'recording' \|\| 'paused'` | 400 |
| 清理残局 | 更新同 room_url 下所有 `status='recording'` 的会话为 `interrupted` | 继续 |

**设计思路**：分层防御。Redis 做轻量级去重（TTL=24h），DB 做持久化状态检查，double-check 防止并发推送导致重复启动。

#### 阶段二：会话创建（`startRoomRecording`）

```
 ① checkReuseSession()
     ├── 获取 delay 设置（默认 60s）
     ├── Redis 分布式锁 `lock:resume:{roomId}` (EX=10, NX)
     ├── 查询最近 ended_at 在 delay 窗口内的 completed/interrupted 会话
     └── 命中 → 复用该会话ID (reuseSession=true)
         ├── 未命中 → 新建会话 (status='pending')

 ② RecordingManager.createSession()
     ├── reuseSession=true → UPDATE status='recording' WHERE id=resumeCount
     └── 新建 → INSERT INTO recording_sessions (..., status='pending')
```

**设计亮点**：续播（resume）机制——直播流短暂中断重连时复用同一个会话记录，避免文件碎片化。Redis 锁防止并发续播冲突。

#### 阶段三：FFmpeg 进程启动

```
 RecordingManager.startRecordingProcess()
     ├── downloader.buildArgs() → 生成 ffmpeg 命令行参数
     │     ├── 快手的 FFmpegDownloader: 支持 -f segment 分段（.flv）
     │     └── 虎牙的 TsDownloader: 不分段（.ts），含 UA 伪装 + 重连
     ├── createProcLog() → 创建进程日志文件
     ├── downloader.spawn() → spawn('ffmpeg', args)
     ├── 管道重定向 stderr/stdout 到日志文件
     └── 返回 { process, logStream, logPath }

 updateSessionPidToDatabase()  [事务]
     ├── UPDATE rooms SET status='recording', ffmpeg_pid=$pid
     └── UPDATE recording_sessions SET status='recording'
```

**关键参数差异**（FFmpegDownloader vs TsDownloader）：

| 维度 | FFmpegDownloader (快手) | TsDownloader (虎牙) |
|------|------------------------|---------------------|
| 扩展名 | `.flv` | `.ts` |
| 分段支持 | `isSegment()=true`，支持 `-f segment` | `isSegment()=false`，不分段 |
| 超时参数 | `timeout=10000000`, `rw_timeout=10000000` | `rw_timeout=15000000`, `reconnect=1` |
| 容错 | `+genpts+igndts` | `+genpts+igndts+discardcorrupt`, `-correct_ts_overflow 1` |
| 特殊 | 无 UA 伪装 | 含 `-user_agent` 伪浏览器 UA 防 403 |

#### 阶段四：录制结束（`finishSession`）

```
 FFmpeg 进程退出 (close 事件)
       │
       ▼
 finishSession({ code, sessionId })
       │
       ├── ① 清理 Redis active_task
       ├── ② 更新 rooms.status='idle', ffmpeg_pid=NULL
       ├── ③ 冷却期处理
       │     ├── 录制时长 ≥ 5s → 设置 30s 冷却 (polling:recording_cooldown)
       │     └── 录制时长 < 5s → 不设冷却，记录结束时间，允许轮询快速重试
       │
       └── ④ _handleSessionFinish({ sessionId, code })
             │
             ├── a. 获取 filtering_threshold (默认 10MB)
             ├── b. 遍历 recording_files 检查磁盘文件
             │     ├── < threshold → unlink 删除碎片
             │     └── ≥ threshold → 更新 recordings 和 recording_files 状态
             ├── c. 对有效文件调用 RecordingManager.addTranscodeQueue()
             ├── d. 更新 recording_sessions: total_segments, total_size, status
             └── e. 通知（成功/中断）
```

### 1.3 数据库状态流转

```
rooms:
  created → idle → recording → [paused] → idle

recording_sessions:
  pending → recording → completed
                       → interrupted (崩溃/异常退出)
                       → completed (看门狗从 interrupted 升级)
```

### 1.4 设计评价

**亮点**：

1. **分层职责清晰**：`router`（薄）→ `RecorderService`（业务协调）→ `RecordingManager`（FFmpeg 控制）→ `Downloader`（引擎抽象）。每层只负责一件事。
2. **续播（resume）机制**：直播流短暂中断后复用会话 ID，避免会话碎片，配合 `delay` 设置可调。
3. **去重防御**：Redis `active_task` + DB `room.status` 双重检查，兼顾性能和一致性。
4. **冷却期差异化处理**：短录制（<5s，通常流地址无效）不设冷却期，允许快速重试；正常的录制结束设 30s 冷却防抖动。
5. **线程池限制**：settings 层可配 `pool_size`，Redis `keys active_task:*` 作为实时计数源。

**潜在问题**：

1. **并发竞态**：`getActiveTasksCount()` 使用 `redis.keys()` 而非原子计数器，在大并发下可能不准（Redis keys 是 O(N) 操作 + 非原子 reads）。建议改用 Redis `SCARD` 管理一个 Set type `active_tasks_set` 或直接用 INCR/DECR 计数器。
2. **`keys active_task:*` 的性能风险**：当活跃任务数或总 key 量上升时，`keys` 命令会阻塞 Redis。建议改为 `SCAN` 或维护独立计数器。
3. **`finishSession` 参数膨胀**：方法签名曾接受 `{code, engine, room, sessionId, sessionStart, reuseSession, useSegment, outputFilePattern, roomKey}` 等 9 个参数，虽已简化为 `{code, sessionId}`，但代码中残留的注释和旧参数传递仍可清理。
4. **续播锁 TTL 太短**：Redis 锁 `lock:resume:{room.id}` 仅 10 秒，而 `delay` 默认 60 秒。如果并发较高，锁可能提前释放导致其他请求误判。建议：锁 TTL 设为 `delay + 5` 或采用 Lua 脚本保证原子性。
5. **`_handleSessionFinish` 中文件大小核对逻辑**：`fs.statSync` 检查所有 session 文件——如果磁盘 I/O 高或文件数量大，可能阻塞事件循环。虽项目设计上不引入 worker thread，但可考虑分批 stat 或使用 `fs.promises.stat`（但会破坏当前同步风格）。

---

## 2. 看门狗机制分析（`watchdog.js`）

### 2.1 职责全景

`runWatchdog()` 作为主循环，每 `watchdog_interval`（默认 30s）执行一次，依次调度 8 项子任务：

```
runWatchdog()
  ├── ① checkStaleRecordings()  → 检测僵死录制进程（目前只 LOG，不做处理）
  ├── ② scanActiveSegments()    → 扫描录制中的分段文件，写入 DB
  ├── ③ cleanupFragmentFiles()  → 清理小于阈值的碎片文件
  ├── ④ syncMissingFiles()      → 同步磁盘不存在的文件标记
  ├── ⑤ finalizeInterruptedSessions() → interrupted → completed（超时兜底）
  ├── ⑥ checkSessionTranscode() → 已完成会话的待转码文件入队列
  ├── ⑦ runFileScan()           → 扫描磁盘文件并关联/标记孤文件
  └── ⑧ UploadService.scanPendingAutoUpload() → 自动投稿检查
```

### 2.2 各子任务详细分析

#### ① `checkStaleRecordings()` ⚠️

- **做了什么**：查询 `rooms.status='recording'` 的直播间，对每个房间检测：进程是否存活（`process.kill(pid, 0)`）+ 输出文件是否超时未更新（`watchdog_timeout`，默认 60s）。
- **不做什么**：全部逻辑只输出日志 `[看门狗] 检测: xxx (进程=true, 文件过时=false)` + `[看门狗] 但暂时不做任何处理.`。**清理代码已全部注释**。
- **评价**：这是一个**残废的检测器**——只检测不处置。如果真的发生进程僵死，看门狗不会做任何清理，只能依赖 `cleanupStaleRecordings()`（启动时一次性的）或等到下次重启。要么移除，要么恢复清理逻辑。留着这坨死代码只是增加循环开销（每次查库 + stat 磁盘文件）。

#### ② `scanActiveSegments()` ✅

- **做了什么**：
  - 查询 `rooms.join(recording_sessions)` 中 status 为 `recording` 或 `completed`（最近 5 分钟内）的活跃会话
  - 扫描输出目录，查找未被 DB `recording_files` 跟踪的新视频文件
  - 校验文件大小 ≥ `filtering_threshold`（默认 10MB）
  - 校验文件修改时间已稳定 ≥ 2 分钟（或如果会话刚结束 ≥ 30s）
  - 写入 `recordings` + `recording_files` 表，更新 `total_segments` 和 `total_size`
  - 还顺便检查已跟踪文件的 size 变化（FFmpeg 持续写入），增量更新 `total_size`
- **设计思路**：弥补 FFmpeg 分段模式下 `[segment @ ...] Opening '...'` 事件的不可靠性。看门狗定期扫描目录作为保险。
- **评价**：实现本身完整，但存在以下问题：
  - **与 `finishSession/_handleSessionFinish` 的功能重叠**：两者都会扫描文件、写 recording_files、触发转码。分段模式下可能重复处理。
  - **目录扫描开销**：每个周期扫描所有活跃会话的输出目录，文件量大时 `readdirSync` + `statSync` 可能阻塞。
  - **`isRecentlyEnded` 逻辑**：扫描 completed 会话（`ended_at >= NOW() - 5min`）时，5 分钟窗口内的会话会反复扫描。

#### ③ `cleanupFragmentFiles()` ✅

- **做了什么**：递归遍历整个下载目录，删除满足以下条件的碎片文件：
  - 文件 < `filtering_threshold`（默认 10MB）
  - 最后修改时间 > 2 分钟前（防正在写入时误删）
  - 创建时间与修改时间差 > 5 分钟（区分碎片 vs 正常小文件）
  - 删除时同步清理 DB 记录，更新 session 统计
- **评价**：逻辑清晰，兜底策略合理。遍历整个目录的开销在 N100 量级设备上可接受。

#### ④ `syncMissingFiles()` ✅

- **做了什么**：遍历 DB 中所有非 missing/deleted 的 `recording_files`，检查文件在磁盘是否存在，不存在则标记 `missing`。
- **评价**：简单有效，O(n) 但每次只查 DB（不遍历磁盘），开销低。

#### ⑤ `finalizeInterruptedSessions()` ✅

- **做了什么**：查找所有 `status='interrupted'` 且 `ended_at` 不为空的会话，如果结束时间超过 `delay` 设置（默认 60s），升级状态为 `completed`。
- **评价**：很聪明的兜底设计。录制进程异常退出时 `finishSession` 将 session 标记为 `interrupted`，但文件可能已经完整。看门狗定期检查并将稳定态的 interrupted 升级为 completed，使转码和自动投稿可以正常触发。

#### ⑥ `checkSessionTranscode()` ⚠️

- **做了什么**：查询所有 `completed` 的会话及其 `recording_files`，将 flv/ts 文件入转码队列。
- **问题**：
  - **重复入队风险**：每次看门狗循环都会重新扫描所有 `completed` 会话的文件，而 `transcode_records` 的冲突约束 `ON CONFLICT (original_path) DO NOTHING` 在 `TranscodeQueue.enqueue` → `createTranscodeRecord` 层面有，但如果任务已入队但尚未插入 DB 记录，仍有重复可能。
  - **与 `_handleSessionFinish` 中的 `addTranscodeQueue` 重叠**：文件在 `finishSession` 阶段已入队转码，看门狗再次扫描相同的 completed 会话会再次尝试入队（虽然有 duplicate detection，但仍有额外的 DB 查询开销）。

#### ⑦ `runFileScan()` ✅

- **做了什么**：调用 `scanRecordingFiles()`，将磁盘上未跟踪的文件与现有会话匹配或标记为 `orphaned`。
- **评价**：启动时有冷却（5 分钟），看门狗周期调用时 force=false 会跳过。职责明确，文件与 DB 之间的兜底同步。

#### ⑧ `UploadService.scanPendingAutoUpload()` ✅

- **做了什么**：扫描最近 7 天内的 `completed` 会话，检查：
  - 房间是否配置了 `upload_template_id`
  - 转码是否已完成（`isSessionTranscodeComplete`）
  - 投稿次数是否已达上限（`checkUploadLimit`，Redis INCR 24h 过期）
  - 是否存在阻塞中的投稿记录
  - 未被 Redis `upload_skipped` 标记
- **评价**：实现了完整的自动投稿流水线条件检查，逻辑严谨。Redis 上传计数 + 限制 + skip 标记的机制设计合理。

### 2.3 整体评价

#### 做了什么（正面）

- **兜底保障**：`finalizeInterruptedSessions` + `cleanupFragmentFiles` + `syncMissingFiles` 组成了三重兜底网，覆盖了进程崩溃、碎片残留、文件丢失等边缘情况。
- **全链路覆盖**：从分段追踪 → 碎片清理 → 会话状态升级 → 转码触发 → 自动投稿，看门狗串联了整个录制后处理流水线。
- **与具体业务高度解耦**：每个 `check*` / `scan*` 函数都是纯数据和文件操作，不依赖外部状态，易于单测。

#### 不做什么

- **不做实时录制管理**：不干预正在运行的 FFmpeg 进程的行为（如不给 SIGTERM/SIGKILL），`checkStaleRecordings` 的清理代码已被注释。
- **不做轮询替代**：直播状态的检测和录制触发有独立的 `PollingManager`，看门狗不负责。
- **不做阻塞操作**：所有 DB 操作均有 `try/catch`，错误仅日志不中断主循环。

#### 是否过度复杂？

**存在一定程度的过度设计**，集中体现在：

| 问题 | 表现 | 严重程度 |
|------|------|----------|
| **僵尸函数** | `checkStaleRecordings` 查库 + stat 文件后只 LOG 不处理 | 🔴 **高** |
| **功能重叠** | `scanActiveSegments` 与 `finishSession` 的分段追踪逻辑重复；`checkSessionTranscode` 与 `_handleSessionFinish.addTranscodeQueue` 重复 | 🟡 中 |
| **目录扫描过频** | `scanActiveSegments` + `cleanupFragmentFiles` 每个周期（默认 30s）遍历活跃目录和全下载目录 | 🟡 中 |
| **单例状态管理** | `watchdogTimer` 全局变量，在异常抛出时可能悬空 | 🟢 低 |
| **配置依赖链** | `checkStaleRecordings` 依赖 `watchdog_timeout`（无效配置），`scanActiveSegments` 依赖 `filtering_threshold`——但这些配置也在其他模块中被读取 | 🟢 低 |

**具体建议**：

1. **立即处理**：要么恢复 `checkStaleRecordings` 的清理逻辑，要么彻底移除它。当前状态等同于代码注水。
2. **建议重构**：将 `scanActiveSegments` 的职责合并到 `finishSession` 中，不在看门狗中做重复的分段扫描。如果担心 FFmpeg 分段事件丢失，可以保留但降低扫描频率（如每 2 分钟而非 30 秒），或仅扫描监控中的房间。
3. **建议优化**：看门狗 8 个子任务共产生 ~20 条 SQL 查询 + 若干磁盘 stat。在 N100 设备上可接受，但如果未来接入更多房间，建议评估 `cleanupFragmentFiles` 的 `walkDir` 性能。（当前递归遍历整个下载目录，如果目录下有数万个历史文件会变慢）
4. **可选改进**：为 `finalizeInterruptedSessions` 和 `checkSessionTranscode` 增加去重标记（如 Redis 位图或 DB `last_checked_at` 字段），避免每个周期都扫描全表。

### 2.4 看门狗与其他模块的协作关系图

```
┌─────────────────────────────────────────────────────────────────┐
│                       看门狗 (watchdog.js)                       │
│  每 watchdog_interval (默认 30s) 执行一次                        │
│                                                                  │
│  ┌── checkStaleRecordings ──┐  ┌── scanActiveSegments ─────┐   │
│  │  检测僵死进程 (只 LOG)   │  │  扫描活跃分段文件          │   │
│  └───────────────────────────┘  └──────────┬─────────────────┘   │
│  ┌── cleanupFragmentFiles ───┐              │                   │
│  │  清理磁盘碎片             │              ▼                   │
│  └──────────┬─────────────────┘     recording_files ↑           │
│             ▼                      recordings ↑                 │
│    文件被删除 (阈值以下)            recording_sessions ↑          │
│                                                                  │
│  ┌── syncMissingFiles ────────┐                                  │
│  │  标记磁盘缺失的文件        │                                  │
│  └─────────────────────────────┘                                  │
│                                                                  │
│  ┌── finalizeInterrupted ────┐                                   │
│  │  interrupted → completed  │  ←── delay 设置控制超时窗口       │
│  └──────────┬─────────────────┘                                  │
│             │                                                     │
│             ▼                                                     │
│  ┌── checkSessionTranscode ──┐                                   │
│  │  completed 会话 → 转码队列 │  ←── auto_transcode 设置         │
│  └──────────┬─────────────────┘                                  │
│             │                                                     │
│             ▼                                                     │
│  ┌── runFileScan ────────────┐                                   │
│  │  磁盘 ↔ 会话关联/孤文件   │  ←── 5 分钟冷却期                 │
│  └─────────────────────────────┘                                  │
│                                                                  │
│  ┌── scanPendingAutoUpload ──┐                                   │
│  │  满足条件 → 自动投稿      │  ←── upload_template + 转码状态  │
│  └─────────────────────────────┘                                  │
└─────────────────────────────────────────────────────────────────┘

         │                         ▲
         │  recording_sessions     │  session 状态升级
         ▼  rooms                  │
┌──────────────────────────────────────────────────────────────────┐
│                    RecorderService / finishSession                │
│  FFmpeg 退出时：_handleSessionFinish                              │
│    ├── 过滤文件 → 标记 completed                                  │
│    ├── addTranscodeQueue (转码入队)                               │
│    └── 更新 session status                                        │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. 总结

整个项目的主业务流程设计清晰、防御完善，分层架构和续播/碎片过滤等机制体现了良好的工程实践。看门狗作为兜底系统覆盖了绝大多数边缘情况，但存在以下可改进点：

**高优先级**：
- `checkStaleRecordings` 要么恢复清理逻辑，要么移除
- 解决 `scanActiveSegments` 与 `finishSession` 的功能重叠问题

**中优先级**：
- 用 Redis Set 替代 `keys active_task:*` 做活跃任务计数
- 合并重复的转码入队逻辑
- 为看门狗的某些 SQL 查询增加最后一次检查时间戳去重

**低优先级**：
- 续播锁 TTL 应随 delay 设置动态调整
- `cleanupFragmentFiles` 的 `walkDir` 在大目录下的性能评估

---

## 4. 优化计划 & 下一步开发

### 4.1 优先级排布

| 优先级 | 分类 | 任务 | 预估工时 | 影响范围 | 风险等级 |
|--------|------|------|----------|----------|----------|
| 🔴 P0 | Bug | 恢复/移除 `checkStaleRecordings` 僵尸逻辑 | 1h | watchdog.js | 低 |
| 🟡 P1 | 功能重叠 | 合并 `scanActiveSegments` 与 `finishSession` 的分段追踪 | 3h | watchdog.js + RecorderService.js | 中 |
| 🟡 P1 | 功能重叠 | 合并 `checkSessionTranscode` 的重复入队逻辑 | 2h | watchdog.js + TranscodeQueue.js | 中 |
| 🟡 P2 | 性能 | Redis `keys active_task:*` 替代为 Set 或 INCR 计数器 | 1h | RecorderService.js | 低 |
| 🟢 P3 | 健壮性 | 续播锁 TTL 动态适配 delay 设置 | 0.5h | RecorderService.js | 低 |
| 🟢 P3 | 性能 | 看门狗循环增加去重标记减少全表扫描 | 2h | watchdog.js | 低 |
| 🟢 P3 | 清理 | `finishSession` 残留的旧参数代码清理 | 0.5h | RecorderService.js | 低 |

### 4.2 详细方案

#### 🔴 P0: checkStaleRecordings 僵尸逻辑处置

**问题**：当前函数查询 DB + stat 磁盘后只输出日志，不做任何清理。

**方案 A（推荐）— 恢复清理逻辑**：

```js
async function checkStaleRecordings() {
  // ... 现有检测逻辑不变 ...

  if (!processAlive || fileStale) {
    console.log(`[看门狗] 僵死录制: ${room.room_name} (pid=${room.ffmpeg_pid})`);

    // 恢复被注释的清理代码
    if (processAlive && room.ffmpeg_pid) {
      try { process.kill(room.ffmpeg_pid, 'SIGTERM'); } catch (_) {}
      setTimeout(() => {
        try { process.kill(room.ffmpeg_pid, 'SIGKILL'); } catch (_) {}
      }, 5000);
    }

    // 重置房间状态 + 清理 Redis + 标记会话 interrupted + 通知
    // ... 见原注释代码
  }
}
```

**方案 B — 移除此函数**：在 `runWatchdog` 中删除 `checkStaleRecordings()` 调用，保留代码为历史参考。

推荐方案 A，因为：
- 看门狗的核心理念就是兜底，移除了就失去了对 FFmpeg 僵尸进程的处理能力
- 当前 `cleanupStaleRecordings`（启动时执行）无法覆盖运行中的僵尸进程
- 恢复开销小，逻辑已有成熟的参考实现

#### 🟡 P1: scanActiveSegments 与 finishSession 功能合并

**问题**：`finishSession._handleSessionFinish` 和 `scanActiveSegments` 都在做相同的事——扫描目录、写 `recordings`/`recording_files`、更新统计。只是发生时机不同（finishSession 在 FFmpeg 退出时触发，scanActiveSegments 由看门狗定时扫描）。

**方案**：

1. **保留 `finishSession._handleSessionFinish` 作为主线**：FFmpeg 退出时仍执行一次性的文件汇总
2. **`scanActiveSegments` 降级为仅扫描 `status='recording'` 的活跃会话**，不再扫描 `completed` 会话（`ended_at >= NOW() - 5min` 这段逻辑移除）
3. 原因：`completed` 会话已被 `finishSession` 覆盖处理，看门狗再做是浪费；`recording` 中的文件由看门狗做补充追踪即可

```diff
- WHERE r.output_path != ''
- AND (rs.status = 'recording' OR 
-       (rs.status = 'completed' AND rs.ended_at >= NOW() - INTERVAL '5 minutes'))
+ WHERE r.output_path != ''
+ AND rs.status = 'recording'
```

**影响**：如果 FFmpeg 直接崩溃（没有走 `finishSession`），看门狗检查 `staleRecordings` 时会触发清理，然后 `cleanupStaleRecordings` 兜底。`scanActiveSegments` 不再需要为 completed 会话做扫描。

#### 🟡 P1: checkSessionTranscode 重复入队优化

**问题**：`checkSessionTranscode` 每个周期扫描所有 `completed` 会话，向转码队列入队。但每个文件在 `finishSession._handleSessionFinish` 已经 `addTranscodeQueue` 过一次。

**方案**：

1. 在看门狗中检查 `checkSessionTranscode` 时，只处理那些 **没有走 finishSession** 的 completed 会话
2. 在 `recording_sessions` 中新增一个字段 `transcode_check_at`（或标记位 `auto_transcode_triggered`），`finishSession` 完成后设置此字段
3. `checkSessionTranscode` 只查询此字段为 NULL 的会话

```diff
  // 在看门狗中
+ const { rows: sessions } = await pool.query(
+   `SELECT id FROM recording_sessions
+    WHERE status = 'completed' 
+      AND ended_at IS NOT NULL
+      AND finished_processing = false`  // 新增标志位
+ );
```

**降级方案**：不新增字段，在 `transcode_records` 表上通过 `LEFT JOIN` 和 `IS NULL` 判断哪些文件尚未入队。

#### 🟡 P2: 活跃任务计数改用 Redis Set 或 INCR

**问题**：`getActiveTasksCount()` 使用 `redis.keys('active_task:*')`——O(N) + 非原子。

**方案**：维护两个辅助数据结构：

```js
static ACTIVE_TASK_SET_KEY = 'active_task_set';

// 任务启动时
await redis.sAdd(this.ACTIVE_TASK_SET_KEY, roomKey);
await redis.setEx(this.activeTaskKey(roomKey), TTL, JSON.stringify(data));

// 获取计数
const count = await redis.sCard(this.ACTIVE_TASK_SET_KEY);

// 任务结束时
await redis.sRem(this.ACTIVE_TASK_SET_KEY, roomKey);
await redis.del(this.activeTaskKey(roomKey));
```

**影响**：需要同步修改 `startRecording` 和 `finishSession` 中所有新增/删除 active task 的地方，确保 Set 与 Hash 操作保持原子（或容忍短暂不一致，因为 TTL 兜底）。

#### 🟢 P3: 续播锁 TTL 动态适配 delay

```diff
+ const delaySec = parseInt(delayValue, 10) || 60;
- await redis.set(lockKey, '1', { EX: 10, NX: true });
+ await redis.set(lockKey, '1', { EX: delaySec + 5, NX: true });
```

#### 🟢 P3: 看门狗增加去重标记

为 `finalizeInterruptedSessions` 和 `checkSessionTranscode` 增加轻量去重：

**方案 A（Redis）**：
```js
// finalizeInterrupted 最后扫描的 interrupted session 最大 ID
await redis.set('watchdog:last_interrupted_id', maxId, { EX: 3600 });
```

**方案 B（where 条件）**：
```sql
-- 只处理上次检查后新出现的 interrupted 会话
WHERE status = 'interrupted' 
  AND ended_at IS NOT NULL
  AND ended_at < (NOW() - INTERVAL '1 second' * $1)  -- 已超 delay
  AND updated_at > NOW() - INTERVAL '2 hours'          -- 2小时内
```

推荐方案 B，不依赖 Redis，纯 SQL 即可。

### 4.3 阶段划分 & 发布计划

| 阶段 | 包含任务 | 建议版本号 | 验证方式 |
|------|----------|-----------|----------|
| **Phase 1**（立即） | P0: 恢复 checkStaleRecordings | v1.1.6 | 手动 kill ffmpeg 进程，确认看门狗 1 分钟内清理 |
| **Phase 2**（本周） | P1: scanActiveSegments 去重 + checkSessionTranscode 去重 | v1.2.0 | 录制完成后检查转码队列和 DB 无重复记录 |
| **Phase 3**（可选） | P2: Redis 计数器优化 + P3 各项改进 | v1.2.1 | 并发推送测试 + 2x 活跃任务时 keys 命令不再调用 |

### 4.4 风险与回退

| 改动 | 回退方式 | 判断信号 |
|------|----------|----------|
| Phase 1: 恢复清理 | 重新注释 cleanup 代码 + 重启服务 | 录制备份文件被误清理（有 `transcode_delete_originals` 把关，风险低） |
| Phase 2: scanActiveSegments | 恢复 WHERE 条件 + 重启 | 文件未被追踪（关注 `recording_files` 表 `checked_at` 字段） |
| Phase 2: checkSessionTranscode | 全程无数据丢失，最多某次投稿延迟一个看门狗周期 | 手动 `POST /api/sessions/:id/upload` 触发 |

所有改动建议通过新建 `dev` 分支、在开发数据库上测试后再合并到 `main`。

---

*下次 Code Review 建议关注点：PollingManager 与 Watchdog 的重叠区间、TsDownloader 不分段后的转码前切割实现*
