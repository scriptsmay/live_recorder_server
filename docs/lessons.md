# 开发踩坑记录

## 开发环境怎么杀死进程

```bash
lsof -ti :3001 | xargs kill -9 2>/dev/null; sleep 1; echo "已停止旧进程"
```

## 集中式转码的延迟问题与边下边转码方案

### 背景

4小时直播可能产生240个分片，早期方案是录制结束后集中转码，需要8-20分钟，用户体验差，CPU资源利用不均。

### 问题链

```
录制结束 → 240个FLV分片 → 集中转码（8-20分钟）
  → 用户无法立即操作文件
  → CPU前期闲置，最后集中峰值
  → 一个分片失败导致整体失败
```

### 方案一：流式转码架构（TranscodeQueue）- 第一阶段

- 每个分段完成时自动入队 Redis
- 后台异步处理（控制并发数 = 固定值，默认3）
- 转码与录制并行，压力分散

**收益**:

- 用户体验从 ⭐⭐ 升至 ⭐⭐⭐
- 长直播完成后立即可操作（不必等全部转码完）
- 磁盘/CPU 压力均衡分散
- 单个分片失败不影响其他

### 方案二：边下边转码（实时监听 FFmpeg 日志）- 第二阶段

**核心问题**: 之前虽然有了流式转码，但仍然是在录制结束后才批量入队，未能真正实现边下边转码。

**解决方法**:

- 监听 FFmpeg 的 stderr 输出，匹配 `[segment @ ...] Opening 'xxx' for writing` 日志
- 当检测到新分段打开时，将**上一个**分段文件入队转码
- 这样保证了正在写入的分段不会被错误处理
- `finishSession` 仍然保留批量处理逻辑作为兜底

**实现要点**:

- 使用 `lastSegmentPath` 和 `currentSegmentPath` 变量跟踪分段状态
- 只在分段录制模式（`useSegment = true`）下生效
- 在 `finishSession` 中处理最后一个分段
- 维护 `segmentPathsForTranscode` 数组防止重复入队

**完整流程**:

```
FFmpeg 打开 segment 1.flv → 写入中
FFmpeg 打开 segment 2.flv → [边下边转码] segment 1.flv 入队 → 开始转码
FFmpeg 打开 segment 3.flv → [边下边转码] segment 2.flv 入队 → 继续转码
...
录制结束 → [finishSession] segment N.flv 入队 → 转码最后一个
```

**收益**:

- 用户体验从 ⭐⭐⭐ 升至 ⭐⭐⭐⭐⭐
- 录制期间并行完成转码，几乎无等待
- 进一步优化了 CPU 利用率

### 经验总结

| 教训                     | 说明                                                 |
| ------------------------ | ---------------------------------------------------- |
| **异步队列解耦耗时操作** | 使用 Redis 队列将转码从主流程中解耦，提升响应速度    |
| **并发控制要可配置**     | 通过 `transcode_concurrency` 设置适配不同服务器配置  |
| **监听子进程输出**       | 解析 FFmpeg 等外部进程的 stderr 可以获取关键状态变更 |
| **双重保障机制**         | 主流程 + 兜底流程配合，确保无遗漏                    |
| **错误隔离提升稳定性**   | 单个分片转码失败不影响其他分片，避免级联失败         |
| **避免处理正在写入文件** | 通过状态跟踪，等新分段打开时再处理上一个完成的分段   |

## 轮询启动录制失败：streamInfo 为 null 导致流地址丢失

### 问题现象

虎牙直播间已开播，`HuyaChecker` 成功检测到直播状态并打印了日志：

```
[HuyaChecker] 构建虎牙流地址 (TX): https://...
```

但录制没有启动，没有任何 `[PollingManager] 准备启动录制` 或 `[PollingManager] ✅ 启动录制成功` 的日志。

### 问题根因

`HuyaChecker.checkStatus()` 返回了两个字段：

- `streamUrl` - 直接从 `liveData` 构建的流地址
- `streamInfo` - 经过 `extractStreamInfo()` 处理的数据

