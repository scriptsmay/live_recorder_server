# Live Recorder Server — 智能体备忘录

## 开发工作流

- `npm start` → PM2 生产模式（关闭文件监听），常规启动
- `npm run stop` → 停止服务
- `npm run logs` → 查看 PM2 日志
- `npm run restart` → PM2 生命周期管理
- `npm run dev` → node `--watch` 开发模式（端口 3001），**不会影响 PM2 生产进程**。按 Ctrl+C 一次即可完全停止
- 需要重启 PM2 时执行 `npm run stop && npm run start`
- **修改代码后必须更新文档 + 提交代码**：每次完成功能开发或修复后，先更新对应的 `docs/` 文档，再用 `git add`/`git commit` 提交。提交信息格式：`<type>: <description>`

### 开发环境隔离

`npm run dev` 会自动加载 `.env.dev`，覆盖 `.env` 中的以下配置：

| 配置     | 生产 (.env)          | 开发 (.env.dev)        |
| -------- | -------------------- | ---------------------- |
| 端口     | `1123`               | `3001`（命令行指定）   |
| 数据库   | `ks_live_recorder`   | `ks_live_recorder_dev` |
| Redis DB | `1`                  | `2`                    |
| 下载目录 | `VIDEO_DOWNLOAD_DIR` | `./dev_downloads`      |

**首次使用前需创建开发数据库：**

```sql
CREATE DATABASE ks_live_recorder_dev;
```

（表结构会在启动时自动迁移创建）

`dev_downloads/` 和 `dev_biliup/` 目录在项目根目录下自动创建，已加入 `.gitignore`。

### 开发环境管理命令

```bash
npm run dev                          # 前台启动（日志直接看终端，Ctrl+C 一次即停）
tail -f /tmp/dev-server.log          # 后台启动时实时查看日志
kill $(lsof -ti :3001)               # 停止开发服务
lsof -i :3001                        # 检查端口占用
ps aux | grep nodemon | grep -v grep # 检查是否有旧版 nodemon 孤儿进程
pkill -f "nodemon.*app.js"           # 杀死所有旧版 nodemon 孤儿进程
```

**主动重启后建议清理脏数据：**

```bash
node scripts/cleanup-dev.js
```

该脚本会：杀死孤儿进程 → 重命名 `.part` → 清除孤文件 DB 记录 → 中断遗留会话 → 追踪遗留文件到 recording_files。具体实现见 `scripts/cleanup-dev.js`。

- 录制进程日志（ffmpeg 输出）在 `logs/` 目录
- 数据库独立：`ks_live_recorder_dev`（需手动 `CREATE DATABASE`，表结构自动迁移）
- Redis DB 编号：`2`（生产使用 `1`）

## 技术栈

- Express 5（CommonJS）、EJS 模板、morgan、cors
- PostgreSQL（`pg` 模块）—— 连接池在 `db/index.js`
- Redis（`redis` 模块）—— 客户端在 `db/redis.js`
- dotenv 以 `quiet: true` 加载 —— 缺少 .env 时静默失败
- **Jest**（v30.4.2）—— 单元测试和 API 集成测试框架

## 目录结构

```
├── app.js              # 主入口文件
├── lib/                 # 核心模块（与业务无关的通用模块）
│   ├── core/           # 核心功能
│   │   ├── backup.js   # NAS 备份
│   │   ├── downloaders/   # 下载引擎（仅 FFmpeg）
│   │   │   ├── DownloaderFactory.js
│   │   │   ├── DownloaderInterface.js
│   │   │   └── FFmpegDownloader.js
│   │   ├── notify.js      # 通知服务
│   │   ├── polling/       # 直播轮询检测
│   │   │   ├── PlatformChecker.js   # 平台检查器基类（策略模式）
│   │   │   ├── HuyaChecker.js       # 虎牙平台检查器
│   │   │   ├── PollingManager.js    # 轮询管理器（定时调度）
│   │   │   └── index.js
│   │   ├── proc-log.js     # 进程日志
│   │   ├── scan-files.js   # 文件扫描
│   │   ├── transcoder.js   # 视频转码
│   │   ├── TranscodeQueue.js # 转码队列（支持边下边转码）
│   │   └── watchdog.js     # 看门狗
│   └── utils/          # 工具类
│       └── markdown.js
├── router/             # 路由层（API + 页面）
├── services/           # 业务服务层
│   ├── DataService.js      # 公共数据查询（rooms/settings/sessions 等）
│   ├── RecorderService.js  # 录制服务
│   ├── RoomService.js      # 直播间管理服务
│   └── UploadService.js    # 投稿服务
├── db/                 # 数据库
│   ├── index.js
│   ├── migrate.js
│   └── redis.js
├── views/              # EJS 模板
├── public/             # 静态资源
├── scripts/            # 工具脚本
├── logs/               # 日志
├── docs/               # 文档
├── backups/            # 备份
└── test/               # 测试
```

