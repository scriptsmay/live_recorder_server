# TODO

## 0. recording_files 文件跟踪表（已实现）

新增 `recording_files` 表独立跟踪录制文件在磁盘上的生命周期。

- 非分段录制：ffmpeg 启动时 INSERT `recording`，完成时 UPDATE `completed`
- 分段录制：ffmpeg 退出时为每段 INSERT `completed`
- 启动扫描 `scanRecordingFiles()` 遍历 `VIDEO_DOWNLOAD_DIR`，标记 `missing` / `orphaned`
- 三条路径同步更新该表：启动清理、看门狗、新录制关闭旧会话
- 投稿时回退到 `recording_files` 查找文件

详见 `docs/DB.md`。



## 1. 浏览器扩展 1 分钟轮询优化（已实现）

浏览器扩展（`chrome_live_listener`）每分钟轮询时不再一律 POST `live_download`，
而是先通过 `GET /api/notify/status` 查询录制状态，已在录制中则跳过。

- 服务端：新增 `GET /api/notify/status?url=<room_url>` 轻量查询接口
- 扩展侧：`sendToBackend()` 先 GET 查状态，仅当闲置时 POST 发起录制

## 2. 浏览器扩展 URL 变更自动更新 ffmpeg

检测到直播间流地址变化时，自动更新本服务器正在录制的 ffmpeg 下载地址。

- 扩展侧：已在 1 分钟轮询中拿到最新 FLV URL
- 服务端侧：新增 `PUT /api/rooms/:id/stream_url` 端点，杀掉旧 ffmpeg 并用新 URL 重启
- 不引入 WebSocket（MV3 Service Worker 不适合维持长连接，HTTP 轮询足够）

## 3. 僵死录制状态看门狗（已实现）

ffmpeg 异常退出后 rooms / recording_sessions 状态卡在 `recording` 的问题。

- 已实现：`app.js` 中 `checkStaleRecordings()` 每 5 分钟检查一次
  - 检查 ffmpeg 进程是否存活
  - 检查输出文件是否超过 10 分钟未修改
  - 异常时自动清理状态
- 待观察：当前录制结束后验证效果

## 4. 检查完成录制后自动投稿的流程是否正常

现在已经将直播间ID=6, 和投稿模板ID=4 关联成功；现在直播间正在录制中，等待完成后查看投稿记录。

## 5. 外部命令日志（已实现）

所有外部命令（ffmpeg、biliup）的 stderr/stdout 通过 `lib/proc-log.js` 重定向到 `logs/` 目录：

- `logs/ffmpeg_<sessionId>.log` — ffmpeg 录制日志
- `logs/biliup_<recordId>.log` — biliup 投稿日志

用法：`createProcLog('ffmpeg')` 或 `createProcLog('biliup', recordId)`，
返回 `{ stream, logPath, rename }`，stream 可直接作为 spawn 的 stdio 参数。
