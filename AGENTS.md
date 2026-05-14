# Live Recorder Server — 智能体备忘录

## 开发工作流
- `npm run dev` → PM2（使用 `ecosystem.config.js`），启用文件监听
- `npm start` → PM2 生产模式（关闭文件监听）
- `npm run logs` → 查看 PM2 日志
- `npm run restart` / `npm run stop` → PM2 生命周期管理

## 技术栈
- Express 5（CommonJS）、EJS 模板、morgan、cors
- PostgreSQL（`pg` 模块）—— 连接池在 `db/index.js`
- dotenv 以 `quiet: true` 加载 —— 缺少 .env 时静默失败
- 无测试套件（test 脚本为占位）

## 数据库
- 启动时自动迁移建表（`db/migrate.js`），详见 `docs/DB.md`
- 表：`rooms`（直播间状态与配置）、`recordings`（录制历史）
- 连接信息从 `.env` 的 `DB_*` 变量读取

## 关键端点

### API
- `POST /api/notify/live_download` —— 调用 ffmpeg 录制直播流；关联 `rooms` 表，支持自定义文件名模板
- `GET/POST /api/rooms` —— 直播间列表 / 创建（upsert）
- `GET/PUT/DELETE /api/rooms/:id` —— 直播间详情 / 更新 / 删除
- `POST /api/rooms/:id/pause` —— 暂停录制（SIGSTOP）
- `POST /api/rooms/:id/resume` —— 恢复录制（SIGCONT）
- `POST /api/rooms/:id/stop` —— 停止录制（SIGTERM）

### 页面
- `GET /apiview` —— 从 `/` 重定向
- `GET /logs` —— 查看/删除服务器日志

## 关键环境变量
- `VIDEO_DOWNLOAD_DIR` —— 录制端点必需；需确保目录存在或自动创建
- `PORT` —— 默认 1123
- `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` —— PostgreSQL 连接

## 注意事项
- .env 已被 gitignore —— **切勿提交凭据**（本仓库中的 Lark、Redis、Gotify、数据库密码均为真实值）
- 模块系统为 CommonJS（`require`，默认不使用 `import/export`）
- ffmpeg 需单独安装，非 Node 依赖