**目录组织原则：**

- `lib/core/` — 核心功能模块，基本与业务逻辑无关（如下载引擎、看门狗、转码）
- `lib/utils/` — 通用工具类（如日志格式化、Markdown 渲染）
- `services/` — 业务服务层，封装具体业务逻辑（如录制、直播间管理、投稿）
- `services/DataService.js` — 集中封装读库查询，供 API 路由与 `router/html.js` 页面渲染共用，避免重复 `pool.query`
- `router/` — 路由层，负责接收请求、调用 Service、返回响应

**页面渲染**：`templates`、`rooms`、`settings`、`sessions`、`upload_records`、`recordings` 由 `router/html.js` 后端 EJS 渲染；`dashboard`、`files` 保留前端 fetch（轮询/交互需求）。

## 代码规范

- **ESLint**（v9 flat config）：`npm run lint` 运行，配置见 `eslint.config.mjs`
  - 允许空 catch 块、`_` 前缀未使用参数
  - 排除 `public/`（minified bootstrap）、`node_modules/`、`logs/`、`backups/`
- **Prettier**：`npm run format` 运行，配置见 `.prettierrc.json`，忽略规则见 `.prettierignore`
  - 单引号、尾逗号 es5、每行 80 字符、2 空格缩进
- **Jest**（单元测试 & API 覆盖率）：
  - `npm run test` —— 运行所有测试
  - `npm run test:watch` —— 监听模式（修改文件自动重新运行）
  - `npm run test:coverage` —— 生成覆盖率报告（输出到 `coverage/` 目录）
  - `npm run test:api` —— 运行 API 集成测试（`test/api-coverage.test.js`）
  - 测试文件位置：`test/*.test.js`
- 提交前建议执行 `npm run lint && npm run format && npm run test`

## 数据库

- 启动时自动迁移建表（`db/migrate.js`），遇到死锁自动重试 3 次，详见 `docs/DB.md`
- 表：`rooms`（直播间）、`recording_sessions`（录制会话）、`recordings`（分片文件）、`recording_files`（磁盘文件跟踪）、`upload_templates`（投稿模板）、`upload_records`（投稿记录）、`settings`（全局设置）
- `rooms` 表新增字段：`notification_enabled`（通知开关）、`monitoring_enabled`（监听开关）、`polling_enabled`（轮询开关）、`polling_platform`（轮询平台，如 `huya`）、`polling_interval`（轮询间隔秒数，默认 60）、`last_live_status`（最近直播状态，Redis 缓存为主，DB 为兜底）、`last_polled_at`（最近轮询时间）
- 启动时自动扫描 `VIDEO_DOWNLOAD_DIR`，将未跟踪文件标记为 `orphaned`，缺失文件标记为 `missing`
- `POST /api/scan_files` 手动触发扫描，5 分钟内重复调用自动跳过（带冷却）
- 连接信息从 `.env` 的 `DB_*` 变量读取
- Redis 缓存直播间数据，写操作后自动失效

## 关键端点

### API

- `POST /api/notify/live_download` —— 通过 `DownloaderFactory` 使用 FFmpeg 录制直播流；关联 `rooms` 表，支持自定义文件名模板；受 `pool_size` 设置限制并发数；`monitoring_enabled=false` 时返回暂停状态
- `GET /api/notify/status` —— 轻量查询直播间录制状态，返回 `monitoring_paused`、`downloader` 等状态信息
- `GET /api/recording_files` —— 查询文件跟踪记录（支持 `?status=` 筛选）
- `PUT /api/recording_files/:id/associate` —— 将孤文件关联到录制会话
- `GET/POST /api/rooms` —— 直播间列表 / 创建（upsert），支持 `notification_enabled` / `monitoring_enabled` / `polling_enabled` / `polling_platform` / `polling_interval`
- `GET/PUT/DELETE /api/rooms/:id` —— 直播间详情 / 更新 / 删除
- `POST /api/rooms/:id/pause` —— 暂停录制（SIGSTOP）
- `POST /api/rooms/:id/resume` —— 恢复录制（SIGCONT）
- `POST /api/rooms/:id/stop` —— 停止录制（SIGTERM），同时自动关闭 `monitoring_enabled` 防止轮询二次触发录制
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
- `PORT` —— 正式环境默认 1123 ，开发环境默认 3001
- `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` —— PostgreSQL 连接
- `BILIUP_PATH` —— biliup 可执行文件路径，默认 `biliup`
- `BILIUP_WORK_DIR` —— biliup 工作目录，默认 `$HOME`

