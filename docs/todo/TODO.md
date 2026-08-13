# TODO

<!-- 这个目录存放后续开发计划文档。 -->

## 已完成计划

均已移出。

## 待完成计划

1. 回放投稿时使用 poster 作为视频封面
   - `ReplayUploadService.executeUpload()` 中，当 `record.poster` 非空时，下载封面到本地临时文件，作为 biliup 的 `--cover` 参数
   - 投稿预览 `getUploadPreview()` 可返回 poster URL 供前端展示

2. `shared_scripts` 命名卷屏蔽镜像 scripts 更新 → **v1.8.2 已实现**
   - **背景**：`volumes: shared_scripts:/app/scripts` 导致 Docker 命名卷只在首次创建时从镜像播种，后续镜像更新 scripts/ 永远被旧 volume 屏蔽（v1.8.0 部署踩坑）
   - **实现**：`Dockerfile` build 时 `cp -a /app/scripts /app/scripts.image`；`docker/scripts/docker-entrypoint.sh` 启动早期 `cp -a /app/scripts.image/. /app/scripts/` 刷新 volume。replay_cron 镜像与挂载不变
   - **详细计划**：见 KB `projects/live-recorder-server/changelog/2026-08-13-v1-8-2-plan.md`
   - **发布注意**：仅改 scripts 未改主服务代码时，需 `up -d --force-recreate live_recorder_server` 触发同步；回滚到 ≤v1.8.1 镜像时卷内仍是新版脚本

## 已废弃 / 转移

- ~~测试弹幕视频压制~~：v1.8.0 起弹幕压制迁至独立的 [danmaku-tool](https://github.com/scriptsmay/danmaku-tool) 项目，本仓库不再承担压制相关的测试与生产化工作。
