# TODO

<!-- 这个目录存放后续开发计划文档。 -->

## 已完成计划

均已移出。

## 待完成计划

1. 回放投稿时使用 poster 作为视频封面
   - `ReplayUploadService.executeUpload()` 中，当 `record.poster` 非空时，下载封面到本地临时文件，作为 biliup 的 `--cover` 参数
   - 投稿预览 `getUploadPreview()` 可返回 poster URL 供前端展示

2. 移除 `shared_scripts` 命名卷，改为镜像内置 scripts
   - **背景**：`docker-compose.yml` 中 `volumes: shared_scripts:/app/scripts` 导致 Docker 命名卷只在首次创建时从镜像播种内容，后续镜像更新 scripts/ 永远被旧 volume 屏蔽（v1.8.0 部署时已踩坑，详见 KB 发布记录）
   - **方案**：`replay_cron` 容器已使用同一镜像构建，本身携带 scripts，无需共享卷。直接删除 `shared_scripts` 卷定义和两个服务的 volume 挂载即可
   - **替代方案**：若仍需共享，在 `docker-entrypoint.sh` 启动时 rsync 镜像内 `/app/scripts.image/` 到 volume 挂载点
   - **优先级**：下个版本（v1.8.1 或 v1.9.0）处理

## 已废弃 / 转移

- ~~测试弹幕视频压制~~：v1.8.0 起弹幕压制迁至独立的 [danmaku-tool](https://github.com/scriptsmay/danmaku-tool) 项目，本仓库不再承担压制相关的测试与生产化工作。
