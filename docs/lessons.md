# 开发踩坑记录

## 开发环境怎么杀死进程

```bash
lsof -ti :3001 | xargs kill -9 2>/dev/null; sleep 1; echo "已停止旧进程"
```

## docker 镜像中，含有中文的文件名似乎不被biliup能识别，从而导致无法上传【已解决】

已解决，在 Dockerfile 中添加：

```dockerfile
# 设置环境变量，强制系统使用 UTF-8
ENV LANG C.UTF-8
ENV LC_ALL C.UTF-8
```

已部署的 docker-compose.yml 中添加环境变量:

```yml
services:
  your-service-name:
    image: your-image-name
    # 添加以下环境变量配置
    environment:
      - LANG=C.UTF-8
      - LC_ALL=C.UTF-8
    # 其他配置...
    volumes:
      - /path/on/host:/data/video_downloads
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

## 录制中断处理的设计理念

### 核心原则

**文件永远应该是从录制开始那一刻新生成的，即使遇到网络抖动等因素的直播中断，也应该被准确处理，而不是简单粗暴的合并文件。**

### 设计背景

FFmpeg 不支持直播流的文件续传功能：
- 直播流是实时的，服务器不会保留之前的流数据
- 重新连接只能从当前时间点获取流，无法"记住"之前写入到哪里
- 因此，即使技术上能续写同一个文件，中间缺失的部分也无法找回

### 正确的设计实现

#### 1. 文件名包含精确到秒的时间戳

```javascript
// tool.js
const vars = {
  room_name: sanitizeFilename(roomName || 'unknown'),
  datetime: dateObj.format('YYYYMMDD_HHmmss'),  // 20240520_143052
  // ...
};
```

#### 2. 每次录制都是全新的文件

```javascript
// RecorderService.js - startRecording()
const sessionStart = new Date();  // 每次录制都是新的时间点
const outputFilePattern = this.generateOutputPath(downloader, template, ..., sessionStart, ...);
```

#### 3. 会话复用只是数据库层面的概念

```javascript
// finishSession() 中的处理逻辑
if (reuseSession) {
  // 累加到现有会话的统计（只是数据库统计）
  total_segments = total_segments + $2,
  total_size = total_size + $3
} else {
  // 创建新的会话记录
  total_segments = $2,
  total_size = $3
}
```

### 实际效果示例

```
14:30:52 - 网络抖动，第一次录制结束 → 生成 room_20240520_143052.flv
14:31:05 - 恢复录制，第二次录制开始 → 生成 room_20240520_143105.flv
14:32:30 - 再次抖动，第三次录制结束 → 生成 room_20240520_143230.flv
```

- 三个文件**物理独立**，保留原始录制数据
- 数据库层面归到同一个"会话"，方便管理
- **绝不合并文件**，保证数据完整性

### 设计优势

| 优势 | 说明 |
| ---- | ---- |
| **数据完整性** | 保留每个时间点的完整原始数据，不伪造缺失部分 |
| **清晰可追溯** | 用户可以清晰看到录制的时间线和中断点 |
| **无副作用** | 不做有损的文件合并，避免引入伪数据 |
| **简单可靠** | 避免复杂的文件追加逻辑，降低出错概率 |
| **便于修复** | 如果某个分段损坏，其他分段不受影响 |

### 错误的设计方式

❌ **不要**尝试续传同一个小文件
- 中间缺失的数据无法找回，续写的内容会与原文件时间不连续
- FFmpeg 无法合并两个时间不连续的视频流
- 强行合并会产生播放时的时间跳跃或音画不同步

❌ **不要**合并多个分段为一个文件
- 网络抖动期间的数据丢失会"被消失"
- 用户误以为获得了完整内容，实际上中间可能有几分钟的空白
- 不利于后期修复和定位问题

## 自动投稿触发机制

### 设计决策

**录制结束时不应立即尝试自动投稿，应该完全依赖看门狗定期扫描。**

### 原因

1. **避免竞态条件**
   - 录制结束时，FFmpeg 进程刚关闭
   - 但转码队列可能还在处理其他分段
   - 边下边转码的最后一个分段可能还在队列中

2. **第一次调用几乎总是失败**
   ```javascript
   // 录制结束时调用 findAndAutoUpload()
   if (!(await isSessionTranscodeComplete(session.id))) {
     // 转码未完成 → 立即 return
     return;
   }
   ```
   - 几乎总是因为"转码未完成"而立即返回
   - 产生无意义的日志噪音

3. **看门狗已经足够**
   - 每30秒扫描一次，时间窗口合理
   - 能够覆盖所有场景
   - 简单可靠，无竞态风险

### 实际实现

**唯一触发点：看门狗定期扫描**

```javascript
// watchdog.runWatchdog() - 每30秒执行
async function runWatchdog() {
  await scanActiveSegments();      // 扫描并标记完成文件
  await cleanupFragmentFiles();     // 清理碎片文件
  await syncMissingFiles();         // 同步缺失文件
  await UploadService.scanPendingAutoUpload(); // 自动投稿
}
```

**扫描条件（7天内的会话）**：
1. ✅ `status = 'completed'`
2. ✅ `upload_template_id IS NOT NULL`
3. ✅ 无 `uploading`/`success` 的记录（避免重复）
4. ✅ 转码全部完成（无待转 FLV、无队列任务）

### 设计优势

| 优势 | 说明 |
| ---- | ---- |
| **无竞态** | 转码队列和投稿完全解耦，不会出现竞态条件 |
| **简单可靠** | 单一触发点，易于理解和维护 |
| **及时响应** | 看门狗30秒扫描，能及时发现可投稿的会话 |
| **避免重复** | 统一检查机制，防止重复投稿 |
