# 分段文件时间记录实现方案

> **状态**: 待实施
> **最后更新**: 2026-06-02
> **关联文档**: `DANMAKU_BURN_DECOUPLE_PLAN.md`（Phase 4 前置依赖）

---

## 问题背景

### 现状

`recording_files` 表中有 `segment_start_ms` 和 `segment_end_ms` 两个字段，用于记录每个分段文件相对于会话开始时间的时间偏移。这两个字段对于弹幕分段 ASS 生成至关重要：

```javascript
// DanmakuAssGenerator.js L147-152
const segStart = seg.segment_start_ms || 0;
const segEnd = seg.segment_end_ms || Infinity;

// 筛选当前分段的弹幕
const segComments = comments.filter((c) => c.ts_ms >= segStart && c.ts_ms < segEnd);
```

### 问题

目前这两个字段**没有被实际设置**，数据库默认值都是 `0`：

```javascript
// db/migrate.js
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS segment_start_ms INTEGER DEFAULT 0;
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS segment_end_ms INTEGER DEFAULT 0;
```

这导致：

- 每个分段的 ASS 都包含**所有弹幕**，而不是按时间段切割
- 弹幕与视频画面时间不同步

---

## 录制流程分析

### 分段录制机制

```
FFmpeg 参数:
  -f segment           # 使用分段输出格式
  -segment_time N      # 每 N 秒切割一个文件
  -reset_timestamps 1  # 每个分段的时间戳从 0 开始
  -strftime 1          # 支持时间格式化文件名
```

### 分段文件检测

FFmpegDownloader 通过监听 stderr 日志检测新分段文件的创建：

```javascript
// FFmpegDownloader.js L293-296
const segmentMatch = line.match(/\[segment @ .*\] Opening '(.*)' for writing/);
if (segmentMatch) {
  this.emitSegment(segmentMatch[1]); // 触发 'segment' 事件
}
```

> **现状**：`segment` 事件确实会 emit，但**目前没有任何代码监听这个事件**。

### 当前数据流（问题所在）

```
录制开始
    ↓
FFmpeg 进程启动
    ↓
[分段文件1创建] → emitSegment() → 无监听，事件丢失  ← 问题1
    ↓
[分段文件2创建] → emitSegment() → 无监听，事件丢失
    ↓
...
    ↓
录制结束 (进程退出)
    ↓
watchdog.scanActiveSegments() 扫描文件
    ↓
INSERT INTO recording_files (..., segment_index, ...)
    ↓
segment_start_ms = 0, segment_end_ms = 0  ← 问题2
```

### 冲突点：watchdog 可能覆盖分段时间

`watchdog.js` 的 `scanActiveSegments()` 会在录制过程中或结束后扫描文件并 INSERT `recording_files`。**如果分段文件在 `RecordingManager.finalizeSession()` 写入数据库之前被 watchdog 扫描到，会产生 `segment_start_ms = 0` 的记录，随后被 `finalizeSession()` 的 UPDATE 覆盖。**

但如果在 `finalizeSession()` **之后** watchdog 才扫描到该文件（极端情况），INSERT 会写入 `segment_start_ms = 0`，且不会被覆盖。

---

## 解决方案

### 方案对比

| 方案              | 描述                                      | 优点         | 缺点                                        |
| ----------------- | ----------------------------------------- | ------------ | ------------------------------------------- |
| **A: 实时记录**   | 录制过程中监听 segment 事件，实时记录时间 | 精确、实时   | 需要维护内存状态，需处理进程异常退出        |
| **B: 后置计算**   | 录制结束后通过 ffprobe 获取时长并累加     | 简单、无侵入 | 需要额外 I/O 操作，录制结束后的处理时间变长 |
| **C: 文件名解析** | 从 strftime 格式文件名解析时间            | 无需额外操作 | 依赖文件名格式，不够灵活                    |

**推荐方案 A**：实时记录，精确且不影响录制结束后的处理流程。配合风险缓解措施可解决内存泄漏和异常退出问题。

---

## 方案 A 详细设计

### 1. 数据结构

在 `RecordingManager` 中维护分段时间追踪器（内存）：

```javascript
// lib/core/RecordingManager.js 新增

class RecordingManager {
  constructor() {
    this.activeSegments = new Map();
    // 结构：
    // sessionId -> {
    //   sessionStartMs: number,   // 会话开始时间戳 (Date.now())
    //   segments: [
    //     { filePath: string, startMs: number, endMs: number | null }
    //   ],
    //   lastHeartbeat: number,     // 上次心跳时间，用于超时清理
    // }
  }
}
```

