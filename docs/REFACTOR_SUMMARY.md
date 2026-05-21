# 项目重构总结

## 一、RecorderService 重构

### 重构背景

原 `RecorderService.js` 文件包含超过 1000 行代码，其中大量涉及 ffmpeg 外部调用的业务逻辑，导致：

- 文件过长，难以维护
- 职责不清晰，业务逻辑和进程管理混杂
- 代码复用性差，相似逻辑在多处重复

### 重构目标

将 ffmpeg 外部调用相关的业务逻辑抽离到独立模块，参考 `lib/core/` 下现有模块的架构模式。

### 重构内容

#### 1. 新建 RecordingManager 模块

**文件位置**: `/lib/core/RecordingManager.js`

**主要功能**:

- ✅ 录制进程的启动和监控 (`startRecordingProcess`)
- ✅ 分段录制任务执行 (`startSegmentTask`)
- ✅ 会话恢复机制 (`resumeSession`)
- ✅ 内部辅助方法（文件名生成、Redis 操作等）
- ✅ 更新会话输出路径 (`updateSessionOutputPath`)

**设计特点**:

- 采用单例模式导出，与 `segmenter`、`transcoder` 保持一致
- 使用 JSDoc 注释规范，符合项目代码规范
- 统一的日志管理机制，复用 `createProcLog` 工具
- 清晰的进程生命周期管理

#### 2. 简化 RecorderService

**文件位置**: `/services/RecorderService.js`

**移除的内容**:

- ❌ `startSegmentTask` 方法（已移至 RecordingManager）
- ❌ 大量的 ffmpeg 进程管理代码
- ❌ 重复的文件名生成逻辑

**保留的内容**:

- ✅ 房间管理和缓存逻辑
- ✅ 录制请求验证和权限检查
- ✅ 业务协调和流程控制
- ✅ 数据库交互和状态管理
- ✅ 通知和自动上传触发

**改进点**:

- 代码行数从 1078 行减少到约 900 行
- 职责更加清晰：专注于业务协调而非进程管理
- 通过委托模式调用 RecordingManager 处理底层操作

### 架构优化

```
之前:
RecorderService (1078行)
├── 房间管理
├── 录制验证
├── 进程启动 ⚠️ 混杂
├── 日志管理 ⚠️ 混杂
├── 会话恢复 ⚠️ 混杂
└── 文件处理

之后:
RecorderService (~900行)          RecordingManager (~450行)
├── 房间管理                      ├── 进程启动 ✅
├── 录制验证                      ├── 日志管理 ✅
├── 业务协调 ──────委托────→      ├── 会话恢复 ✅
├── 状态管理                      ├── 文件记录 ✅
└── 通知触发                      └── 辅助方法 ✅
```

---

## 二、输出文件路径重构

### 重构背景

原设计的直播录制文件保存路径都是在 `VIDEO_DOWNLOAD_DIR` 下按文件名模板平铺，存在以下问题：

- 文件名容易冲突
- 看门狗全局扫描效率低
- 难以区分不同会话的文件

### 重构目标

将录制文件的保存路径增加层级结构：`VIDEO_DOWNLOAD_DIR/[roomId]/[sessionId]/[filename]`

### 重构内容

#### 1. 更新工具函数

**文件位置**: `/lib/utils/tool.js`

- 修改 `generateOutputPath()` 函数，支持传入 `roomId` 和 `sessionId` 参数
- 新增 `getSessionDir()` 和 `getRoomDir()` 辅助函数

#### 2. 更新录制服务

**文件位置**: `/services/RecorderService.js`

- 修改 `startRoomRecording()` 方法，先创建会话获取 `sessionId`，再生成带层级的输出路径
- 自动创建会话目录

#### 3. 更新文件扫描逻辑

**文件位置**: `/lib/core/scan-files.js`

- 修改 `scanRecordingFiles()` 函数，根据路径中的 `roomId/sessionId` 直接匹配会话

#### 4. 更新看门狗扫描逻辑

**文件位置**: `/lib/core/watchdog.js`

- 修改 `scanActiveSegments()` 函数，从会话表获取 `output_dir` 字段进行扫描
- 修改 `cleanupFragmentFiles()` 函数，仅扫描已完成/中断会话的目录

### 新的目录结构

```
VIDEO_DOWNLOAD_DIR/
├── 1/                           # roomId
│   ├── 1001/                    # sessionId
│   │   ├── 直播间_A_20240101_120000.ts
│   │   └── 直播间_A_20240101_123000.ts
│   └── 1002/
│       └── 直播间_A_20240102_150000.ts
└── 2/
    └── 2001/
        └── 直播间_B_20240101_100000.ts
```

### 优势

- ✅ 避免文件名冲突：每个会话有独立的目录
- ✅ 便于管理：按房间和会话组织文件
- ✅ 扫描效率提升：看门狗可以只扫描特定会话目录
- ✅ 投稿简化：直接从会话目录获取文件

