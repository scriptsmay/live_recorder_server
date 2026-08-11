# K-Recorder — 智能体备忘录

## 技术栈

- Express 5（CommonJS）、Vue 3 SPA（Vite + Tailwind CSS v4 + TypeScript）、morgan、cors
- PostgreSQL（`pg` 模块）—— 连接池在 `server/db/index.js`
- Redis（`redis` 模块）—— 客户端在 `server/db/redis.js`
- dotenv 以 `quiet: true` 加载 —— 缺少 .env 时静默失败
- **Jest**（v30.4.2）—— 单元测试和 API 集成测试框架

## 开发工作流

- `npm install` → 安装项目依赖。
- `npm run dev` → node `--watch` 开发模式（端口 3001），启动开发环境，前台查看日志。
- `npm run dev:backend` → 以后台模式启动开发环境，输出日志可在 `/tmp/dev-server.log` 中查看。
- **修改代码后必须更新文档 + 提交代码**：每次完成功能开发或修复后，先更新对应的 `docs/` 文档，再用 `git add`/`git commit` 提交。提交信息格式：`<type>: <description>`

## 目录结构

```text
├── server/
│   ├── app.js              # 主入口文件（仅做启动编排）
│   ├── config/             # 配置
│   │   ├── env.js          # 环境变量加载
│   │   └── app-info.js     # 应用版本信息
│   ├── middleware/         # Express 中间件
│   │   ├── access-log.js    # Morgan access log 中间件
│   │   └── view-locals.js  # 模板上下文（res.locals）
│   ├── lib/core/          # 核心功能模块
│   │   ├── logger.js       # 日志系统（console 包装、轮转流）
│   │   ├── lifecycle.js     # 启动/关闭生命周期
│   │   ├── backup.js       # NAS 备份
│   │   ├── RecordingManager.js  # 录制进程管理（会话创建/恢复/追踪）
│   │   ├── downloaders/    # 下载引擎（仅 FFmpeg）
│   │   │   ├── DownloaderFactory.js
│   │   │   ├── DownloaderInterface.js
│   │   │   └── FFmpegDownloader.js
│   │   ├── danmaku/        # 弹幕采集
│   │   │   └── DanmakuRecorder.js    # 弹幕采集器（JSONL 写入）
│   │   ├── notify.js       # 通知服务
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
│   ├── lib/utils/         # 工具类
│   │   └── markdown.js
│   ├── router/             # 路由层（API + 页面）
│   │   └── index.js       # 统一路由挂载
│   ├── services/           # 业务服务层
│   │   ├── DataService.js      # 公共数据查询（rooms/settings/sessions 等）
│   │   ├── RecorderService.js  # 录制服务
│   │   ├── RoomService.js      # 直播间管理服务
│   │   └── UploadService.js    # 投稿服务
│   └── db/                 # 数据库
│       ├── index.js
│       ├── migrate.js
│       └── redis.js
├── frontend/           # Vue 3 SPA 前端（Vite + Tailwind + TypeScript）
├── public/             # 静态资源 + Vue 构建产物（public/frontend/）
├── scripts/            # 工具脚本
├── logs/               # 日志
├── docs/               # 文档
├── backups/            # 备份
└── test/               # 测试
```

**目录组织原则：**

- `server/lib/core/` — 核心功能模块，基本与业务逻辑无关（如下载引擎、看门狗、转码、日志、生命周期）
- `server/lib/utils/` — 通用工具类（如日志格式化、Markdown 渲染、文件路径生成）
- `server/services/` — 业务服务层，封装具体业务逻辑（如录制、直播间管理、投稿）
- `server/services/DataService.js` — 集中封装读库查询，供 API 路由使用，避免重复 `pool.query`
- `server/router/` — 路由层，负责接收请求、调用 Service、返回响应
- `server/middleware/` — Express 中间件（如模板上下文、access log）
- `server/config/` — 配置层（环境变量、应用信息）

**页面渲染**：所有页面已迁移到 Vue SPA（`frontend/src/views/`），由 Vue Router 管理。生产环境下 `server/router/spa.js` 负责静态资源服务和 history 模式回退。EJS 的 `server/router/html.js` 已完全注释禁用。

## 代码规范

### 格式化与检查

- **ESLint**（v9 flat config）：`npm run lint` 运行，配置见 `eslint.config.mjs`
  - 允许空 catch 块、`_` 前缀未使用参数
  - 排除 `public/`（minified bootstrap）、`node_modules/`、`logs/`、`backups/`
- **Prettier**：`npm run format` 运行，配置见 `.prettierrc.json`，忽略规则见 `.prettierignore`
  - 单引号、尾逗号 es5、每行 80 字符、2 空格缩进
- **TypeScript 类型检查**：修改 `frontend/src/` 下任何 `.vue` 或 `.ts` 文件后，**必须**在 `frontend/` 目录执行 `npm run build` 验证类型检查通过。`npm run dev` 使用 esbuild 跳过 TS 检查，不能作为正确性依据
- 提交前建议执行 `npm run lint && npm run format && cd frontend && npm run build`

