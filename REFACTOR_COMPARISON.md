# 重构前后对比示例

## 之前的代码结构（RecorderService.js 中）

```javascript
// 在 RecorderService.startRecording 方法中直接管理 ffmpeg 进程
static async startRecording({ url, title, caption, room_url }) {
  // ... 验证逻辑 ...
  
  const downloader = await getActiveDownloader(room.polling_platform);
  const dlArgs = downloader.buildArgs(url, outputFilePattern, options);
  
  // ❌ 直接在服务层创建和管理进程
  const procLog = createProcLog(downloader.name);
  const { stream: logStream, rename: renameLog, logCommand } = procLog;
  logCommand(downloader.name, dlArgs);
  
  const dlProcess = downloader.spawn(dlArgs);
  
  if (dlProcess.stderr) {
    dlProcess.stderr.on('data', (chunk) => logStream.write(chunk));
  }
  if (dlProcess.stdout) {
    dlProcess.stdout.on('data', (chunk) => logStream.write(chunk));
  }
  
  dlProcess.on('error', (err) => {
    console.error(`${downloader.name} 启动失败:`, err);
  });
  
  // ... 数据库更新 ...
  // ... 文件记录初始化 ...
  // ... 活跃任务设置 ...
}
```

**问题**：
- 进程管理、日志处理、数据库操作混杂在一起
- 代码冗长，难以维护
- 相似逻辑在 tryResumeSession 中重复

## 重构后的代码结构

### RecordingManager.js（新增模块）

```javascript
class RecordingManager {
  /**
   * 启动录制进程 - 封装所有进程管理逻辑
   */
  startRecordingProcess({ downloader, streamUrl, outputPath, options, sessionId }) {
    const dlArgs = downloader.buildArgs(streamUrl, outputPath, options);
    
    const procLog = createProcLog(downloader.name, sessionId);
    const { stream: logStream, rename: renameLog, logCommand } = procLog;
    
    logCommand(downloader.name, dlArgs);
    const dlProcess = downloader.spawn(dlArgs);
    
    // 统一处理 stdout/stderr
    if (dlProcess.stderr) {
      dlProcess.stderr.on('data', (chunk) => logStream.write(chunk));
    }
    if (dlProcess.stdout) {
      dlProcess.stdout.on('data', (chunk) => logStream.write(chunk));
    }
    
    dlProcess.on('error', (err) => {
      console.error(`${downloader.name} 启动失败:`, err);
    });
    
    return {
      process: dlProcess,
      logStream,
      logPath: procLog.logPath,
      renameLog,
      destroyLog: () => procLog.destroy(),
    };
  }
  
  /**
   * 更新会话到数据库 - 封装数据库操作
   */
  async updateSessionToDatabase({ room, outputPath, pid, sessionId, ... }) {
    // ... 数据库更新逻辑 ...
    return finalSessionId;
  }
  
  /**
   * 恢复会话 - 完整的会话恢复逻辑
   */
  async resumeSession(session) {
    // ... 会话恢复的完整实现 ...
  }
}
```

### RecorderService.js（简化后）

```javascript
static async startRecording({ url, title, caption, room_url }) {
  // ... 验证逻辑保持不变 ...
  
  const downloader = await getActiveDownloader(room.polling_platform);
  const outputFilePattern = this.generateOutputPath(...);
  
  // ✅ 委托给 RecordingManager 处理进程启动
  const { process: dlProcess, logPath, renameLog } = recordingManager.startRecordingProcess({
    downloader,
    streamUrl: url,
    outputPath: outputFilePattern,
    options: {
      segmentDuration,
      platform: room.polling_platform,
      isStreamUrl: true,
    },
    sessionId: null,
  });
  
  // ✅ 委托给 RecordingManager 处理数据库更新
  const sessionId = await recordingManager.updateSessionToDatabase({
    room,
    outputPath: outputFilePattern,
    pid: dlProcess.pid,
    sessionId: null,
    sessionStart,
    reuseSession,
    resumeCount,
    caption,
    streamUrl: url,
  });
  
  renameLog(sessionId);
  
  // ✅ 委托给 RecordingManager 初始化文件记录
  if (!useSegment) {
    await recordingManager.initNonSegmentFileRecord({
      sessionId,
      room,
      outputPath: outputFilePattern,
    });
  }
  
  // ... 后续的业务逻辑保持不变 ...
}

// ✅ 会话恢复也委托给 RecordingManager
static async tryResumeSession(session) {
  await recordingManager.resumeSession(session);
}
```

## 优势对比

| 方面 | 重构前 | 重构后 |
|------|--------|--------|
| **职责清晰度** | ❌ 混杂 | ✅ 清晰分离 |
| **代码行数** | ❌ 1078行 | ✅ ~900行 + 450行独立模块 |
| **可维护性** | ❌ 难以定位问题 | ✅ 职责明确，易于调试 |
| **可测试性** | ❌ 难以单独测试 | ✅ 可独立测试各模块 |
| **代码复用** | ❌ 重复代码多 | ✅ 逻辑集中，易于复用 |
| **扩展性** | ❌ 修改影响面大 | ✅ 模块化，影响面小 |

## 架构层次

```
┌─────────────────────────────────────┐
│         API Layer (router/)         │  HTTP 接口
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│    Service Layer (RecorderService)  │  业务协调、权限验证
└──────────────┬──────────────────────┘
               │ 委托
┌──────────────▼──────────────────────┐
│  Manager Layer (RecordingManager)   │  进程管理、会话控制
└──────────────┬──────────────────────┘
               │ 调用
┌──────────────▼──────────────────────┐
│   Tool Layer (Downloader/Segmenter) │  命令构建、工具函数
└──────────────┬──────────────────────┘
               │ 执行
┌──────────────▼──────────────────────┐
│        External (ffmpeg process)    │  外部进程
└─────────────────────────────────────┘
```

## 关键改进点

1. **单一职责原则**：每个模块只负责一个方面的功能
2. **依赖倒置**：高层模块不依赖低层实现细节
3. **开闭原则**：新增功能无需修改现有代码
4. **接口隔离**：清晰的接口边界，便于替换和扩展
5. **DRY 原则**：消除重复代码，提高可维护性