### 2. 修改文件清单

| 文件                                       | 修改内容                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `lib/core/RecordingManager.js`             | 新增分段时间追踪逻辑（核心）                                                       |
| `lib/core/downloaders/FFmpegDownloader.js` | `emitSegment()` 携带 `elapsedMs`                                                   |
| `services/RecorderService.js`              | 监听 segment 事件；调用 `finalizeSession()` 写数据库                               |
| `lib/core/watchdog.js`                     | `scanActiveSegments()` 协同：若 RecordingManager 已有 tracker，从 tracker 读取时间 |

### 3. 核心实现

#### 3.1 RecordingManager 扩展

```javascript
// lib/core/RecordingManager.js

const SEGMENT_TRACKER_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟无心跳则强制清理

class RecordingManager {
  constructor() {
    this.activeSegments = new Map();

    // 启动心跳超时检查（每 5 分钟扫描一次）
    this._startTrackerCleanup();
  }

  /**
   * 注册会话的分段追踪
   * @param {number} sessionId
   * @param {number} sessionStartMs - Date.now() 时间戳
   */
  registerSession(sessionId, sessionStartMs) {
    this.activeSegments.set(sessionId, {
      sessionStartMs,
      segments: [],
      lastHeartbeat: Date.now(),
    });
  }

  /**
   * 更新会话心跳（防止超时清理）
   * @param {number} sessionId
   */
  heartbeat(sessionId) {
    const tracker = this.activeSegments.get(sessionId);
    if (tracker) {
      tracker.lastHeartbeat = Date.now();
    }
  }

  /**
   * 记录分段文件创建
   * @param {number} sessionId
   * @param {string} filePath - 分段文件路径
   * @param {number} currentMs - 当前时间戳（相对于会话开始，毫秒）
   */
  recordSegment(sessionId, filePath, currentMs) {
    const tracker = this.activeSegments.get(sessionId);
    if (!tracker) return;

    // 结束上一个分段
    if (tracker.segments.length > 0) {
      const lastSegment = tracker.segments[tracker.segments.length - 1];
      lastSegment.endMs = currentMs;
    }

    // 开始新分段
    tracker.segments.push({
      filePath,
      startMs: currentMs,
      endMs: null,
    });

    tracker.lastHeartbeat = Date.now();
  }

  /**
   * 结束会话，将所有分段的时间信息写入数据库
   * @param {number} sessionId
   * @param {object} pool - 数据库连接池
   * @returns {Promise<Array>} 写入成功的分段列表
   */
  async finalizeSession(sessionId, pool) {
    const tracker = this.activeSegments.get(sessionId);
    if (!tracker) return [];

    // 最后一个分段的结束时间设为 null（表示到会话结束）
    // DanmakuAssGenerator 中用 Infinity 处理

    const segments = tracker.segments.map((seg) => ({
      ...seg,
      endMs: seg.endMs || null,
    }));

    // 在清理 tracker 之前写入数据库
    for (const seg of segments) {
      await pool.query(
        `UPDATE recording_files
         SET segment_start_ms = $1, segment_end_ms = $2
         WHERE file_path = $3`,
        [seg.startMs, seg.endMs || 0, seg.filePath]
      );
    }

    // 清理 tracker
    this.activeSegments.delete(sessionId);
    return segments;
  }

  /**
   * 获取指定 session 的分段时间信息（供 watchdog 协同使用）
   * @param {number} sessionId
   * @param {string} filePath
   * @returns {{ startMs: number, endMs: number | null } | null}
   */
  getSegmentTime(sessionId, filePath) {
    const tracker = this.activeSegments.get(sessionId);
    if (!tracker) return null;
    return tracker.segments.find((s) => s.filePath === filePath) || null;
  }

  /**
   * 启动 tracker 超时清理（防止内存泄漏）
   */
  _startTrackerCleanup() {
    setInterval(
      () => {
        const now = Date.now();
        for (const [sessionId, tracker] of this.activeSegments.entries()) {
          if (now - tracker.lastHeartbeat > SEGMENT_TRACKER_TIMEOUT_MS) {
            console.warn(`[RecordingManager] Tracker for session ${sessionId} timed out, cleaning up`);
            this.activeSegments.delete(sessionId);
          }
        }
      },
      5 * 60 * 1000
    ); // 每 5 分钟检查一次
  }
}

module.exports = new RecordingManager();
```

#### 3.2 FFmpegDownloader 修改

