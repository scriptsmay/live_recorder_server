# TODO

## 1. 检查完成录制后自动投稿的流程是否正常

- 自动投稿功能待测试。

## 2. 浏览器扩展 URL 变更自动更新 ffmpeg

检测到直播间流地址变化时，自动更新本服务器正在录制的 ffmpeg 下载地址。

- 扩展侧：已在 1 分钟轮询中拿到最新 FLV URL
- 服务端侧：新增 `PUT /api/rooms/:id/stream_url` 端点，杀掉旧 ffmpeg 并用新 URL 重启
- 不引入 WebSocket（MV3 Service Worker 不适合维持长连接，HTTP 轮询足够）

## 7. 投稿后处理扩展：OSS 备份

`after_upload` 扩展支持云对象存储（如阿里云 OSS / AWS S3），方案：

- `after_upload` 新增一个值 `oss`，前端下拉框增加对应选项
- 新建 `lib/upload-oss.js`，实现 `uploadToOSS(files, logKey)`，使用对应 SDK（`@ali/oss` / `@aws-sdk/client-s3`）上传
- `lib/backup.js` 的 `afterUpload()` 增加 `else if (action === 'oss')` 分支，复用现有日志、通知、写回 output 流程
- `.env` 增加 OSS 配置项（`OSS_REGION`、`OSS_BUCKET`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`），更新 `.env.example`

**待办项：**

- [ ] 选择具体 SDK 并实现 `upload-oss.js`
- [ ] 前端下拉框增加「备份到OSS」选项
- [ ] `.env.example` 补充 OSS 配置
- [ ] `docs/DB.md` 补充 `after_upload = 'oss'` 说明