当虎牙 API 返回的 `bitRateInfo` 字段是无效 JSON 时：

```javascript
// HuyaChecker.js extractStreamInfo() 方法
const bitRateInfo = liveData.liveData?.bitRateInfo ? JSON.parse(liveData.liveData.bitRateInfo) : [];
```

`JSON.parse()` 抛出异常，导致整个 `extractStreamInfo()` 返回 `null`。

**问题链条**：

```
checkStatus() 返回 { streamUrl: 有效值, streamInfo: null }
    ↓
PollingManager._extractStreamUrl() 收到 null 的 streamInfo
    ↓
buildStreamUrlFromStreamInfo(null) 返回 null
    ↓
_tryStartRecording() 因为 streamUrl 为 null 跳过录制
```

日志中看到 "构建虎牙流地址" 是 `extractStreamUrl()` 打印的（它成功执行了），但录制流程使用的是 `streamInfo` 字段。

### 修复方案

**1. 优先使用已构建的 streamUrl**（`PollingManager.js`）：

```javascript
async _extractStreamUrl(room_url, checkResult) {
  // 优先使用 checkStatus() 已经成功构建的 streamUrl
  if (checkResult.streamUrl) {
    return checkResult.streamUrl;
  }

  // 兜底：尝试从 streamInfo 重新构建
  if (checkResult.streamInfo) {
    const detectedPlatform = detectPlatform(room_url);
    if (detectedPlatform === 'huya') {
      const huyaChecker = new HuyaChecker(room_url);
      return huyaChecker.buildStreamUrlFromStreamInfo(checkResult.streamInfo, { useAntiCodeSign: false });
    }
  }

  return null;
}
```

**2. 增强 extractStreamInfo() 的 JSON.parse 错误处理**：

```javascript
extractStreamInfo(liveData) {
  try {
    const stream = liveData.stream?.baseSteamInfoList || liveData.gameStreamInfoList || [];
    let bitRateInfo = [];
    if (liveData.liveData?.bitRateInfo) {
      try {
        bitRateInfo = JSON.parse(liveData.liveData.bitRateInfo);
      } catch (_) {
        // JSON 解析失败时使用空数组，而不是让整个方法失败
        bitRateInfo = [];
      }
    }

    if (stream.length === 0) {
      return null;
    }

    return {
      streams: stream,
      bitRateInfo: bitRateInfo,
      maxBitrate: liveData.liveData?.bitRate || liveData.bitRate || 0,
    };
  } catch (err) {
    console.error(`[HuyaChecker] 解析流信息失败:`, err.message);
    return null;
  }
}
```

### 经验总结

| 教训                    | 说明                                                                        |
| ----------------------- | --------------------------------------------------------------------------- |
| **优先使用已有结果**    | `checkStatus()` 已成功构建 `streamUrl`，不应该再依赖可能失败的 `streamInfo` |
| **防御性编程处理 JSON** | 对外部 API 返回的可疑 JSON 数据添加 try-catch 包裹                          |
| **避免级联失败**        | 一个字段解析失败不应该阻塞其他正常字段的使用                                |
| **日志要成对出现**      | 如果打印了 "构建成功" 日志，确保后续流程能真正使用该结果                    |

## 优化开播检测：结合 Redis 缓存和房间实际录制状态

### 问题现象

即使直播间正在开播，PollingManager 可能不会启动录制。原因是：

- Redis 缓存中保存了 `wasLive=true`
- 所以即使 `isLive=true`，也不会触发开播检测
- 导致房间一直处于 "漏录" 状态

### 问题根因

原逻辑只检查 Redis 缓存的状态：

```javascript
if (isLive && !wasLive) {
  // 开播检测
}
```

如果 Redis 缓存显示 `wasLive=true`，就不会再尝试启动录制了。但实际上：

- Redis 缓存可能过期或不准确
- 房间可能已经结束录制，状态变回 `idle`
- 此时应该再次检查并启动录制

### 修复方案

优化开播检测逻辑，同时检查 **Redis 缓存** 和 **房间的实际录制状态**：

