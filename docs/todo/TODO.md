# TODO

## 弃用 stream-gears

快手直播流使用非标准 FLV 格式（HEVC codec + 自定义 tag），stream-gears 的 Rust 解析库重复崩于 `parse tag data err`。决定弃用 stream-gears，只保留 ffmpeg 作为下载引擎。

### 影响范围

- `lib/downloaders/StreamGearsDownloader.js` — 删除整个文件
- `lib/downloaders/DownloaderFactory.js` — 移除 stream-gears 探测和回退逻辑
- `lib/downloaders/stream_gears_wrapper.py` — 删除 wrapper 脚本
- `router/api.js` — 移除 `finishSession` 中的 fallback 逻辑（不再需要）
- `settings` 表移除 `downloader` 选项（始终用 ffmpeg）

### 待办项

- [ ] 删除 `StreamGearsDownloader.js`
- [ ] 删除 `stream_gears_wrapper.py`
- [ ] 简化 `DownloaderFactory.js`（移除 stream-gears 探测）
- [ ] 简化 `finishSession`（移除 fallback 分支）
- [ ] `docs/ARCHITECTURE.md` 更新下载引擎章节
- [ ] `docs/lessons.md` 更新经验表
- [ ] `docs/DB.md` 更新 settings 表说明