```javascript
// lib/core/downloaders/FFmpegDownloader.js

spawn(args) {
  const process = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const startTime = Date.now();

  const rl = readline.createInterface({ input: process.stderr, terminal: false });
  rl.on('line', (line) => {
    const segmentMatch = line.match(/\[segment @ .*\] Opening '(.*)' for writing/);
    if (segmentMatch) {
      // 使用 Date.now() - startTime 计算相对时间
      // 精度：FFmpeg stderr 日志延迟约 100~500ms，对弹幕分段可接受
      const elapsedMs = Date.now() - startTime;
      this.emitSegment(segmentMatch[1], elapsedMs); // 携带相对时间
    }
    // ... 其他处理
  });

  return process;
}
```

> **精度说明**：`Date.now()` 精度为 1ms，但 FFmpeg stderr 输出有约 100~500ms 延迟，导致分段时间记录有微小误差。对于弹幕分段场景，此误差可接受（仅影响分段边界附近的几条弹幕）。若需更高精度，可用 `performance.now()` 替代，但收益有限。

#### 3.3 RecorderService 修改

```javascript
// services/RecorderService.js

static async startRoomRecording({ roomId, caption, url, resumeSessionId = null }) {
  // ... 现有代码 ...

  // 注册分段追踪
  const sessionStartMs = Date.now();
  recordingManager.registerSession(sessionId, sessionStartMs);

  // 监听分段事件
  dlProcess.on('segment', (filePath, elapsedMs) => {
    recordingManager.recordSegment(sessionId, filePath, elapsedMs);
  });

  // 定期更新心跳（防止超时清理）
  const heartbeatInterval = setInterval(() => {
    recordingManager.heartbeat(sessionId);
  }, 30 * 1000);

  // 录制结束时清除心跳定时器
  dlProcess.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  // ... 现有代码 ...
}

// finishSession 中写入分段时间
static async finishSession({ code, sessionId }) {
  // ... 现有代码 ...

  // 将分段时间写入数据库（在 finalizeSession 内部完成写入）
  try {
    await recordingManager.finalizeSession(sessionId, pool);
  } catch (err) {
    console.error(`[RecorderService] Failed to finalize segment times for session ${sessionId}:`, err);
    // 不阻断后续流程，watchdog 会通过 ffprobe 补充（见下文异常退出处理）
  }

  // ... 现有代码 ...
}
```

#### 3.4 watchdog.js scanActiveSegments() 协同修改

```javascript
// lib/core/watchdog.js scanActiveSegments()

// 在 INSERT recording_files 之前，检查 RecordingManager 是否已有时间信息
for (const fp of videoFiles) {
  // ... 现有逻辑：检查文件稳定性、大小等 ...

  // 查询 RecordingManager 中的分段时间
  const segTime = recordingManager.getSegmentTime(session.session_id, fp);

  let segmentStartMs = 0;
  let segmentEndMs = 0;
  if (segTime) {
    segmentStartMs = segTime.startMs;
    segmentEndMs = segTime.endMs || 0;
  }
  // 若 segTime 为 null，说明 RecordingManager 中没有该分段的信息
  // 可能是：1) 非分段录制；2) RecordingManager 已清理（异常退出）
  // 这两种情况都由后续的异常退出处理（ffprobe 补充）覆盖

  await pool.query(
    `INSERT INTO recording_files
      (session_id, room_url, file_path, file_name, file_size, status, started_at, ended_at, segment_index, segment_start_ms, segment_end_ms, checked_at)
     VALUES ($1, $2, $3, $4, $5, 'completed', NOW(), NOW(), $6, $7, $8, NOW())
     ON CONFLICT (file_path) DO UPDATE SET
       segment_start_ms = EXCLUDED.segment_start_ms,
       segment_end_ms = EXCLUDED.segment_end_ms,
       file_size = EXCLUDED.file_size,
       checked_at = NOW()`,
    [session.session_id, session.room_url, fp, f, stat.size, segIndex, segmentStartMs, segmentEndMs]
  );
}
```

> **关键改动**：使用 `INSERT ... ON CONFLICT DO UPDATE`，确保即使 watchdog 先扫描到文件，`finalizeSession()` 的 UPDATE 也不会被覆盖。同时，`finalizeSession()` 的写入也会用 `ON CONFLICT` 或先检查是否存在记录。

---

## 风险缓解措施

### 风险 1：内存泄漏

**原因**：若录制进程异常退出，`RecordingManager` 中的 tracker 未被清理，长时间积累导致内存增长。

