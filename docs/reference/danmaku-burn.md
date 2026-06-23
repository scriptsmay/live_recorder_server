# 弹幕压制参考

## 视觉稳定性默认值

2026-06-23 起，弹幕压制默认值偏向可观看性和运动稳定性：

- 密度：`danmaku_density_per_second = 15`
- 1080p 字号：`danmaku_font_size = 38`
- 不透明度：`danmaku_opacity = 0.88`
- 描边：`danmaku_outline_width = 2`
- 阴影：默认关闭
- 屏幕占用：默认上方约 60%
- 滚动速度：默认约 150px/s，并按文本宽度计算离屏终点

数据库迁移只会把仍停留在旧默认值的配置升级到新默认值，避免覆盖已明显自定义的弹幕配置。

## FFmpeg 滤镜链

弹幕压制先规整直播分段时间轴和帧率，再渲染 ASS：

```text
setpts=PTS-STARTPTS,fps=30,ass='path/to/segment.ass',format=yuv420p
```

原因：

- 直播 TS/MP4 分段可能存在轻微 PTS 不均匀，直接渲染 `\move()` 会放大横向滚动抖动。
- `fps=30` 让字幕在稳定帧间隔上渲染，压制成本比 60fps 更可控。
- 需要临时验证更高帧率时，可设置环境变量 `DANMAKU_BURN_FPS=60`。代码会将该值限制在 24-60 范围内。

## 开发验证

使用开发环境会话 `id=22` 验证：

- 输入视频：`dev_downloads/2/22/test_video.mp4`
- 分段 ASS：`dev_downloads/2/22/danmaku/segments/154.ass`
- 输出视频：`dev_downloads/2/22/test_video_danmaku_test_offset.mp4`

可用测试脚本重新生成 ASS 并压制：

```bash
NODE_ENV=development node scripts/test-danmaku-burn-session.js 22 --normalize-start
```

常用参数：

- `--normalize-start`：减去 JSONL 中首条 comment 的 `ts_ms`，适合测试数据整体偏移较大的场景。
- `--offset-ms <ms>`：手动指定额外偏移，可与 `--normalize-start` 叠加。
- `--segment-id <id>`：指定要压制的 `recording_files.id`，默认取会话第一个分段。
- `--output <path>`：指定测试输出文件路径。
- `--fps <24-60>`：指定压制输出帧率，默认 30。

验证结果：

- 输出为 1920x1080、30fps、`yuv420p`、60 秒。
- FFmpeg 日志显示 libass 正常加载 ASS 文件和字体。
- `--normalize-start` 后，测试分段 ASS 从 14 条增加到 56 条，5 秒截图确认弹幕可见。
