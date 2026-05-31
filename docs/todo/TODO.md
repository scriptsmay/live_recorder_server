# TODO

<!-- 这个目录存放后续开发计划文档。 -->

## 后续开发计划

1. [快手直播弹幕录制与视频弹幕压制开发计划](KUAISHOU_DANMAKU_RECORDING_PLAN.md)

## 遗留问题记录

> 以下问题已于 2026-05-30 修复，详见 commit 记录。

1. ~~录制结束时发送通知，内容中提到9段文件，实际只有4段~~ → **已修复**：`_handleSessionFinish` 中 `fs.statSync` 缺少 per-file try/catch，数据库残留记录指向已不存在的文件时整个循环中断，导致 `fileCount` 不准确。已为每个文件单独捕获异常，不存在的文件跳过并打印警告。

2. ~~会话管理列表中显示 `分片: 1 段`，实际应该是 4~~ → **已修复**：`_handleSessionFinish` 更新 `recording_sessions` 时 `total_segments` 硬编码为 `1`，已改为写入实际的 `fileCount`。

3. ~~手动投稿 modal 提交后一直卡在 “正在提交投稿...请稍候”~~ → **已修复**：`executeUpload` 中 `await biliup.upload()` 阻塞了整个 HTTP 请求直到上传完成（可能几十分钟）。已将上传逻辑提取为 `_runUpload()` 后台执行，`executeUpload` 创建 `upload_records` 记录后立即返回响应。