```javascript
const wasLive = this.roomLiveStatus.get(id) || false;
const isLive = result.isLive;

// 开播条件：isLive=true 且 (wasLive=false 或 当前不在录制中)
const shouldStartRecording = isLive && (!wasLive || room.status !== 'recording');

if (shouldStartRecording) {
  // 开播检测
}

// 启动录制条件：isLive=true 且 当前不在录制中
if (isLive && room.status !== 'recording' && (result.streamUrl || result.streamInfo)) {
  await this._tryStartRecording(room, result);
}
```

### 经验总结

| 教训                       | 说明                                               |
| -------------------------- | -------------------------------------------------- |
| **不要完全依赖缓存状态**    | 缓存可能过期或不准确，始终以实际状态为准           |
| **结合多重状态判断**        | 同时检查缓存状态和实际状态，避免被单一状态误导     |
| **状态更新后重置缓存状态**  | 房间停止录制后，应该重置相关缓存，避免影响下次判断 |

## 轮询录制循环启动问题：录制冷却期机制

### 问题现象

开发环境中，即使直播间一直在开播，PollingManager 仍然会**每隔一段时间就重新启动录制**，导致产生大量碎片文件。

### 问题根因

录制进程因为流地址失效等原因启动后几秒就退出，录制结束后房间状态立即变回 `idle`。下一次轮询检测到开播时，又会重新启动录制，形成循环。

### 修复方案

**1. 录制冷却期（Redis）**：

在 `RecorderService.finishSession` 中，录制结束后在 Redis 中设置冷却期：

```javascript
// 设置录制冷却期（60秒），防止流地址失效导致频繁重启录制
const cooldownKey = `polling:recording_cooldown:${room.id}`;
await redis.set(cooldownKey, Date.now().toString(), { EX: 60 }).catch(() => {});
```

**2. PollingManager 检查冷却期**：

在 `PollingManager.checkRoom` 中，启动录制前先检查是否有冷却期：

```javascript
// 检查是否有录制冷却期（录制失败后等待一段时间再重新启动）
const cooldownKey = `polling:recording_cooldown:${id}`;
const cooldown = await redis.get(cooldownKey).catch(() => null);
if (cooldown) {
  console.log(`[PollingManager] 录制冷却期，跳过: ${room.room_name || room_url}`);
  return;
}
```

**3. 查询最新房间状态**：

在 `PollingManager` 中，启动录制前先查询数据库的最新状态：

```javascript
const freshRoom = await pool.query('SELECT status, ffmpeg_pid FROM rooms WHERE id = $1', [id]);
const currentStatus = freshRoom.rows[0]?.status;
```

### 经验总结

| 教训                     | 说明                                                                       |
| ------------------------ | -------------------------------------------------------------------------- |
| **录制后需要冷却期**     | 录制失败或退出后，应该等待一段时间再重新启动，避免频繁重启                  |
| **结合多重状态判断**      | 同时检查缓存状态和数据库状态，避免被单一状态误导                            |
| **流地址有时效性**        | 虎牙等平台的流地址可能需要不断刷新，录制过程中需要处理流中断的情况          |

## 自动投稿缺乏完整性检查：在转码完成前就触发投稿

### 问题现象

录制结束后 `findAndAutoUpload` 立即被调用，此时 FLV 文件尚未转码为 MP4，投稿上传的是原始 FLV 文件而非转码后的 MP4 文件。

### 触发链路分析

系统中有 4 个自动投稿触发点：

| 触发点 | 位置 | 调用时机 | 会话状态 | 转码完成 | 风险 |
|--------|------|----------|----------|----------|------|
| finishSession (分段) | RecorderService.js:381 | 录制结束立即 | completed ✅ | ❌ 刚入队 | 上传 FLV |
| finishSession (单FLV) | RecorderService.js:471 | 录制结束立即 | completed ✅ | ❌ 刚入队 | 上传 FLV |
| tryResumeSession | RecorderService.js:1095 | 恢复会话完成 | completed ✅ | ❌ 刚入队 | 上传 FLV |
| scanPendingAutoUpload | UploadService.js:269 | 看门狗定时 | completed ✅ | ✅ 已检查 | **安全** |