---

## 三、下载器优化

### 重构背景

原项目存在两个下载器（FFmpegDownloader 和 TsDownloader），功能重复，维护成本高。

### 重构目标

统一使用 FFmpegDownloader，移除冗余的 TsDownloader，同时优化 FFmpeg 参数配置。

### 重构内容

#### 1. 优化 FFmpegDownloader

**文件位置**: `/lib/core/downloaders/FFmpegDownloader.js`

- 默认输出格式从 `.flv` 改为 `.ts`（容错性更强）
- 新增用户代理（User-Agent）伪装，防止 CDN 403 拦截
- 添加完整的网络重连参数
- 添加协议白名单
- 增强容错机制（`discardcorrupt`、`correct_ts_overflow`、`avoid_negative_ts`）
- 优化队列大小和缓冲区配置

#### 2. 简化 DownloaderFactory

**文件位置**: `/lib/core/downloaders/DownloaderFactory.js`

- 移除对 TsDownloader 的引用
- 所有平台统一使用 FFmpegDownloader

#### 3. 删除冗余文件

- ❌ `/lib/core/downloaders/TsDownloader.js`

### FFmpeg 参数优化

```
核心参数：
- -rw_timeout 30000000        # 读写超时设为 30 秒
- -reconnect 1               # 启用自动重连
- -reconnect_at_eof 1        # EOF 时重连
- -reconnect_streamed 1      # 流式传输时重连
- -reconnect_delay_max 60    # 最大重试延迟
- -user_agent [浏览器UA]      # 伪装浏览器
- -protocol_whitelist [协议]  # 协议白名单
- -c copy                    # 直接拷贝流
- -fflags +genpts+igndts+discardcorrupt  # 容错与时间戳修复
- -thread_queue_size 1024    # 队列大小
- -max_muxing_queue_size 2048 # 最大复用队列大小
```

---

## 技术细节

### 循环依赖处理

在 `RecordingManager` 中需要调用 `RecorderService.getSetting()` 时，采用了动态 require 的方式避免循环依赖：

```javascript
const RecorderService = require('../../services/RecorderService');
const autoTranscode = await RecorderService.getSetting('auto_transcode', 'true');
```

### 资源管理

- 日志流在进程结束后自动销毁
- Redis 键统一管理，使用私有方法封装
- 进程错误处理和异常捕获完善

### 兼容性保证

- 所有对外接口保持不变
- 数据库交互逻辑完全一致
- Redis 键格式和 TTL 值保持原样
- 通知和上传触发时机不变

---

## 测试建议

### 单元测试

1. RecordingManager 各方法的独立测试
2. FFmpegDownloader 参数构建测试
3. 文件路径生成逻辑测试

### 集成测试

1. 完整录制流程测试（启动 → 运行 → 结束）
2. 分段录制和非分段录制的对比测试
3. 会话恢复功能的端到端测试
4. 文件扫描和追踪测试

### 回归测试

1. 确保现有 API 接口正常工作
2. 验证数据库状态更新正确
3. 检查通知和上传功能正常触发

---

## 后续优化方向

1. **进一步拆分**: 可以考虑将 `_handleSegmentFinish` 和 `_handleNonSegmentFinish` 也抽离到独立的处理器
2. **事件驱动**: 引入事件机制解耦录制完成后的处理逻辑
3. **配置化**: 将硬编码的阈值和超时时间提取为配置项
4. **监控增强**: 添加更详细的性能指标和监控日志

---

## 相关文件

- `/lib/core/RecordingManager.js` - 录制管理器
- `/lib/core/RecordingManager.md` - 使用文档
- `/services/RecorderService.js` - 录制服务
- `/lib/core/downloaders/FFmpegDownloader.js` - FFmpeg 下载器
- `/lib/core/downloaders/DownloaderFactory.js` - 下载器工厂
- `/lib/core/watchdog.js` - 看门狗模块
- `/lib/core/scan-files.js` - 文件扫描模块
- `/lib/utils/tool.js` - 工具函数

---

## 总结

本次重构包含三个主要部分：

1. **RecorderService 重构**：将 ffmpeg 进程管理逻辑抽离到 RecordingManager
2. **文件路径重构**：引入层级目录结构 `[roomId]/[sessionId]/[filename]`
3. **下载器优化**：统一使用 FFmpegDownloader，移除 TsDownloader

重构后：

✅ 代码结构更加清晰，易于理解和维护  
✅ 遵循项目现有的架构模式和代码规范  
✅ 保持了所有原有功能和业务逻辑  
✅ 提高了代码的可测试性和可扩展性  
✅ 文件管理更加高效，避免冲突  
✅ 下载器配置更加健壮，提升录制稳定性