**缓解措施**（已在 3.1 中实现）：

1. **心跳超时强制清理**：每 5 分钟扫描一次，若某个 session 的 `lastHeartbeat` 超过 10 分钟无更新，强制清理 tracker
2. **`finishSession` 中显式清理**：正常流程下 `finalizeSession()` 会 delete tracker
3. **`heartbeat()` 方法**：RecorderService 每 30 秒调用一次，确保活跃会话不会被误清理

### 风险 2：watchdog 覆盖写入

**原因**：`watchdog.scanActiveSegments()` 可能在 `finalizeSession()` 之前或之后写入 `recording_files`，导致 `segment_start_ms = 0`。

**缓解措施**（已在 3.4 中实现）：

1. **`ON CONFLICT DO UPDATE`**：watchdog 的 INSERT 使用 upsert 语义，若记录已存在则更新（而非覆盖）
2. **`finalizeSession()` 在清理 tracker 之前写入 DB**：确保在 watchdog 之前完成写入
3. **`getSegmentTime()` 协同**：watchdog 优先使用 `RecordingManager` 中的数据

### 风险 3：进程异常退出导致分段时间丢失

**原因**：若 Node.js 进程崩溃，`RecordingManager` 内存中的 tracker 数据全部丢失，分段文件的 `segment_start_ms` 和 `segment_end_ms` 保持为 0。

**缓解措施**：

1. **watchdog 定期 ffprobe 补充**（见下文 4.1）
2. **`finalizeSession()` 写入失败不阻断流程**：`catch` 住错误，让 watchdog 有机会补充

### 风险 4：时间精度（FFmpeg stderr 延迟）

**原因**：`Date.now() - startTime` 计算的分段时间有约 100~500ms 误差。

**影响评估**：弹幕时间精度为毫秒级，500ms 误差仅导致分段边界附近的几条弹幕可能归属到错误的分段。**对观看体验影响可忽略**。

**缓解措施**（可选，暂不实施）：

- 使用 `performance.now()` 替代 `Date.now()`，精度更高（微秒级）
- 在 `FFmpegDownloader` 中解析 FFmpeg 的 `time=` 输出，获取更精确的当前播放时间

---

## 异常退出处理：ffprobe 补充方案

当 `RecordingManager` 中的 tracker 数据丢失（进程崩溃、超时清理等）时，需要通过 ffprobe 补充分段时间。

### 实现位置

在 `watchdog.js` 的 `scanActiveSegments()` 中，对于 `segment_start_ms = 0` 的文件，使用 ffprobe 获取实际时长并反推分段时间。

```javascript
// lib/core/watchdog.js （新增辅助函数）

async function probeSegmentDuration(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath]);
    let output = '';
    proc.stdout.on('data', (d) => (output += d));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${code}`));
      try {
        const data = JSON.parse(output);
        resolve(parseFloat(data.format.duration) * 1000); // 转为毫秒
      } catch (e) {
        reject(e);
      }
    });
  });
}

// 在 scanActiveSegments() 的 INSERT 之后，补充分段时间
async function backfillSegmentTimes(sessionId, pool) {
  const rows = await pool.query(
    `SELECT file_path, segment_index FROM recording_files
     WHERE session_id = $1 AND segment_start_ms = 0
     ORDER BY segment_index`,
    [sessionId]
  );

  let accumulatedMs = 0;
  for (const row of rows.rows) {
    const durationMs = await probeSegmentDuration(row.file_path);
    await pool.query(
      `UPDATE recording_files
       SET segment_start_ms = $1, segment_end_ms = $2
       WHERE file_path = $3`,
      [accumulatedMs, accumulatedMs + durationMs, row.file_path]
    );
    accumulatedMs += durationMs;
  }
}
```

> **注意**：`backfillSegmentTimes()` 应在录制结束后调用（避免读取未完成文件），且在 `finishSession()` 之后。可在 `watchdog.scanActiveSegments()` 中判断会话已结束后触发。

---

## 兼容性处理

### 旧数据兼容

对于没有分段时间的旧数据（`segment_start_ms = 0` 且 `segment_end_ms = 0`），在生成 ASS 时做兼容：

```javascript
// DanmakuAssGenerator.js
const segStart = seg.segment_start_ms || 0;
const segEnd = seg.segment_end_ms > 0 ? seg.segment_end_ms : Infinity;

