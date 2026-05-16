# 开发踩坑记录

## 下载引擎集成后的一系列连锁问题

### 背景

将 stream-gears（Rust 编写的 Python 库）通过 factory 模式集成到项目后，出现了一系列相互关联的 Bug，核心症状是**录制文件变成孤文件（orphaned）**以及**会话续播失败**。

### 问题链

```
SIGTERM → Rust Drop 不执行 → .flv.part 未重命名为 .flv
  → close handler 扫描目录找不到 .flv → 无 recording_files 记录 → 孤文件
  → 续播时 close handler 再跑一次 → recording_files 重复 INSERT
  → 文件名正则写错 (.* 里的 . 被转义) → 永远匹配不到文件
  → 启动时只清理 ffmpeg 进程，不管 stream-gears 的 .part 文件
```

### 逐层修复

#### 1. 文件名扫描 Regex 错误 (`router/api.js`)

**症状**：close handler 中非 ffmpeg 下载器的分段文件扫描永远返回空列表。

**原因**：

```js
// 错误：.replace(/\./g, '\\.') 连 .* 里的 . 也转义了
const regex = new RegExp('^' + pattern.replace(/\./g, '\\.') + '$');
// 结果：/^KSG小屿_\.*\.*\.*_\.*\.*\.*\.flv$/ → 匹配零个或多个字面点号
```

**修复**：只对扩展名的 `.` 转义，`.*` 通配符保持原样：

```js
const prefix = base.replace(/%[YmdHMS]/g, '.*').replace(/\.\w+$/, '');
const ext = path.extname(base);
const regex = new RegExp('^' + prefix + ext.replace(/\./g, '\\.') + '$');
```

#### 2. 续播时 recording_files 重复 INSERT (`router/api.js`)

**症状**：每次 close handler 跑都往 `recording_files` 插一遍相同文件。

**修复**：插入前检查 `recording_files` 是否已有该文件路径，有则跳过。

#### 3. 会话续播匹配不到 interrupted 状态的会话 (`router/api.js`)

**症状**：进程异常退出后状态为 `interrupted`，续播只查 `status = 'completed'`，永远匹配不到。

**修复**：改为 `status IN ('completed', 'interrupted')`。

#### 4. resumeCount 变量赋值为 total_segments 而非 session ID (`router/api.js`)

**症状**：`UPDATE recording_sessions WHERE id = total_segments`（例如 id=0），永远更新不到任何行。

**原因**：

```js
// 错误：存了 total_segments 值
resumeCount = recent.rows[0].total_segments || 0;
// 后续用 resumeCount 当 sessionId
UPDATE recording_sessions SET ... WHERE id = $1  [resumeCount]
```

**修复**：改为存 `recent.rows[0].id`。

#### 5. 停止录制后文件变孤文件 (`router/rooms.js`)

**症状**：点击"停止录制"后，已下载的文件没有 `recording_files` 记录。

**原因**：stream-gears 的 Rust `FlvFile::Drop` 在收到 SIGTERM 后可能来不及执行（`.part → .flv` 重命名不跑）。而 close handler（`dlProcess.on('close')`）是异步的，rooms.js 的 stop 处理不等它完成就返回了。close handler 扫描不到 `.flv` 文件（因为 .part 没被重命名），所以没有创建 recording_files 记录。

**修复**：stop 处理中杀死进程后，同步扫描输出目录：

- 发现 `.flv.part` → 重命名为 `.flv`
- 发现 `.flv`/`.mp4` 且不在 `recording_files` 中 → 插入为 `completed`

#### 6. 启动清理不处理 stream-gears 残留 (`app.js` + `scripts/cleanup-dev.js`)

**症状**：服务重启 / 进程崩溃后，`.flv.part` 文件永远留在磁盘上。

**原因**：`cleanupStaleRecordings()` 只 `pkill -f "ffmpeg"`，不处理 Python/stream-gears 进程，也不扫 `.part` 文件。

**修复**：在清理循环中：

- 遍历每个脏房间的 `output_path` 目录
- 重命名 `.flv.part` → `.flv`
- 将 untracked 的 `.flv`/`.mp4` 写入 `recording_files`

#### 7. Redis stale active_task 残留