### 测试规范

项目使用 **Jest** 框架进行单元测试和 API 集成测试。

#### CI/CD 集成

```bash
# 本地提交前检查
npm run lint && npm run format && npm run test
```

## 数据库

- 启动时自动迁移建表（`server/db/migrate.js`），遇到死锁自动重试 3 次，详见 `docs/DB.md`
- 表：`rooms`（直播间）、`recording_sessions`（录制会话）、`recordings`（分片文件）、`recording_files`（磁盘文件跟踪）、`upload_templates`（投稿模板）、`upload_records`（投稿记录）、`settings`（全局设置）、`danmaku_capture_records`（弹幕采集）
- 已废弃已移除（v1.8.0 DROP）：`danmaku_burn_records`、`danmaku_free_burn_records`、`recording_files.danmaku_ass_path`、`danmaku_capture_records.ass_path` —— 弹幕压制已迁至 danmaku-tool，启动时自动执行 DROP
- `rooms` 表新增字段：`notification_enabled`（通知开关）、`monitoring_enabled`（监听开关）、`polling_enabled`（轮询开关）、`polling_platform`（轮询平台，如 `huya`）、`polling_interval`（轮询间隔秒数，默认 60）
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

### 弹幕

> 弹幕压制（ASS 生成 + 硬字幕烧录）已于 v1.7.0 迁出至独立的 danmaku-tool 项目，相关端点已下线。本服务只负责弹幕采集与查询。

- `POST /api/danmaku/batch` —— 接收 Chrome 扩展推送的弹幕数据
- `GET /api/danmaku_capture_records` —— 查询弹幕采集记录
- `GET /api/danmaku/status` —— 获取弹幕采集状态
- `GET /api/danmaku/search` —— 搜索弹幕 JSONL 内容
- `GET /api/sessions/:id/danmaku-page` —— 弹幕详情页 JSON 数据（会话信息、录制状态、分段文件）
- `GET /api/danmaku/sessions/:id/raw` —— 下载会话原始弹幕 JSONL

### 投稿

- `GET/POST /api/upload_templates` —— 投稿模板列表 / 创建
- `PUT/DELETE /api/upload_templates/:id` —— 更新 / 删除模板
- `POST /api/sessions/:id/upload` —— 对录制会话执行投稿（需指定模板ID）
- `GET/DELETE /api/upload_records` —— 投稿记录查询 / 删除

### 转码记录

- `GET /api/transcode_records` —— 查询转码记录列表（支持 `?status=` 筛选）
- `DELETE /api/transcode_records/:id` —— 删除转码记录

### 页面（Vue SPA 路由）

- `/dashboard` —— 仪表盘
- `/rooms` —— 直播间管理
- `/sessions` —— 录制会话（含投稿、文件查看）
- `/sessions/:id/danmaku` —— 弹幕详情（会话信息、分段压制状态、弹幕搜索）
- `/recordings` —— 录制文件
- `/transcode` —— 转码记录
- `/templates` —— 投稿模板管理
- `/upload-records` —— 投稿记录（注：EJS 旧路径为 `/upload_records`）
- `/settings` —— 全局设置
- `/logs` —— 日志查看

## 关键环境变量

- `VIDEO_DOWNLOAD_DIR` —— 录制端点必需；需确保目录存在或自动创建；弹幕 JSONL 集中存放在 `VIDEO_DOWNLOAD_DIR/danmaku/[sessionId].jsonl`
- `PORT` —— 正式环境默认 1123 ，开发环境默认 3001
- `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` —— PostgreSQL 连接
- `BILIUP_PATH` —— biliup 可执行文件路径，默认 `biliup`
- `BILIUP_WORK_DIR` —— biliup 工作目录，默认 `$HOME`

## 直播轮询 (Polling)

- **策略模式**：`server/lib/core/polling/PlatformChecker.js` — 平台检查器抽象基类，`checkStatus()` / `canHandleUrl()` / `getPlatformId()`。新增平台只需继承并注册到 `PollingManager.CHECKERS`
- **虎牙检查器**：`server/lib/core/polling/HuyaChecker.js` — 通过虎牙移动 API (`mp.huya.com`) 查询开播状态，自动解析短房间号→数字ID，去掉 `-imgplus` 构建 ffmpeg 兼容流地址
- **轮询管理器**：`server/lib/core/polling/PollingManager.js` — 单例
  - 启动时只检查一次所有 `polling_enabled=true` 房间的状态（无定时器）
  - `reloadRoom()` 控制定时轮询：新增/修改房间时启动定时器，按各房间的 `polling_interval` 定时查询（含 0~5s 随机 jitter 防惊群）
  - 检测到 **非开播→开播** 状态转换时，自动调用 `RecorderService.startRecording()` 启动录制
  - 直播状态写入 Redis（`polling:live_status:{roomId}`），TTL=`polling_interval * 2`
  - 手动停止录制时自动关闭 `monitoring_enabled`，防止轮询二次触发