**三个 `findAndAutoUpload` 触发点都在转码完成之前就触发，上传的是未转码的 FLV 文件。**

额外风险：`findAndAutoUpload` 和 `scanPendingAutoUpload` 之间可能存在竞赛条件 —— `findAndAutoUpload` 先上传 FLV，转码完成后 `scanPendingAutoUpload` 再上传 MP4，导致重复投稿。

### 修复方案

为 `findAndAutoUpload` 增加**三重前置检查**：

```javascript
static async findAndAutoUpload(session) {
    // 1. 投稿次数限制
    if (!(await this.checkUploadLimit(session.id))) return;

    // 2. 已有投稿记录 → 跳过
    const existingRecords = await pool.query(...);
    if (existingRecords.rows.length > 0) return;

    // 3. 会话状态必须是 completed
    const sess = await pool.query('SELECT status FROM recording_sessions WHERE id = $1', [session.id]);
    if (sess.rows[0]?.status !== 'completed') return;

    // 4. 转码必须完成（所有 FLV → MP4）
    if (!(await this.isSessionTranscodeComplete(session.id))) return;

    // ... 继续投稿流程
}
```

这样 `findAndAutoUpload` 的即时触发点会因为转码未完成而自动跳过，由 `scanPendingAutoUpload`（看门狗）在转码完成后安全地投稿。

### 投稿安全保障矩阵

| 检查项 | findAndAutoUpload | scanPendingAutoUpload |
|--------|:---:|:---:|
| 会话状态 = completed | ✅ 新增 | ✅ SQL WHERE |
| 转码完成 | ✅ 新增 | ✅ isSessionTranscodeComplete |
| 无已有投稿记录 | ✅ 已有 | ✅ NOT EXISTS SQL |
| 投稿次数限制 | ✅ 已有 | ✅ checkUploadLimit |
| 碎片大小过滤 | ✅ executeUpload 内 | ✅ executeUpload 内 |
| 文件存在性 | ✅ executeUpload 内 | ✅ executeUpload 内 |

### 经验总结

| 教训 | 说明 |
|------|------|
| **投稿必须等转码** | FLV 文件不能直接投稿，必须转为 MP4 后再上传 |
| **即时触发 ≠ 安全触发** | 录制结束立即触发看似快捷，实则跳过了关键的前置条件 |
| **看门狗模式更安全** | `scanPendingAutoUpload` 的定时扫描模式天然保证了前置条件 |
| **多重检查防竞赛** | 同时检查"已有记录"和"转码完成"避免并发重复投稿 |
| **兜底机制分层设计** | 即时触发（快速路径）+ 看门狗（兜底保障），但快速路径也必须满足所有条件 |

## 录制中断却通知"录制完成"：通知与状态不同步

### 问题现象

正式环境中收到通知：

```
✅ 录制完成
直播间：KSG无言
文件：1 段
大小：0.0 MB
会话ID：19
```

但数据库中 `recording_sessions.status = 'interrupted'`，文件实际 0 字节，ffmpeg 异常退出。

### 问题根因

`finishSession` 中的状态判断逻辑：

```javascript
let sessionStatus = 'completed';
if (fileSize === 0 && code !== 0) {
  sessionStatus = 'interrupted';  // ← 正确给 DB 写入了 interrupted
}
// UPDATE recording_sessions SET status = $1  ← DB 已更新为 interrupted

// 但通知却…
notify.recordingComplete(...);  // ← 始终发送"录制完成"，不管实际状态
```

`sessionStatus` 变量只用于 UPDATE 查询，通知函数 `notify.recordingComplete()` 没有接收状态参数，永远发送 ✅ 录制完成。

### 修复方案

**1. 通知函数增加状态参数**（`lib/core/notify.js`）：