// 如果 start=0 且 end=Infinity，说明是旧数据或单文件录制
if (segStart === 0 && segEnd === Infinity) {
  // 单文件录制：包含所有弹幕，无需警告
  // 旧的分段数据：也包含所有弹幕，弹幕时间不准确但至少不会丢失
  console.warn(`[弹幕] 分段 ${seg.id} 缺少时间信息，将包含所有弹幕`);
}
```

### 非分段录制

对于不使用分段录制的会话（`segment_duration = 0`）：

- 整个会话只有一个文件
- `segment_start_ms = 0`, `segment_end_ms = 0`（fallback 到 `Infinity`）
- 弹幕生成时使用会话级 ASS，包含所有弹幕，不受影响

---

## 实施步骤

```
Step 1: 扩展 RecordingManager
  ├── 添加 activeSegments Map
  ├── 实现 registerSession() / heartbeat() / recordSegment()
  ├── 实现 finalizeSession()（在方法内部写数据库，清理 tracker 之前完成）
  ├── 实现 getSegmentTime()（供 watchdog 协同）
  └── 实现 _startTrackerCleanup()（心跳超时强制清理）

Step 2: 修改 FFmpegDownloader
  ├── 记录录制开始时间 startTime
  ├── 在 segment 事件中计算 elapsedMs
  └── emitSegment() 携带 elapsedMs 参数

Step 3: 修改 RecorderService
  ├── startRoomRecording 中注册分段追踪 + 监听 segment 事件
  ├── 添加 heartbeatInterval 定时更新心跳
  └── finishSession 中调用 finalizeSession()（try/catch 包裹）

Step 4: 修改 watchdog.js
  ├── scanActiveSegments() 中调用 getSegmentTime() 获取分段时间
  ├── INSERT 使用 ON CONFLICT DO UPDATE 语义
  └── 在会话结束后调用 backfillSegmentTimes()（异常退出补充）

Step 5: 兼容性处理
  ├── DanmakuAssGenerator 添加警告日志（已有，确认无误）
  └── 旧数据迁移脚本（可选，见下文）

Step 6: 测试
  ├── 单元测试：RecordingManager 所有方法
  ├── 集成测试：录制 → 分段时间记录 → ASS 生成
  └── 回归测试：npm test 全量通过
```

---

## 测试策略

| 测试项                | 方式                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------- |
| RecordingManager 方法 | 单元测试，验证 registerSession → recordSegment → finalizeSession 完整链路                    |
| 心跳超时清理          | 单元测试，mock Date.now() 触发超时                                                           |
| 分段录制流程          | 集成测试，录制 2 分钟视频（30秒分段），验证 4 个分段的 `segment_start_ms` / `segment_end_ms` |
| 弹幕时间匹配          | 验证每个分段的 ASS 只包含对应时间段的弹幕                                                    |
| 非分段录制            | 验证 `segment_duration=0` 时不影响现有单文件录制流程                                         |
| 旧数据兼容            | 使用旧数据（segment_start_ms=0）生成 ASS，验证警告日志输出                                   |
| 异常退出补充          | 模拟 RecordingManager tracker 丢失，验证 `backfillSegmentTimes()` 正确补充                   |
| watchdog 协同         | 验证 `ON CONFLICT DO UPDATE` 不会被覆盖                                                      |

---

## 完成标准

- [ ] `recording_files.segment_start_ms` 和 `segment_end_ms` 在分段录制时正确记录（误差 < 1s）
- [ ] 分段 ASS 只包含对应时间段的弹幕
- [ ] 非分段录制不受影响（`segment_duration = 0`）
- [ ] 旧数据兼容处理正常（ASS 包含所有弹幕，输出警告日志）
- [ ] 心跳超时清理机制正常工作（10 分钟无心跳自动清理 tracker）
- [ ] 异常退出时 `backfillSegmentTimes()` 能正确补充分段时间
- [ ] watchdog `ON CONFLICT DO UPDATE` 不会覆盖 `finalizeSession()` 的写入
- [ ] `npm test` 全量通过
- [ ] 集成测试通过（录制 → 分段时间 → ASS 生成完整链路）

---

## 后续优化

1. **持久化追踪**：将分段时间实时写入 Redis，防止进程崩溃丢失（当前用 ffprobe 补充作为兜底）
2. **ffprobe 校验**：录制结束后用 ffprobe 获取实际时长，校验并修正 `segment_start_ms` / `segment_end_ms`
3. **管理接口**：提供 API 查看当前活跃的 `RecordingManager` tracker 状态（调试用）
4. **`performance.now()` 高精度**：若弹幕分段精度要求提高，可替换 `Date.now()`