- **平台检测**：前端输入 room_url ，后端接收时根据 URL 自动检测轮询平台
- 轮询间隔可配置（秒），建议 ≥ 30s

## 下载引擎（Downloader）

- **工厂模式**：`server/lib/core/downloaders/DownloaderFactory.js` — 统一返回 FFmpeg 实例
- **接口**：`server/lib/core/downloaders/DownloaderInterface.js` — `buildArgs()` / `spawn()` / `stop()` / `pause()` / `resume()` / `isRunning()`
- **FFmpeg**：`server/lib/core/downloaders/FFmpegDownloader.js` — 唯一下载引擎，需单独安装 ffmpeg
  - 输出格式：`.ts`（容错性更强）
  - 支持网络重连（`-reconnect 1`）
  - 用户代理伪装（防止 CDN 403）
  - 协议白名单支持

## 转码功能

- **边下边转码**：`server/services/RecorderService.js` — 监听 FFmpeg stderr 输出，新分段打开时自动入队上一个已完成的分段
- **转码队列**：`server/lib/core/TranscodeQueue.js` — Redis 队列 + 并发控制（`transcode_concurrency`），异步处理转码任务
- **转码器**：`server/lib/core/transcoder.js` — 调用 FFmpeg `-c copy` 快速转码（TS → MP4）
- **转码配置**：`auto_transcode`（启用/禁用）、`transcode_delete_originals`（删除原文件）
- **双重保障**：边下边转码为主，`finishSession` 批量处理为兜底，确保无遗漏

## 文件路径结构

录制文件采用平级目录结构存储：`VIDEO_DOWNLOAD_DIR/[sessionId]/[filename]`

- `sessionId` 全局唯一，无需嵌套 `roomId`
- 历史数据仍保留旧格式 `VIDEO_DOWNLOAD_DIR/[roomId]/[sessionId]/[filename]`，scan-files 兼容两种格式
- 工具函数：`server/lib/utils/tool.js` 中的 `generateOutputPath()`

```text
VIDEO_DOWNLOAD_DIR/
├── danmaku/                           # 弹幕 JSONL 集中目录（保留目录名，scan-files 跳过）
│   ├── 118.jsonl                      # sessionId 命名，自解释
│   └── 119.jsonl
├── [sessionId]/
│   ├── {room_name}_{datetime}.ts      # 非分段录制
│   └── {room_name}_%Y%m%d_%H%M%S.ts  # 分段录制
```

> v1.8.0 起弹幕 JSONL 不再放在会话子目录下的 `danmaku/danmaku.jsonl`。路径由 `getDanmakuJsonlPath(sessionId)` 唯一推导，业务代码禁止自行拼接。danmaku-tool 的批量压制功能需同步更新路径（见 ADR-011）。

## 日志

- 所有外部命令（ffmpeg、biliup）的输出通过 `server/lib/proc-log.js` 记录到 `logs/` 目录
- 文件名格式：`{进程名}_{会话ID}.log`

## 注意事项

- .env 已被 gitignore —— **切勿提交凭据**（本仓库中的 Lark、Redis、Gotify、数据库密码均为真实值）
- 模块系统为 CommonJS（`require`，默认不使用 `import/export`）
- ffmpeg 需单独安装，非 Node 依赖
- 全局设置存储于 `settings` 表，启动时自动插入默认值；`watchdog_interval` 修改后下次调度自动生效
- `max_upload_limit` 为 Redis INCR 持久化计数（`upload_count:{sessionId}`），24h 过期；自动投稿和手动投稿均受限制
- **设计原则**：保持轻量。避免引入 chokidar / Worker Thread / EventEmitter / 复杂状态机。同步 fs 操作在典型负载下完全够用。
- **Redis 缓存策略**：瞬时状态（直播状态、轮询时间、活跃任务）用 Redis 缓存带 TTL，持久数据（房间配置、文件路径）存 DB

## 参考项目和文档

### 关联项目

- **Chrome 扩展**（直播监听 + URL 推送）：`../chrome_live_listener/`
  - 向 `POST /api/notify/live_download` 推送直播流 URL
  - 向 `GET /api/notify/status` 查询录制状态
  - 两端 API 契约变更时需同步修改

### 开发和测试文档

- 数据库文档：[docs/DB.md](docs/DB.md)
- 开发工作文档：[docs/DEV.md](docs/DEV.md)
- 测试用例编写文档：[docs/TEST.md](docs/TEST.md)

### 踩坑记录

开发中遇到的典型问题及解决方案见 [docs/lessons.md](docs/lessons.md)。

### TODO 计划

查看TODO文档[TODO.md](docs/todo/TODO.md)