```javascript
async function recordingComplete(roomName, fileCount, totalMB, sessionId, roomUrl, status = 'completed') {
  if (status === 'interrupted') {
    send('⚠️ 录制中断',
      `直播间：${roomName}\n文件：${fileCount} 段\n大小：${totalMB} MB\n会话ID：${sessionId}\n\n录制异常中断，文件可能不完整`);
  } else {
    send('✅ 录制完成',
      `直播间：${roomName}\n文件：${fileCount} 段\n大小：${totalMB} MB\n会话ID：${sessionId}`);
  }
}
```

**2. `finishSession` 传入实际状态**（`services/RecorderService.js`）：

```javascript
// 从数据库查询实际更新后的状态，而不是使用局部变量（防止 UPDATE 被 WHERE 条件跳过）
const sess = await pool.query(
  'SELECT status, total_segments, total_size FROM recording_sessions WHERE id = $1',
  [sessionId]
);
const status = sess.rows[0]?.status || 'completed';
notify.recordingComplete(room.room_name, segs, mb, sessionId, room.room_url, status);
```

### 经验总结

| 教训 | 说明 |
|------|------|
| **通知和状态必须同步** | 不能在 DB 里写 interrupted，通知却说 completed |
| **查询最新状态再通知** | 从 DB 重新查询状态，避免 UPDATE 被 WHERE 条件跳过导致不一致 |
| **默认参数保持兼容** | `status = 'completed'` 作为默认值，不影响任何已有调用 |

## 会话复用（reuseSession）导致正常录制被误判为中断

### 问题现象

正式环境会话 19，主播正常下播，但 `recording_sessions.status = 'interrupted'`。通知显示"大小：0.0 MB"，实际前几轮录制已有内容。

### 问题根因

轮询系统频繁重启录制（流地址过期导致 ffmpeg 几秒退出），`reuseSession` 模式复用同一会话。状态判断只看**最后一批**文件的增量：

```javascript
let sessionStatus = 'completed';
if (fileSize === 0 && code !== 0) {
    sessionStatus = 'interrupted'; // ← 只看当前批次
}

// reuseSession 时 UPDATE 用当前批次的状态覆盖
await pool.query(
    `UPDATE recording_sessions SET status = $1, ... WHERE id = $2`,
    [sessionStatus, sessionId]
);
```

**问题链条**：
```
第1轮: 录了 50MB → total_size=50MB, 会话仍在 recording 状态
第2轮: 录了 30MB → total_size=80MB, 会话仍在 recording 状态
第3轮: 流地址过期, fileSize=0, code≠0 → sessionStatus='interrupted' → 覆盖整个会话！
```

虽然前几轮已累积 80MB 内容，但最后一轮的失败直接把整个会话标记为"中断"。

### 修复方案

在 `reuseSession` 模式下，如果本次判断为 `interrupted`，先查询数据库中的累积值。只要前几轮有内容，就修正为 `completed`：

```javascript
if (reuseSession && sessionStatus === 'interrupted') {
    const accumulated = await pool.query(
        'SELECT total_segments, total_size FROM recording_sessions WHERE id = $1',
        [sessionId]
    );
    if ((accumulated.rows[0]?.total_segments || 0) > 0 ||
        (accumulated.rows[0]?.total_size || 0) > 0) {
        await pool.query(
            `UPDATE recording_sessions SET status = 'completed' WHERE id = $1`,
            [sessionId]
        );
    }
}
```

修改了分段模式（第 344-379 行）和单文件模式（第 431-470 行）两个路径。

### 经验总结

| 教训 | 说明 |
|------|------|
| **复用会话用累积值判断** | `reuseSession` 时状态不能只看增量，要看累积量 |
| **增量状态 ≠ 整体状态** | 每批文件的新增状态与整个会话的最终状态是两回事 |
| **回查数据库修正状态** | UPDATE 后回查累积值，必要时用二次 UPDATE 修正 |

## 续播时文件名错误：`_resume` 后缀无意义

### 问题现象

`reuseSession` 模式下，录制文件被重命名成 `MrGemini_20260518_234839_resume_2.flv` 这种格式。

### 问题根因

两个位置产生了无意义的 `_resume` 后缀：

