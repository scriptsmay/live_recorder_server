# 直播录制自动化流程架构

## 整体流程

```
[Chrome 扩展]                   [Server API]                 [Downloader]              [Post-processing]
     │                               │                            │                         │
     │  POST /notify/live_download   │                            │                         │
     │──────────────────────────────>│                            │                         │
     │                               │   spawn downloader         │                         │
     │                               │───────────────────────────>│                         │
     │                               │                            │    持续写入 .part        │
     │                               │<───────────────────────────│                         │
     │                               │                            │                         │
     │                               │   ─── 看门狗 (每 30s) ─── │                         │
     │                               │   scanActiveSegments()     │                         │
     │                               │   追踪已完成的分片文件     │                         │
     │                               │                            │                         │
     │                               │   进程退出 (stop/崩溃/断流)│                         │
     │                               │<───────────────────────────│                         │
     │                               │   close handler            │                         │
     │                               │   扫描剩余文件, 更新状态   │                         │
     │                               │                            │                         │
     │                               │   findAndAutoUpload()       ───────────────────────>│
     │                               │                            │                         │  biliup upload
```

## 一、会话生命周期

```
                      ┌── 新录制请求 ──────────────────┐
                      │                                │
                      ▼                                │
              ┌──────────────┐                         │
              │  Session     │   在 delay 窗口内        │
              │  (recording) │◄────────────────────────┘
              │              │
              │  看门狗实时   │── 每 30s ──→ scanActiveSegments()
              │  追踪分片     │             写入 recording_files + recordings
              └──────┬───────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   completed    interrupted    recording
   (正常结束)   (异常中断)    (进行中)
```

### 状态定义

| 状态          | 含义     | 触发条件                                             |
| ------------- | -------- | ---------------------------------------------------- |
| `recording`   | 录制中   | POST /notify/live_download 成功                      |
| `completed`   | 正常完成 | close handler 收到 exit code 0                       |
| `interrupted` | 异常中断 | close handler 收到非 0 退出码 / SIGTERM / 看门狗清理 |

### 延迟续播

- 读取 `settings.delay`（默认 60 秒）
- 新录制请求时查询最近一次会话 `ended_at > NOW() - delay`
- 匹配 `status IN ('completed', 'interrupted')`
- 复用会话 ID，不清 zero totals，close handler 累加

---

## 二、文件追踪

### 文件名生成

```
非分段: {room_name}_{datetime}.{ext}
分段:   {room_name}_%Y%m%d_%H%M%S.{ext}
```

- `ext` 由下载引擎决定：ffmpeg → `.mp4`，stream-gears → `.flv`
- stream-gears 内部固定追加 `.flv`，buildArgs 中已去掉 outputPath 的扩展名
- 续播时（非分段 + delay 内）复用上一次的 outputFilePattern

### recording_files 表状态流转

```
                 ┌──────────────┐
     未跟踪      │  (无记录)    │
     磁盘扫描    └──────┬───────┘
         发现新文件      │ 活跃录制目录？
          │         ┌───┴───┐
          │  是     │  否   │
          │         │       │
          ▼         ▼       ▼
    (跳过, wait   orphaned  ──→ close handler 或
      close handler)             启动清理时追踪
```

### 分片追踪时序

```
stream-gears 写入 .part
        │
        │  分段边界 → FlvFile::Drop
        │  .part → .flv (rename)
        │
        ▼
  [1] scanActiveSegments (看门狗 30s 周期)
      → 发现新 .flv，写入 recording_files (completed)
      → 写入 recordings
      → 更新 session total_segments + 1

  [2] close handler (进程退出时)
      → 扫描目录
      → 跳过已在 recording_files 中的文件
      → 处理剩余未追踪文件
      → 更新 session 状态
```

**注意**：stream-gears 的 FlvFile::Drop 在收到 SIGTERM 时可能不执行，导致 `.part` 不重命名。rooms.js stop 处理和启动清理包含 `.part → .flv` 的兜底重命名。

### 文件扫描 (scanRecordingFiles)

- 支持强制扫描和冷却（5 分钟冷却）
- 遍历 VIDEO_DOWNLOAD_DIR，匹配 `\\.(mp4|flv|ts|mkv|avi|mov)$`
- 跳过活跃录制房间（`status = 'recording'`）的输出目录下的文件
- 未追踪文件 → `orphaned`
- DB 有但磁盘无 → `missing`

---

## 三、下载引擎

### 工厂模式

