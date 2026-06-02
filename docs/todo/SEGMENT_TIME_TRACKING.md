# 分段文件时间记录实现方案

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
  this.emitSegment(segmentMatch[1]);  // 触发 'segment' 事件
}
```

### 当前数据流

```
录制开始
    ↓
FFmpeg 进程启动
    ↓
[分段文件1创建] → emitSegment() → 无处理
    ↓
[分段文件2创建] → emitSegment() → 无处理
    ↓
...
    ↓
录制结束 (进程退出)
    ↓
watchdog.scanActiveSegments() 扫描文件
    ↓
INSERT INTO recording_files (..., segment_index, ...)
    ↓
segment_start_ms = 0, segment_end_ms = 0  ← 问题所在
```

---

## 解决方案

### 方案对比

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A: 实时记录** | 录制过程中监听 segment 事件，实时记录时间 | 精确、实时 | 需要维护内存状态 |
| **B: 后置计算** | 录制结束后通过 ffprobe 获取时长并累加 | 简单、无侵入 | 需要额外 I/O 操作 |
| **C: 文件名解析** | 从 strftime 格式文件名解析时间 | 无需额外操作 | 依赖文件名格式，不够灵活 |

**推荐方案 A**：实时记录，精确且不影响录制结束后的处理流程。

---

## 方案 A 详细设计

### 1. 数据结构

在录制进程中维护一个分段时间追踪器：

```javascript
// 内存结构
const segmentTimeTracker = {
  sessionId: number,
  sessionStartMs: number,      // 会话开始时间戳
  segments: [
    { filePath: string, startMs: number, endMs: number | null }
  ]
};
```

### 2. 修改文件清单

| 文件 | 修改内容 |
|------|---------|
| `lib/core/RecordingManager.js` | 新增分段时间追踪逻辑 |
| `lib/core/downloaders/FFmpegDownloader.js` | 在 segment 事件中携带时间信息 |
| `services/RecorderService.js` | 监听 segment 事件，更新数据库 |

### 3. 核心实现

#### 3.1 RecordingManager 扩展

```javascript
// lib/core/RecordingManager.js

class RecordingManager {
  constructor() {
    this.activeSegments = new Map(); // sessionId -> { sessionStartMs, segments: [] }
  }

  /**
   * 注册会话的分段追踪
   */
  registerSession(sessionId, sessionStartMs) {
    this.activeSegments.set(sessionId, {
      sessionStartMs,
      segments: [],
      lastSegmentTimeMs: 0,
    });
  }

  /**
   * 记录分段文件创建
   * @param {number} sessionId
   * @param {string} filePath - 分段文件路径
   * @param {number} currentMs - 当前时间戳（相对于会话开始）
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

    tracker.lastSegmentTimeMs = currentMs;
  }

  /**
   * 结束会话，返回所有分段的时间信息
   */
  finalizeSession(sessionId) {
    const tracker = this.activeSegments.get(sessionId);
    if (!tracker) return [];

    // 最后一个分段的结束时间设为 null（表示到会话结束）
    // 实际使用时取 Infinity

    const segments = [...tracker.segments];
    this.activeSegments.delete(sessionId);
    return segments;
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
      const elapsedMs = Date.now() - startTime;
      this.emitSegment(segmentMatch[1], elapsedMs);  // 携带相对时间
    }
    // ... 其他处理
  });

  return process;
}
```

#### 3.3 RecorderService 修改

```javascript
// services/RecorderService.js

static async startRoomRecording({ roomId, caption, url, resumeSessionId = null }) {
  // ... 现有代码 ...

  // 注册分段追踪
  recordingManager.registerSession(sessionId, sessionStart.getTime());

  // 监听分段事件
  dlProcess.on('segment', (filePath, elapsedMs) => {
    recordingManager.recordSegment(sessionId, filePath, elapsedMs);
  });

  // ... 现有代码 ...
}