1. `tryResumeSession`（会话恢复）中拼接了 `_resume_${retryCount + 1}`
2. `generateOutputPath` 在 `reuseSession` 时直接复用上次的 `room.output_path`，而这个路径可能来自上一次 `tryResumeSession` 的 `_resume` 文件名

FFmpeg 没有文件级续传（append）功能，每次启动都是全新录制，加 `_resume` 后缀毫无意义反而造成文件名混乱。

### 修复方案

1. `tryResumeSession` 直接用模板文件名，不再加 `_resume_N` 后缀
2. `generateOutputPath` 移除 `reuseSession` 路径复用逻辑，始终用模板生成新文件名

```javascript
// tryResumeSession — 修复前
const parsed = path.parse(base);
outputPath = path.join(DOWNLOAD_DIR, `${parsed.name}_resume_${retryCount + 1}${parsed.ext}`);

// tryResumeSession — 修复后
outputPath = path.join(DOWNLOAD_DIR, base);

// generateOutputPath — 移除 reuseSession 路径复用
// 不再设置 outputFilePattern = prevOutput
```

### 经验总结

| 教训 | 说明 |
|------|------|
| **文件名不应暗示"续传"** | FFmpeg 不支持文件续传，`_resume` 后缀让文件名误导 |
| **模板优先原则** | 始终用数据库配置的文件名模板，保持一致性 |

## 全面碎片/脏数据审计：修复 6 个隐藏风险

### 审计范围

覆盖录制启动→录制结束→看门狗清理→转码队列全链路，共发现 15 个风险点，修复了 6 个高风险/中风险问题。

### 修复的风险

#### 1. RoomService active_task key 格式不一致

**问题**: `RoomService.stopRecording()` 和 `RoomService.deleteRoom()` 使用 `active_task:room:${roomUrl}`，而 `RecorderService` 使用 `active_task:${roomUrl}`（无 `room:` 前缀），导致停止/删除房间时 Redis key 无法清除，录制请求被阻塞长达 24 小时。

**修复**: 统一 key 格式为 `active_task:${roomUrl}`。

