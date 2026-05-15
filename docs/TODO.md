# TODO

## ✅ 已完成：多插件直播录制系统 V1

### 1. 架构设计与环境准备

- [x] **依赖调研**：确认 `stream-gears` 为 Rust 编写的 PyO3 Python 库，非 Node.js 原生模块，通过 child_process 包装调用。
- [ ] **安装依赖**：如需使用 stream-gears，需手动 `pip install stream-gears`（Python 3.8+）。
- [x] **配置架构设计**：`settings` 表新增 `downloader` 字段（默认 `ffmpeg`），支持全局切换下载引擎。
- [x] **并发管理方案**：录制进程通过 `child_process.spawn()` 隔离，不阻塞 Node.js 事件循环。

### 2. 核心模块实现

- [x] **定义下载器接口 (DownloaderInterface)**：
  - `lib/downloaders/DownloaderInterface.js`
  - 方法：`buildArgs()` / `spawn()` / `stop()` / `pause()` / `resume()` / `isRunning()`

- [x] **实现 Stream-Gears 插件**：
  - `lib/downloaders/StreamGearsDownloader.js`
  - 通过 `python3 lib/downloaders/stream_gears_wrapper.py` 调用 stream-gears。
  - 启动时自动探测 stream-gears 可用性，不可用时工厂回退到 ffmpeg。
  - 异常重连：stream-gears 库内置指数退避重试（最多 3 次，1s/2s/4s 间隔）。

- [x] **保留 FFmpeg 插件 (Fallback)**：
  - `lib/downloaders/FFmpegDownloader.js`
  - 封装现有 ffmpeg 命令参数构建与进程管理。
  - 作为 stream-gears 不可用时的默认/备选方案。

### 3. 业务逻辑集成

- [x] **任务工厂 (DownloaderFactory)**：
  - `lib/downloaders/DownloaderFactory.js`
  - `getActiveDownloader()` — 从 `settings` 表读取 `downloader` 配置，动态实例化对应插件。
  - 自动探测 stream-gears 可用性，fallback 到 ffmpeg。
  - 启动时、恢复录制时均通过工厂获取下载器。

- [x] **状态监控与日志**：
  - 进程日志文件名改为 `{downloader.name}_{sessionId}.log`。
  - stream-gears 底层日志通过 stderr 输出到日志文件。

### 4. 前端与交互

- [x] **配置界面更新**：
  - 全局设置页面新增"下载插件"下拉菜单（选项：`ffmpeg` / `stream-gears`）。

- [x] **状态可视化**：
  - 直播间管理页面顶部显示当前下载引擎 badge。
  - `GET /api/notify/status` 返回 `downloader` 字段。

### 5. 测试与优化

- [ ] **稳定性测试**：模拟国内直播间断流、网络波动，验证 `stream-gears` 的自动修复效果。
- [ ] **资源审计**：对比录制同等质量流时，`stream-gears` 方案与 `ffmpeg` 进程的 CPU/内存占用情况。

---

## 代码结构

```
lib/downloaders/
├── DownloaderInterface.js    # 抽象基类
├── FFmpegDownloader.js       # ffmpeg 插件（默认）
├── StreamGearsDownloader.js  # stream-gears 插件（Python 包装）
└── DownloaderFactory.js      # 工厂：根据 settings 选择引擎
```

## 🛠 AI 执行提示 (Prompt Hint)

> "请基于 Node.js 环境，参考工厂模式重构录制模块。优先使用 `stream-gears` 库处理 FLV 流，并确保在任务崩溃时有完善的重连逻辑。注意：录制过程需在独立线程运行，不要阻塞主进程。"
