# Live Recorder Server — 智能体备忘录

## 开发工作流

- `npm start` → PM2 生产模式（关闭文件监听），常规启动
- `npm run stop` → 停止服务
- `npm run logs` → 查看 PM2 日志
- `npm run restart` → PM2 生命周期管理
- ⚠️ **禁止使用 `npm run dev`**（watch 模式会导致频繁重启引发房间状态竞争问题）
- 需要重启时执行 `npm run stop && npm run start`

## 技术栈

- Express 5（CommonJS）、EJS 模板、morgan、cors
- PostgreSQL（`pg` 模块）—— 连接池在 `db/index.js`
- Redis（`redis` 模块）—— 客户端在 `db/redis.js`
- dotenv 以 `quiet: true` 加载 —— 缺少 .env 时静默失败
- 无测试套件（test 脚本为占位）

## 数据库

- 启动时自动迁移建表（`db/migrate.js`），详见 `docs/DB.md`
- 表：`rooms`（直播间）、`recording_sessions`（录制会话）、`recordings`（分片文件）、`recording_files`（磁盘文件跟踪）、`upload_templates`（投稿模板）、`upload_records`（投稿记录）、`settings`（全局设置）
- `rooms` 表新增字段：`notification_enabled`（通知开关）、`monitoring_enabled`（监听开关）
- 启动时自动扫描 `VIDEO_DOWNLOAD_DIR`，将未跟踪文件标记为 `orphaned`，缺失文件标记为 `missing`
- `POST /api/scan_files` 手动触发扫描，5 分钟内重复调用自动跳过（带冷却）
- 连接信息从 `.env` 的 `DB_*` 变量读取
- Redis 缓存直播间数据，写操作后自动失效

## 关键端点

### API

- `POST /api/notify/live_download` —— 调用 ffmpeg 录制直播流；关联 `rooms` 表，支持自定义文件名模板；受 `pool_size` 设置限制并发数；`monitoring_enabled=false` 时返回暂停状态
- `GET /api/notify/status` —— 轻量查询直播间录制状态，返回 `monitoring_paused` 等状态信息
- `GET /api/recording_files` —— 查询文件跟踪记录（支持 `?status=` 筛选）
- `PUT /api/recording_files/:id/associate` —— 将孤文件关联到录制会话
- `GET/POST /api/rooms` —— 直播间列表 / 创建（upsert），支持 `notification_enabled` / `monitoring_enabled`
- `GET/PUT/DELETE /api/rooms/:id` —— 直播间详情 / 更新 / 删除
- `POST /api/rooms/:id/pause` —— 暂停录制（SIGSTOP）
- `POST /api/rooms/:id/resume` —— 恢复录制（SIGCONT）
- `POST /api/rooms/:id/stop` —— 停止录制（SIGTERM）
- `GET /api/settings` —— 查询全局设置列表
- `PUT /api/settings/:key` —— 更新全局设置项

### 投稿

- `GET/POST /api/upload_templates` —— 投稿模板列表 / 创建
- `PUT/DELETE /api/upload_templates/:id` —— 更新 / 删除模板
- `POST /api/sessions/:id/upload` —— 对录制会话执行投稿（需指定模板ID）
- `GET/DELETE /api/upload_records` —— 投稿记录查询 / 删除

### 页面

- `GET /apiview` —— 从 `/` 重定向
- `GET /logs` —— 查看/删除服务器日志
- `GET /templates` —— 投稿模板管理
- `GET /upload_records` —— 投稿记录
- `GET /files` —— 文件管理（孤文件关联会话）
- `GET /sessions` —— 录制会话（含投稿按钮）
- `GET /settings` —— 全局设置（录制/上传参数配置）

## 关键环境变量

- `VIDEO_DOWNLOAD_DIR` —— 录制端点必需；需确保目录存在或自动创建
- `PORT` —— 默认 1123
- `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` —— PostgreSQL 连接
- `BILIUP_PATH` —— biliup 可执行文件路径，默认 `biliup`
- `BILIUP_WORK_DIR` —— biliup 工作目录，默认 `$HOME`

## 日志

- 所有外部命令（ffmpeg、biliup）的输出通过 `lib/proc-log.js` 记录到 `logs/` 目录
- 文件名格式：`{进程名}_{会话ID}.log`

## 注意事项

- .env 已被 gitignore —— **切勿提交凭据**（本仓库中的 Lark、Redis、Gotify、数据库密码均为真实值）
- 模块系统为 CommonJS（`require`，默认不使用 `import/export`）
- ffmpeg 需单独安装，非 Node 依赖
- 全局设置存储于 `settings` 表，启动时自动插入默认值；`watchdog_interval` 修改后下次调度自动生效

## TODO 计划

查看文档[TODO.md](docs/TODO.md)