代码位置：
- [RoomService.js:L107](file:///Users/virola/code/projects/live_recorder_server/services/RoomService.js#L107)
- [RoomService.js:L175](file:///Users/virola/code/projects/live_recorder_server/services/RoomService.js#L175)

#### 2. 转码计数器无 TTL 崩溃泄露

**问题**: `transcode_processing_count` 计数器无 TTL，Node 进程崩溃（OOM、kill -9）后计数永久 +1 不恢复，导致转码队列并发槽永久阻塞。

**修复**: 
- `decrementProcessingCount` 中 count ≤ 0 时删除 key
- 启动时调用 `resetProcessingCount` 重置计数器

代码位置：
- [TranscodeQueue.js:L180-L195](file:///Users/virola/code/projects/live_recorder_server/lib/core/TranscodeQueue.js#L180-L195)
- [TranscodeQueue.js:L25](file:///Users/virola/code/projects/live_recorder_server/lib/core/TranscodeQueue.js#L25)

#### 3. ffmpeg close 事件 TOCTOU 竞态

**问题**: `startRecording` 中先检查 `exitCode`，如未退出再注册 `close` handler。在检查和注册之间 ffmpeg 可能退出，导致 `close` 事件丢失、`finishSession` 永不调用。

**修复**: 先注册 `close` handler，再检查是否已退出；已退出则手动 `emit('close')` 触发 handler。

代码位置：
- [RecorderService.js:L867-L870](file:///Users/virola/code/projects/live_recorder_server/services/RecorderService.js#L867-L870)

#### 4. 启动清理遗漏 recording_files 状态更新

**问题**: `cleanupStaleRecordings` 对重试次数耗尽、未续播的会话仅标记 `recording_sessions.status='interrupted'`，不更新 `recording_files` 中状态为 `recording` 的记录，导致永久卡住。

**修复**: 同步更新 `recording_files SET status='interrupted'`。

代码位置：
- [RecorderService.js:L1198-L1203](file:///Users/virola/code/projects/live_recorder_server/services/RecorderService.js#L1198-L1203)

#### 5. 碎片清理不递归子目录

**问题**: `cleanupFragmentFiles` 仅扫描下载目录顶级，不处理子目录中的碎片文件。`scanRecordingFiles` 会递归发现子目录文件但 `cleanupFragmentFiles` 不清除它们。

**修复**: 用 `fs.readdirSync` + `withFileTypes: true` 递归遍历所有子目录。

代码位置：
- [watchdog.js:L249-L262](file:///Users/virola/code/projects/live_recorder_server/lib/core/watchdog.js#L249-L262)

#### 6. 转码失败残留孤儿 MP4

**问题**: `transcoder.fastTranscode` 失败（code ≠ 0 或超时 kill）后可能残留不完整的 MP4 文件，既不删除也不通知。

**修复**: 转码失败后 `fs.unlinkSync(mp4Path)` 清理残留产物。

代码位置：
- [TranscodeQueue.js:L133-L141](file:///Users/virola/code/projects/live_recorder_server/lib/core/TranscodeQueue.js#L133-L141)

### 未修复的低风险问题（保留观察）

| 问题 | 风险 | 理由 |
|------|------|------|
| PollingManager 双重检查无锁 | 低 | 有 `isActiveTask` Redis 兜底，冲突仅产生 400 错误 |
| .segments_*.txt 残留 | 低 | 文件极小（<1KB），不影响功能 |
| scanActiveSegments 5 分钟窗口 | 低 | `finishSession` 已正常处理，看门狗仅作二次兜底 |
| pause/resume 失败后状态不一致 | 低 | 极少触发，且看门狗最终会修正 |

## ffmpeg `+discardcorrupt` 导致虎牙直播流全变碎片文件

### 问题现象

commit `216d46f` 修改 ffmpeg 下载参数后，虎牙直播流下载全部变碎片文件——每次启动 ffmpeg 几秒就退出，产生 1-2MB 的碎片。

### 问题根因

对比 v1.0（正常工作）与当前的 ffmpeg 参数差异：

```
v1.0 (正常):                          216d46f (碎片):
-fflags +genpts                       -fflags +genpts+discardcorrupt  ← 🔴
(无)                                  -err_detect ignore_err           ← 🟡
-reconnect_delay_max 60               -reconnect_delay_max 120         ← 🟢
```

**`+discardcorrupt`** 是根本原因。该 flag 告诉 ffmpeg **主动丢弃**它认为损坏的数据包。虎牙 HTTP-FLV 直播流包含一些非标准格式特征（尤其是初始握手阶段的流数据），ffmpeg 将其判定为 corruption 并丢弃。当关键包（SPS/PPS、关键帧）被丢弃后，解码器断裂，ffmpeg 正常退出（exit code 0，不是 crash）。

`-err_detect ignore_err` 本意是忽略错误、防退出，但它作用于解码/解复用层的错误，而 `+discardcorrupt` 在更底层就直接丢弃了数据包——`err_detect` 根本看不到这些包，无从处理。

### 修复方案

回退 `buildArgs()` 到 v1.0 参数：

```
- '-fflags', '+genpts+discardcorrupt'  →  '-fflags', '+genpts'
- '-reconnect_delay_max', '120'        →  '-reconnect_delay_max', '60'
- '-err_detect', 'ignore_err'          →  删除
```

### 经验总结

| 教训 | 说明 |
|------|------|
| **ffmpeg 参数改一发动全身** | 看似无害的 flag 可能彻底改变流处理行为 |
| **discardcorrupt ≠ 修复残缺流** | 它只是丢弃，不是修复。非标直播流中的数据被误判为 corruption，丢弃后流就断了 |
| **err_detect 和 discardcorrupt 不是互补的** | err_detect 在解码层、discardcorrupt 在输入层——后者在前者之前就丢掉了数据 |
| **回退到已知工作版本是最快修复** | 遇到参数导致的问题，优先比对 git 历史找到破坏性提交 |
