# RecordingManager - 录制管理器

## 概述

`RecordingManager` 是负责管理 ffmpeg 外部调用相关业务逻辑的核心模块。它将原本分散在 `RecorderService` 中的进程管理、日志处理等职责抽离出来，形成独立的进程管理层。

## 主要职责

1. **录制进程管理**
   - 启动和监控 ffmpeg 录制进程
   - 处理进程的 stdout/stderr 流
   - 管理进程生命周期（启动、运行）

2. **分段录制支持**
   - 执行视频切片和转码任务
   - 处理分段文件的合并和管理

3. **会话恢复机制**
   - 通过调用 `RecorderService.startRoomRecording()` 恢复中断的录制会话
   - 适用于手动恢复或启动时恢复遗留会话

4. **日志管理**
   - 统一的日志记录机制
   - 会话ID关联的日志文件命名

## 架构设计

### 与 RecorderService 的关系

```
RecorderService (业务协调层)
    ├── 权限验证、数据库交互
    ├── 录制会话生命周期管理
    └── finishSession() + _handleSessionFinish() 负责会话结束处理
           ↓
RecordingManager (进程管理层)
    ├── startRecordingProcess() 启动 ffmpeg
    ├── startSegmentTask() 分段录制
    └── resumeSession() 恢复录制（调用 RecorderService）
           ↓
Downloader/Segmenter (工具层)
    ↓
ffmpeg (外部进程)
```

- **RecorderService**: 负责业务逻辑协调、权限验证、数据库交互、会话结束处理
- **RecordingManager**: 负责 ffmpeg 进程的直接管理和控制
- **Downloader/Segmenter**: 提供具体的 ffmpeg 命令构建和执行能力

### 核心方法

#### startRecordingProcess()

启动录制进程，返回进程对象和日志管理接口。

#### startSegmentTask()

执行分段录制任务，调用 segmenter 进行视频切片。

#### resumeSession()

通过调用 `RecorderService.startRoomRecording()` 恢复中断的录制会话。适用于：

- 手动恢复已中断的录制会话（延迟窗口外）
- 启动时恢复遗留会话

### 会话结束处理

会话结束处理由 `RecorderService` 负责：

- `RecorderService.finishSession()` - 主流程，处理冷却期、通知
- `RecorderService._handleSessionFinish()` - 更新会话状态、统计信息、清理碎片
- 看门狗（watchdog）- 全权负责磁盘文件处理（扫描、入库、转码）

## 设计原则

1. **单一职责**: 每个方法专注于特定的 ffmpeg 操作
2. **资源管理**: 自动管理进程、日志流等资源的生命周期
3. **错误处理**: 统一的异常处理和日志记录
4. **解耦设计**: 会话结束和文件处理交由 `RecorderService` 和看门狗负责
5. **复用逻辑**: 恢复录制时调用 `RecorderService` 复用完整录制流程

## 注意事项

- 所有异步操作都需要正确处理错误和超时
- 会话结束和文件处理由 `RecorderService` + 看门狗负责，不在 `RecordingManager` 中处理
- 恢复录制时会验证 `stream_url` 是否存在
