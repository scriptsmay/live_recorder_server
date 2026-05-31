# TODO

<!-- 这个目录存放后续开发计划文档。 -->

## 后续开发计划

1. [快手直播弹幕录制与视频弹幕压制开发计划](KUAISHOU_DANMAKU_RECORDING_PLAN.md)

## 遗留问题记录

还是一个录制完成后文件个数统计存在问题，通过查看日志发现，目录下理论上只有2段的ts视频文件，计算出来却有14段。
且通过多次`自动转码已禁用，跳过转码任务`能判断出录制完成后尝试加入转码队列的次数确实超过计数。

### 排查结论（2026-05-31）

已修复。根因是参数命名不一致：

- `RecorderService._handleSessionFinish()` 调用 `DataService.getRecordingFiles({ sessionId })`
- `DataService.getRecordingFiles()` 只读取 `session_id`

因此 `sessionId` 被忽略，SQL 没有拼上 `WHERE session_id = ...`，录制结束时实际扫描了整个 `recording_files` 表。日志中出现 14 次 `自动转码已禁用，跳过转码任务`，就是全表 14 条有效录制文件被逐条处理导致的。

修复方式：

- 调用处改为显式传 `session_id`
- `DataService.getRecordingFiles()` 同时兼容 `session_id` 和 `sessionId`
- 新增 `test/data-service.test.js` 覆盖按会话过滤，避免回归
- 增加 finishSession 文件记录数量日志，便于后续排查

HLS 生成不是本次文件数错误的根因。HLS 分片位于 `hls_*` 子目录，当前会话完成统计错误发生在查询数据库文件记录阶段。

涉及代码片段： `RecorderService.js`:

```javascript
const { fileSize, fileCount } = await this._handleSessionFinish({
  sessionId,
  code,
});

// 这里的 fileCount 数量有误
```

考虑1： RecorderService.js L329-L334: 这里更新数据库结果是否需要输出日志？

考虑2：是否开启了 HLS 生成的功能会影响数据库文件数判断？

### 附

相关问题日志输出如下：

```text
[看门狗] downloader name: ffmpeg
[2026-05-31 20:51:04] [INFO] [看门狗] 检测: KSG无言 (pid=63257, 进程=true, 文件过时=false)
[2026-05-31 20:51:53] [INFO] [PollingManager] 状态检查: KSG子旗 wasLive=false isLive=false roomStatus=idle
[2026-05-31 20:52:04] [INFO] [看门狗] downloader name: ffmpeg
[2026-05-31 20:52:04] [INFO] [看门狗] 检测: KSG无言 (pid=63257, 进程=true, 文件过时=false)
[2026-05-31 20:52:55] [INFO] [PollingManager] 状态检查: KSG子旗 wasLive=false isLive=false roomStatus=idle
[2026-05-31 20:53:04] [INFO] [看门狗] downloader name: ffmpeg
[2026-05-31 20:53:04] [INFO] [看门狗] 检测: KSG无言 (pid=63257, 进程=true, 文件过时=false)
[2026-05-31 20:53:53] [INFO] [PollingManager] 状态检查: KSG子旗 wasLive=false isLive=false roomStatus=idle
[2026-05-31 20:54:04] [INFO] [看门狗] downloader name: ffmpeg
[2026-05-31 20:54:04] [INFO] [看门狗] 检测: KSG无言 (pid=63257, 进程=true, 文件过时=false)
[2026-05-31 20:54:04] [INFO] [分段追踪] KSG无言: 20260531_204011.ts (789.3MB)
[2026-05-31 20:54:04] [INFO] [HLS] ffmpeg -i /data/video_downloads/2/18/20260531_204011.ts -c copy -f hls -hls_time 10 -hls_list_size 0 -hls_segment_filename /data/video_downloads/2/18/hls_20260531_204011/segment_%03d.ts /data/video_downloads/2/18/hls_20260531_204011/playlist.m3u8
[2026-05-31 20:54:39] [INFO] [看门狗][HLS] 已为文件 20260531_204011.ts 生成 HLS
[2026-05-31 20:54:54] [INFO] [PollingManager] 状态检查: KSG子旗 wasLive=false isLive=false roomStatus=idle
[2026-05-31 20:55:39] [INFO] [看门狗] downloader name: ffmpeg
[2026-05-31 20:55:39] [INFO] [看门狗] 检测: KSG无言 (pid=63257, 进程=true, 文件过时=false)
[2026-05-31 20:55:55] [INFO] [PollingManager] 状态检查: KSG子旗 wasLive=false isLive=false roomStatus=idle
[2026-05-31 20:55:56] [INFO] FFmpeg 下载完成
[2026-05-31 20:55:56] [INFO] [finishSession][0] 录制结束，路径: /data/video_downloads/2/18/%Y%m%d_%H%M%S.ts (日志: logs/ffmpeg_18.log)
[2026-05-31 20:55:56] [INFO] 自动转码已禁用，跳过转码任务
[2026-05-31 20:55:56] [INFO] 自动转码已禁用，跳过转码任务
[2026-05-31 20:55:56] [INFO] 自动转码已禁用，跳过转码任务
[2026-05-31 20:55:56] [INFO] 自动转码已禁用，跳过转码任务
[2026-05-31 20:55:56] [INFO] 自动转码已禁用，跳过转码任务
[2026-05-31 20:55:56] [INFO] 自动转码已禁用，跳过转码任务
[2026-05-31 20:55:56] [INFO] 自动转码已禁用，跳过转码任务
[2026-05-31 20:55:56] [INFO] 自动转码已禁用，跳过转码任务
[2026-05-31 20:55:56] [INFO] 自动转码已禁用，跳过转码任务
[2026-05-31 20:55:56] [INFO] 自动转码已禁用，跳过转码任务
[2026-05-31 20:55:56] [INFO] 自动转码已禁用，跳过转码任务
[2026-05-31 20:55:56] [INFO] 自动转码已禁用，跳过转码任务
[2026-05-31 20:55:56] [INFO] 自动转码已禁用，跳过转码任务
[2026-05-31 20:55:56] [INFO] 自动转码已禁用，跳过转码任务
[2026-05-31 20:55:56] [INFO] [RecorderService] 会话录制完成, 共 14 个文件, 24175.7MB
[2026-05-31 20:56:39] [INFO] [UploadService][投稿] 会话 18 转码已完成，启动自动投稿
[2026-05-31 20:56:39] [INFO] [投稿] 会话 18 → 模板 3「无言记事本」已启动
```