// finishSession 中更新分段时间
static async finishSession({ code, sessionId }) {
  // ... 现有代码 ...

  // 获取分段时间信息并更新数据库
  const segmentTimes = recordingManager.finalizeSession(sessionId);
  for (const seg of segmentTimes) {
    await pool.query(
      `UPDATE recording_files
       SET segment_start_ms = $1, segment_end_ms = $2
       WHERE file_path = $3`,
      [seg.startMs, seg.endMs || 0, seg.filePath]
    );
  }

  // ... 现有代码 ...
}
```

### 4. 兼容性处理

#### 4.1 旧数据兼容

对于没有分段时间的旧数据，在生成 ASS 时做兼容：

```javascript
// DanmakuAssGenerator.js
const segStart = seg.segment_start_ms || 0;
const segEnd = seg.segment_end_ms > 0 ? seg.segment_end_ms : Infinity;

// 如果 start=0 且 end=Infinity，说明是旧数据，输出警告
if (segStart === 0 && segEnd === Infinity) {
  console.warn(`[弹幕] 分段 ${seg.id} 缺少时间信息，将包含所有弹幕`);
}
```

#### 4.2 非分段录制

对于不使用分段录制的会话（`segment_duration = 0`）：
- 整个会话只有一个文件
- `segment_start_ms = 0`, `segment_end_ms = 0`（表示整个会话）
- 弹幕生成时使用会话级 ASS，不受影响

---

## 实施步骤

```
Step 1: 扩展 RecordingManager
  ├── 添加 activeSegments Map
  ├── 实现 registerSession()
  ├── 实现 recordSegment()
  └── 实现 finalizeSession()

Step 2: 修改 FFmpegDownloader
  ├── 记录录制开始时间
  ├── 在 segment 事件中携带 elapsedMs
  └── 更新 emitSegment() 方法签名

Step 3: 修改 RecorderService
  ├── 在 startRoomRecording 中注册分段追踪
  ├── 监听 segment 事件
  └── 在 finishSession 中更新数据库

Step 4: 兼容性处理
  ├── DanmakuAssGenerator 添加警告日志
  └── 旧数据迁移脚本（可选）

Step 5: 测试
  ├── 单元测试：RecordingManager 方法
  ├── 集成测试：录制 → 分段时间记录 → ASS 生成
  └── 回归测试：npm test 全量通过
```

---

## 测试策略

| 测试项 | 方式 |
|--------|------|
| RecordingManager 方法 | 单元测试，验证时间计算正确性 |
| 分段录制流程 | 集成测试，录制 2 分钟视频（30秒分段），验证 4 个分段的时间范围 |
| 弹幕时间匹配 | 验证每个分段的 ASS 只包含对应时间段的弹幕 |
| 非分段录制 | 验证不影响现有单文件录制流程 |
| 旧数据兼容 | 使用旧数据生成 ASS，验证警告日志输出 |

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 内存泄漏 | 长时间录制导致内存增长 | 在 finishSession 中确保清理，添加超时清理机制 |
| 时间精度 | FFmpeg stderr 延迟导致时间不精确 | 使用 Date.now() 计算相对时间，精度足够 |
| 进程异常退出 | 分段时间未记录 | watchdog 扫描时通过文件名/ffprobe 补充 |

---

## 后续优化

1. **持久化追踪**：将分段时间实时写入 Redis，防止进程崩溃丢失
2. **ffprobe 校验**：录制结束后用 ffprobe 获取实际时长，校验并修正
3. **管理接口**：提供 API 查看当前活跃的分段追踪状态

---

## 完成标准

- [ ] `recording_files.segment_start_ms` 和 `segment_end_ms` 正确记录
- [ ] 分段 ASS 只包含对应时间段的弹幕
- [ ] 非分段录制不受影响
- [ ] 旧数据兼容处理正常
- [ ] `npm test` 全量通过