```
DownloaderFactory.getActiveDownloader()
    │
    ├─ settings.downloader = 'ffmpeg'       → FFmpegDownloader (默认)
    └─ settings.downloader = 'stream-gears'  → 探测可用性
         ├─ pip install stream-gears 已安装  → StreamGearsDownloader
         └─ 未安装 → fallback 到 ffmpeg
```

### FFmpegDownloader

- spawn `ffmpeg` 子进程
- 参数：`-c copy -fflags +genpts -reconnect ...`
- 分段模式：`-f segment -segment_time N`
- 扩展名：`.mp4`
- 停止信号：SIGTERM → 进程正常退出 → close handler

### StreamGearsDownloader

- spawn `python3 stream_gears_wrapper.py` 子进程
- Python 脚本调用 Rust 库 `stream_gears.download()`
- 内部处理 FLV tag 修复、断线重试（指数退避 1s/2s/4s）
- 分段模式：`PySegment.time(seconds)`
- 扩展名：`.flv`
- 写入策略：`{file_name}.flv.part` → Drop 时 rename → `{file_name}.flv`
- **注意**：SIGTERM 时 Rust Drop 可能不执行，需兜底重命名

---

## 四、看门狗

### 运行周期

- 读取 `settings.watchdog_interval`（默认 30 秒）
- 最少 10 秒，防止设置错误

### checkStaleRecordings()

1. **进程存活检查**：`process.kill(pid, 0)`
2. **文件僵死检查**：
   - 分段模式：取输出目录下所有 `.mp4`/`.flv`/`.part` 文件的最新 mtime
   - 非分段模式：取 `output_path` 的 mtime
   - 超过 `watchdog_timeout`（默认 60 秒）无变更 → 僵死
3. **清理条件**：进程死亡 或 文件僵死
4. **清理动作**：
   - 杀死进程（SIGTERM → 5s → SIGKILL）
   - 房间设为 idle
   - 会话标为 interrupted
   - recording_files 标为 interrupted

### scanActiveSegments()

- 在每次看门狗周期中运行
- 扫描所有活跃录制房间的输出目录
- 发现未追踪的 `.flv`/`.mp4` → 写入 recording_files + recordings + 更新 session 合计
- 最大延迟 30 秒（一个看门狗周期）

---

## 五、启动清理 (cleanupStaleRecordings)

在 `startup()` 中运行，按顺序：

1. **杀死孤儿进程**：`pkill` ffmpeg + stream_gears_wrapper
2. **处理 .part 残留**：遍历脏房间输出目录，重命名 `.part` → `.flv`
3. **追踪遗留文件**：将 untracked 的 `.flv`/`.mp4` 写入 recording_files
4. **房间复位**：`status = 'idle'`, `ffmpeg_pid = NULL`, `output_path = ''`
5. **尝试恢复会话**：对 status='recording' 的会话调用 tryResumeSession（最多 3 次）
6. **标记录制中断**：recordings + recording_files 中 status='recording' 的标为 interrupted

---

## 六、投稿流程

### 触发

- 录制完成自动触发（`findAndAutoUpload`）
- 手动触发（POST /api/sessions/:id/upload）
- 受 `max_upload_limit` 内存计数限制

### 模板

- `upload_templates` 表存储投稿参数
- 支持变量替换：`{room_name}` `{date}` `{datetime}` 等
- 投稿后处理：`none` / `backup` / `delete` / `backup_and_delete`

### 执行

- 调用 `biliup upload` 子进程
- 输出记录到 `upload_records` 表
- 解析 BV 号，关联到投稿记录

---

## 七、边界情况与容错

| 场景                                 | 处理方式                                        |
| ------------------------------------ | ----------------------------------------------- |
| 进程收到 SIGTERM 后 Rust Drop 不执行 | rooms.js stop 同步扫描 + 重命名 .part           |
| 看门狗误杀正在写 .part 的进程        | mtime 检查包含 .part 文件                       |
| 文件扫描发现活跃录制中的文件         | 跳过该目录，由 close handler 追踪               |
| 录制中途服务器重启                   | startup 清理 + 尝试恢复会话                     |
| stream-gears 不可用                  | 自动回退到 ffmpeg                               |
| 并发录制超过池大小                   | HTTP 429 "Pool full"                            |
| Redis 残留 active_task               | cleanupStaleRedis 启动时清理                    |
| DB 重复 recording_files              | UNIQUE(file_path) 约束 + ON CONFLICT DO NOTHING |