**症状**：`POST /api/notify/live_download` 返回 `"Already recording"`，但房间实际已空闲。

**原因**：手动删 DB 或意外中断后，`active_task:{roomKey}` 留在 Redis 中。`isActiveTask()` 检查 Redis 返回 true，拒绝新录制。

**修复**：`cleanupStaleRedis()` 在启动时自动清理（检查房间状态，不是 `recording` 则删 key）。

#### 8. stream-gears 生成 download.log

**症状**：项目根目录出现 `download.log`。

**原因**：stream-gears 的 Rust 代码硬编码了 `tracing_appender::rolling::never("", "download.log")`。

**处理**：加入 `.gitignore`。

#### 9. 看门狗杀掉 stream-gears 进程 (`app.js`)

**症状**：录制不断中断（`[null]` 退出码），分段文件全是 1133 字节（仅 FLV 头部，无媒体数据）。

**原因**：看门狗（`checkStaleRecordings`）检查 `.flv`/`.mp4` 文件的 mtime 来判断录制是否僵死。stream-gears 在分段间隔内一直写 `.flv.part`，只在分段边界才重命名为 `.flv`。当 `segment_duration`（600s）远大于 `watchdog_timeout`（60s）时，看门狗跑完一轮后发现 60 秒内没有 `.flv` 变更 → 判定僵死 → SIGTERM 杀掉进程。

**修复**：mtime 检查也包含 `.part` 后缀的文件。

### 经验总结

| 教训                                        | 说明                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| **不要依赖异步 close handler 做关键持久化** | 进程被 SIGTERM 后 close handler 可能不跑或跑不完，关键数据写入应在同步路径完成 |
| **外部进程的信号处理要了解**                | Rust 的 `Drop` 在 SIGTERM 下可能不执行，Python 进程同理                        |
| **Regex 构造要逐层验证**                    | 两个 replace 叠加时中间结果的 `.` 会被转义器错杀                               |
| **变量名语义要准确**                        | `resumeCount` 存的是 ID 不是 count，误导后续维护                               |
| **启动清理要覆盖所有下载引擎**              | 不能只针对 ffmpeg                                                              |
| **看门狗要了解下载引擎的工作模式**          | stream-gears 用 `.part` 文件，ffmpeg 直接写 `.mp4`，mtime 检查不能只看最终文件 |
| **Redis 状态要有兜底清理**                  | `cleanupStaleRedis` 在启动时扫一遍                                             |
| **FLV 不能靠浏览器原生播放**                | 需集成 flv.js（MSE），且 stream URL 不带 `.flv` 后缀，需单独传扩展名判断       |
| **两张表的数据源要统一**                    | `recording_files` 是文件主表，`recordings` 是元数据表，流媒体端点也要查两者     |
| **nodemon 默认不监听 .ejs**                 | 改模板文件不会自动重启，需加 `--ext js,mjs,cjs,json,ejs`                       |
| **心跳解析器导出但未调用**                  | `parseHeartbeat()` 在 `heartbeat-parser.js` 中正确定义，但 `heartbeat-tracker.js` 中只导入了 `isRetry`，导致任何 stderr 输出都被当作心跳，应显式调用 `parseHeartbeat` 判断后才更新时间戳 |
| **WorkerPool 不要模块各自创建**             | 两个模块各自 `new FSWorkerPool(2)` → 4 个 Worker。应导出共享单例 `getWorkerPool()` |
| **spawn 签名变更后要更新接口**              | `downloaders` 的 `spawn` 不再接收 `logFd`，但 `DownloaderInterface` 的参数名仍为 `_logFd`，误导性强 |
| **SQL 中避免模板字符串拼接数值**            | `total_size = ${sizeTotal}` 依赖内部值但风格不一致，应用参数化查询分开 `SET` 赋值情形 |
| **stream-gears FLV 解析受限**               | Rust 库 `httpflv.rs` 对某些快手 FLV 流解析失败（`parse tag data err`），需自动回退到 ffmpeg |
| **续播不能 append 到旧文件**                | FLV/MP4 容器无文件级 append 机制，服务器重启恢复时只能生成新文件（`_resume_N`），无法续接残片 |
