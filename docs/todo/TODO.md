# TODO

<!-- 这个目录存放后续开发计划文档。 -->

## 已完成计划

均已移出。

## 待完成计划

1. 回放投稿时使用 poster 作为视频封面
   - `ReplayUploadService.executeUpload()` 中，当 `record.poster` 非空时，下载封面到本地临时文件，作为 biliup 的 `--cover` 参数
   - 投稿预览 `getUploadPreview()` 可返回 poster URL 供前端展示

## 已废弃 / 转移

- ~~测试弹幕视频压制~~：v1.8.0 起弹幕压制迁至独立的 [danmaku-tool](https://github.com/scriptsmay/danmaku-tool) 项目，本仓库不再承担压制相关的测试与生产化工作。
