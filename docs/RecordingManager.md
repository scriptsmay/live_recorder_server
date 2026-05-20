# RecordingManager - 录制管理器

## 概述

`RecordingManager` 是负责管理 ffmpeg 外部调用相关业务逻辑的核心模块。它将原本分散在 `RecorderService` 中的进程管理、日志处理、会话恢复等职责抽离出来，形成独立的业务层。

## 主要职责

1. **录制进程管理**
   - 启动和监控 ffmpeg 录制进程
   - 处理进程的 stdout/stderr 流
   - 管理进程生命周期（启动、运行、结束）

2. **分段录制支持**
   - 执行视频切片和转码任务
   - 处理分段文件的合并和管理

3. **会话恢复机制**
   - 恢复中断的录制会话
   - 管理重试逻辑和状态更新

4. **日志管理**
   - 统一的日志记录机制
   - 自动日志滚动和归档
   - 会话ID关联的日志文件命名

## 架构设计

### 与 RecorderService 的关系

```
RecorderService (业务协调层)
    ↓
RecordingManager (进程管理层)
    ↓
Downloader/Segmenter (工具层)
    ↓
ffmpeg (外部进程)
```

- **RecorderService**: 负责业务逻辑协调、权限验证、数据库交互
- **RecordingManager**: 负责 ffmpeg 进程的直接管理和控制
- **Downloader/Segmenter**: 提供具体的 ffmpeg 命令构建和执行能力

### 核心方法

#### startRecordingProcess()
启动录制进程，返回进程对象和日志管理接口。

#### startSegmentTask()
执行分段录制任务，调用 segmenter 进行视频切片。

#### resumeSession()
恢复中断的录制会话，包含完整的进程重启和状态同步逻辑。

#### updateSessionToDatabase()
将录制会话状态同步到数据库。

#### initNonSegmentFileRecord()
初始化非分段录制的文件记录。

## 使用示例

```javascript
const recordingManager = require('../lib/core/RecordingManager');

// 启动录制进程
const { process, logPath, renameLog } = await recordingManager.startRecordingProcess({
  downloader,
  streamUrl: 'rtmp://...',
  outputPath: '/path/to/output.flv',
  options: {
    segmentDuration: 60,
    platform: 'huya',
    isStreamUrl: true,
  },
  sessionId: null,
});

// 更新会话到数据库
const sessionId = await recordingManager.updateSessionToDatabase({
  room,
  outputPath,
  pid: process.pid,
  // ... 其他参数
});

// 重命名日志文件
renameLog(sessionId);
```

## 设计原则

1. **单一职责**: 每个方法专注于特定的 ffmpeg 操作
2. **资源管理**: 自动管理进程、日志流等资源的生命周期
3. **错误处理**: 统一的异常处理和日志记录
4. **解耦设计**: 与数据库和 Redis 交互保持最小依赖
5. **可测试性**: 清晰的接口边界便于单元测试

## 注意事项

- 所有异步操作都需要正确处理错误和超时
- 进程结束后必须调用 `destroyLog()` 释放日志资源
- 会话恢复时需要检查重试次数限制
- 分段录制和非分段录制的处理逻辑不同，需要分别处理