## 直播轮询 (Polling)

- **策略模式**：`lib/core/polling/PlatformChecker.js` — 平台检查器抽象基类，`checkStatus()` / `canHandleUrl()` / `getPlatformId()`。新增平台只需继承并注册到 `PollingManager.CHECKERS`
- **虎牙检查器**：`lib/core/polling/HuyaChecker.js` — 通过虎牙移动 API (`mp.huya.com`) 查询开播状态，自动解析短房间号→数字ID，去掉 `-imgplus` 构建 ffmpeg 兼容流地址
- **轮询管理器**：`lib/core/polling/PollingManager.js` — 单例，随 `app.js` 启动自动运行：
  - 启动时加载所有 `polling_enabled=true` 的房间
  - 按各房间的 `polling_interval` 定时查询（含 0~5s 随机 jitter 防惊群）
  - 检测到 **非开播→开播** 状态转换时，自动调用 `RecorderService.startRecording()` 启动录制
  - 直播状态写入 Redis（`polling:live_status:{roomId}`），TTL=`polling_interval * 2`
  - 手动停止录制时自动关闭 `monitoring_enabled`，防止轮询二次触发
- **平台检测**：前端输入 room_url 时自动识别平台（huya/douyu/bilibili/twitch/douyin/twitcasting），后端也支持根据 URL 自动检测
- 轮询间隔可配置（秒），建议 ≥ 30s

## 下载引擎（Downloader）

- **工厂模式**：`lib/core/downloaders/DownloaderFactory.js` — 固定返回 FFmpeg 实例（stream-gears 已移除，见 `docs/lessons.md`）
- **接口**：`lib/core/downloaders/DownloaderInterface.js` — `buildArgs()` / `spawn()` / `stop()` / `pause()` / `resume()` / `isRunning()`
- **FFmpeg**：`lib/core/downloaders/FFmpegDownloader.js` — 唯一下载引擎，需单独安装 ffmpeg

## 转码功能

- **边下边转码**：`services/RecorderService.js` — 监听 FFmpeg stderr 输出，新分段打开时自动入队上一个已完成的分段
- **转码队列**：`lib/core/TranscodeQueue.js` — Redis 队列 + 并发控制（`transcode_concurrency`），异步处理转码任务
- **转码器**：`lib/core/transcoder.js` — 调用 FFmpeg `-c copy` 快速转码（FLV → MP4）
- **转码配置**：`auto_transcode`（启用/禁用）、`transcode_delete_originals`（删除原文件）
- **双重保障**：边下边转码为主，`finishSession` 批量处理为兜底，确保无遗漏

## 日志

- 所有外部命令（ffmpeg、biliup）的输出通过 `lib/proc-log.js` 记录到 `logs/` 目录
- 文件名格式：`{进程名}_{会话ID}.log`

## 注意事项

- .env 已被 gitignore —— **切勿提交凭据**（本仓库中的 Lark、Redis、Gotify、数据库密码均为真实值）
- 模块系统为 CommonJS（`require`，默认不使用 `import/export`）
- ffmpeg 需单独安装，非 Node 依赖
- 全局设置存储于 `settings` 表，启动时自动插入默认值；`watchdog_interval` 修改后下次调度自动生效
- `max_upload_limit` 为 Redis INCR 持久化计数（`upload_count:{sessionId}`），24h 过期；自动投稿和手动投稿均受限制
- **设计原则**：保持轻量。避免引入 chokidar / Worker Thread / EventEmitter / 复杂状态机。同步 fs 操作在典型负载下完全够用。
- **Redis 缓存策略**：瞬时状态（直播状态、轮询时间、活跃任务）用 Redis 缓存带 TTL，持久数据（房间配置、文件路径）存 DB

## 关联项目

- **Chrome 扩展**（直播监听 + URL 推送）：`../chrome_live_listener/`
  - 向 `POST /api/notify/live_download` 推送直播流 URL
  - 向 `GET /api/notify/status` 查询录制状态
  - 两端 API 契约变更时需同步修改

## 踩坑记录

开发中遇到的典型问题及解决方案见 [docs/lessons.md](docs/lessons.md)。

## TODO 计划

查看文档[TODO.md](docs/TODO.md)
