# K-Recorder

基于 Node.js + Express 的直播录制服务器，支持自动监控、弹幕采集、视频转码和自动投稿。

---

[![Build and Push Docker Image](https://github.com/scriptsmay/live_recorder_server/actions/workflows/docker-image.yml/badge.svg)](https://github.com/scriptsmay/live_recorder_server/actions/workflows/docker-image.yml)

## 功能特性

- **直播录制**：使用 FFmpeg 作为下载引擎，支持分段录制（可配置时长）
- **弹幕采集与压制**：通过 Chrome 扩展采集弹幕（JSONL），生成 ASS 字幕，FFmpeg 渲染弹幕到视频
- **弹幕工具箱**：独立的 Web 界面，管理弹幕采集状态、批量压制、产物播放和下载
- **回放工具箱**：快手直播回放全自动处理（同步 → 提取 m3u8 → 下载 → 切片 → 修复 → 投稿），Web 界面管理
- **自动转码**：边下边转码（TS → MP4），转码队列 + 并发控制
- **HLS 生成**：自动为转码后的 MP4 生成 HLS 分片，支持在线播放
- **直播轮询**：策略模式支持虎牙、B 站、抖音、快手等平台，检测到开播自动触发录制
- **自动投稿**：录制完成自动调用 biliup 投稿到 Bilibili，支持模板化投稿
- **看门狗**：自动扫描录制目录，跟踪文件状态，清理孤立文件
- **通知系统**：录制开始/结束、投稿、直播回放处理完成等事件推送通知（飞书 Webhook / Gotify）
- **Docker 部署**：提供 Dockerfile，支持容器化部署

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（端口 3001，自动重启）
npm run dev

# 生产模式（端口 1123）
npm start

# 停止服务（pm2）
npm run stop
```

## 配置

本地配置在 `.env` 中，参考 `.env.example` 文件。

### 数据库配置

| 配置项          | 说明             | 默认值           |
| --------------- | ---------------- | ---------------- |
| DB_HOST         | 数据库主机       | localhost        |
| DB_PORT         | 数据库端口       | 5432             |
| DB_NAME         | 数据库名称       | ks_live_recorder |
| DB_USER         | 数据库用户名     | postgres         |
| DB_PASSWORD     | 数据库密码       | -                |
| DB_POOL_MAX     | 连接池最大连接数 | 20               |
| DB_POOL_MIN     | 连接池最小连接数 | 2                |
| DB_IDLE_TIMEOUT | 连接空闲超时(ms) | 30000            |

### Redis 配置

| 配置项         | 说明             | 默认值    |
| -------------- | ---------------- | --------- |
| REDIS_HOST     | Redis 主机       | localhost |
| REDIS_PORT     | Redis 端口       | 6379      |
| REDIS_PASSWORD | Redis 密码       | -         |
| REDIS_DB       | Redis 数据库编号 | 1         |

### 关键环境变量

| 配置项                 | 说明                           | 默认值                                    |
| ---------------------- | ------------------------------ | ----------------------------------------- |
| VIDEO_DOWNLOAD_DIR     | 录制文件输出根目录（**必需**） | -                                         |
| DANMAKU_OUTPUT_DIR     | 弹幕压制产物独立输出目录       | `${VIDEO_DOWNLOAD_DIR}/../danmaku_output` |
| PORT                   | 服务端口                       | 1123（生产）/ 3001（开发）                |
| BILIUP_PATH            | biliup 可执行文件路径          | `biliup`                                  |
| BILIUP_WORK_DIR        | biliup 工作目录                | `$HOME`                                   |
| MESSAGE_FEISHU_WEBHOOK | 飞书通知 Webhook URL           | -                                         |
| MESSAGE_GOTIFY_SERVER  | Gotify 服务器地址              | -                                         |
| MESSAGE_GOTIFY_TOKEN   | Gotify 应用 Token              | -                                         |

### 登录鉴权配置

| 配置项               | 说明                                                               | 默认值     |
| -------------------- | ------------------------------------------------------------------ | ---------- |
| AUTH_ENABLED         | 登录鉴权总开关；生产环境建议保持开启                               | true       |
| ADMIN_USERNAME       | 首次启动自动创建管理员时使用的用户名                               | admin      |
| AUTH_TOKEN_TTL_HOURS | 登录态有效期，单位小时                                             | 24         |
| AUTH_COOKIE_NAME     | 登录态 Cookie 名称                                                 | auth_token |
| AUTH_COOKIE_SECURE   | 是否只允许 HTTPS 写入 Cookie；内网 HTTP 部署保持 false             | false      |
| LOGIN_RATE_LIMIT     | 同一 IP 每分钟允许的登录失败次数                                   | 5          |
| LOGIN_LOCKOUT_MIN    | 达到失败次数上限后的锁定时长，单位分钟；锁定期间登录接口会直接拒绝 | 5          |

### 快手轮询配置

快手轮询 Checker 依赖远程 Browserless/Chromium，并通过平台级单并发和全局间隔降低风控概率。

| 配置项                     | 说明                         | 默认值 |
| -------------------------- | ---------------------------- | ------ |
| REMOTE_BROWSER_WS_ENDPOINT | 远程 Chromium WebSocket 地址 | -      |
| KUAISHOU_CHECKER_ENABLED   | 是否启用快手 Checker         | true   |
| POLLING_KUAISHOU_COOKIE    | 快手初始 Cookie              | -      |

Docker 从零部署时可叠加 `docker/docker-compose.browserless.yml` 一起启动 Browserless：

```bash
cd docker
docker compose --env-file ../.env \
  -f docker-compose.full.yml \
  -f docker-compose.browserless.yml \
  up -d --build
```

服务端使用 `chromium.connectOverCDP()`，因此 Browserless 地址应使用
`/chromium` CDP endpoint，例如
`ws://browserless:3000/chromium?token=${BROWSERLESS_TOKEN}`。

快手轮询内部的超时、等待、backoff 和 UA 参数使用系统常量，不作为用户配置暴露。
`POLLING_KUAISHOU_COOKIE` 作为快手直播轮询和回放工具箱共享的访问态 cookie。

### 回放工具箱配置

回放工具箱复用快手轮询 cookie，并依赖远程浏览器提供 m3u8 提取 Playwright 兜底方案：

| 配置项                       | 说明                                                 | 默认值 |
| ---------------------------- | ---------------------------------------------------- | ------ |
| `POLLING_KUAISHOU_COOKIE`    | 快手访问态 cookie，直播轮询和回放工具箱共用          | -      |
| `REMOTE_BROWSER_WS_ENDPOINT` | 远程 Chromium WebSocket 地址（Playwright m3u8 提取） | -      |

## 项目结构

```text
├── server/                         ← 后端源码（v1.5.0 目录重构移入）
│   ├── app.js                      ← 入口文件（启动编排）
│   ├── config/                     ← 配置
│   │   ├── env.js                  ← 环境变量加载（dotenv quiet 模式）
│   │   ├── config.js               ← 应用配置（类型常量、输出路径函数）
│   │   └── app-info.js             ← 应用信息
│   ├── middleware/                  ← Express 中间件
│   │   ├── access-log.js           ← Morgan access log
│   │   └── require-auth.js         ← 登录鉴权中间件
│   ├── lib/core/                   ← 核心功能模块
│   │   ├── logger.js               ← 日志系统（console 包装、轮转流）
│   │   ├── RecordingManager.js     ← 录制进程管理（会话创建/恢复/分段时间追踪）
│   │   ├── downloaders/            ← 下载引擎
│   │   │   ├── DownloaderFactory.js   ← 工厂模式（返回 FFmpeg 实例）
│   │   │   ├── DownloaderInterface.js ← 下载器接口
│   │   │   └── FFmpegDownloader.js    ← FFmpeg 下载引擎（TS 输出、分段检测）
│   │   ├── danmaku/                ← 弹幕采集与字幕生成
│   │   │   ├── DanmakuRecorder.js     ← 弹幕采集器（JSONL 写入 danmaku/ 子目录）
│   │   │   └── DanmakuAssGenerator.js ← ASS 字幕生成器（会话级 + 分段级）
│   │   ├── DanmakuBurnQueue.js     ← 弹幕压制队列（Redis 队列，独立于转码）
│   │   ├── danmaku-burner.js       ← FFmpeg 弹幕压制（ASS 滤镜渲染）
│   │   ├── replay/                 ← 回放工具箱
│   │   │   ├── KuaishouReplayClient.js ← 快手回放 API 客户端（列表同步 + m3u8 提取）
│   │   │   ├── m3u8-extractor.js       ← Playwright 浏览器 m3u8 提取器（API 失败时兜底）
│   │   │   ├── video-processor.js      ← 回放视频处理（下载/切片/修复）
│   │   │   └── ReplayUploadService.js  ← 回放投稿服务
│   │   ├── ReplayProcessQueue.js   ← 回放处理队列（全流程：extract→download→cut→fix→upload）
│   │   ├── polling/                ← 直播轮询检测
│   │   │   ├── PlatformChecker.js     ← 平台检查器基类（策略模式）
│   │   │   ├── HuyaChecker.js         ← 虎牙
│   │   │   ├── BilibiliChecker.js     ← B 站
│   │   │   ├── DouyuChecker.js        ← 斗鱼
│   │   │   ├── DouyinChecker.js       ← 抖音
│   │   │   ├── KuaishouChecker.js     ← 快手（HTTP GET 页面提取）
│   │   │   └── PollingManager.js      ← 轮询管理器（定时调度、状态转换检测）
│   │   ├── TranscodeQueue.js       ← 转码队列（Redis 队列 + 并发控制）
│   │   ├── transcoder.js           ← 视频转码（FFmpeg -c copy TS → MP4）
│   │   ├── hls-generator.js        ← HLS 分片生成
│   │   ├── watchdog.js             ← 看门狗（文件扫描、状态同步、分段时间补充）
│   │   ├── auth-service.js         ← 登录认证服务
│   │   ├── backup.js               ← NAS 备份
│   │   └── notify.js               ← 通知服务（飞书 / Gotify）
│   ├── services/                   ← 业务服务层
│   │   ├── DataService.js          ← 公共数据查询（rooms/sessions/settings/files）
│   │   ├── RecorderService.js      ← 录制服务（启动/停止/会话完成处理）
│   │   ├── RoomService.js          ← 直播间管理（CRUD、暂停/恢复）
│   │   ├── UploadService.js        ← 投稿服务（biliup 调用）
│   │   └── LogCleanupService.js    ← 日志清理服务（定期清理过期日志）
│   ├── router/                     ← 路由层（REST API + SPA fallback）
│   │   ├── index.js                ← 统一路由挂载
│   │   ├── api.js                  ← 录制/会话 API
│   │   ├── danmaku.js              ← 弹幕相关 API
│   │   ├── replay.js               ← 回放工具箱 API
│   │   ├── dashboard.js            ← Dashboard 运维概览 API
│   │   └── auth.js                 ← 登录鉴权 API
│   └── db/                         ← 数据库
│       ├── index.js                ← PostgreSQL 连接池
│       ├── migrate.js              ← 数据库迁移（自动建表/加列）
│       └── redis.js                ← Redis 客户端
├── frontend/                       ← Vue 3 SPA 前端（v1.4 从 EJS 迁移）
│   ├── src/
│   │   ├── main.ts                 ← 应用入口
│   │   ├── App.vue                 ← 根组件
│   │   ├── router/index.ts         ← Vue Router（13+ 路由，含嵌套路由）
│   │   ├── stores/                 ← Pinia 状态管理
│   │   │   ├── app.ts              ← 全局状态
│   │   │   ├── auth.ts             ← 登录认证状态
│   │   │   └── replay-toolbox.ts   ← 回放工具箱状态
│   │   ├── components/             ← 通用组件（Layout/Navbar/Modal/Toast/Pagination 等）
│   │   ├── components/replay/      ← 回放工具箱原子组件（7 个）
│   │   ├── views/                  ← 页面视图
│   │   │   ├── Dashboard.vue       ← 运维概览
│   │   │   ├── Rooms.vue           ← 直播间管理
│   │   │   ├── Recordings.vue      ← 录制管理
│   │   │   ├── Sessions.vue        ← 录制会话
│   │   │   ├── DanmakuToolbox.vue  ← 弹幕工具箱
│   │   │   ├── ReplayToolbox.vue   ← 回放工具箱
│   │   │   ├── Transcode.vue       ← 转码管理
│   │   │   ├── Settings.vue        ← 全局设置
│   │   │   ├── Templates.vue       ← 投稿模板管理
│   │   │   ├── UploadRecords.vue   ← 投稿记录
│   │   │   ├── ApiDoc.vue          ← API 文档
│   │   │   ├── Logs.vue            ← 日志查看
│   │   │   └── Login.vue           ← 登录页
│   │   ├── utils/                  ← 工具函数（API 封装、Toast、确认框）
│   │   └── types/                  ← TypeScript 类型定义
│   ├── index.html                  ← SPA 入口 HTML
│   ├── vite.config.ts              ← Vite 构建配置
│   └── package.json                ← 前端依赖（Vue 3 / Pinia / Vue Router / Tailwind CSS）
├── scripts/                        ← 运维脚本（replay-cli.js 等）
├── docker/                         ← Docker 配置（Compose + Dockerfile）
├── docs/                           ← 项目文档
│   ├── DB.md                       ← 数据库表结构文档
│   ├── API.md                      ← API 接口文档
│   ├── ARCHITECTURE.md             ← 系统架构文档
│   ├── DEV.md                      ← 开发指南
│   ├── TEST.md                     ← 测试文档
│   └── todo/                       ← 开发计划文档
├── public/                         ← 静态文件
├── logs/                           ← 应用日志
└── test/                           ← Jest 测试（380+ 个用例）
```

## 弹幕功能架构

弹幕功能已从录制流程中完全解耦，作为独立的工具箱功能运行：

```text
录制流程                              弹幕工具箱（独立）
─────────                           ─────────────────
FFmpeg 录制直播流                     Chrome 扩展采集弹幕
    ↓                                    ↓
分段文件 (.ts)                        JSONL → danmaku/danmaku.jsonl
    ↓                                    ↓
转码队列 → MP4                       ASS 生成 → danmaku/danmaku.ass
    ↓                                    ↓
HLS 生成 → 在线播放                   分段 ASS → danmaku/segments/*.ass
                                         ↓
                                     压制队列 → DANMAKU_OUTPUT_DIR/
                                         ↓
                                     弹幕视频 (.mp4) + 日志
```

**目录隔离**：弹幕数据存放在 `会话目录/danmaku/` 子目录，压制产物输出到独立的 `DANMAKU_OUTPUT_DIR/`，与录制文件完全隔离。

**操作入口**：所有弹幕操作（生成 ASS、批量压制、产物管理）统一在「弹幕工具箱」页面（`/danmaku-toolbox`）完成，录制会话页面仅提供只读状态展示。

## 回放工具箱功能架构

回放工具箱将快手直播回放的全流程自动化：同步 → 提取 m3u8 → 下载 → 切片 → 投稿；分辨率修复可作为单独步骤执行。全流程默认按已有产物续跑，已存在 m3u8、下载文件或切片产物时会跳过对应步骤；API 传 `force=true` 时才从提取/下载开始覆盖执行。

```text
[快手 API / 前端操作]                    [后端处理]
     │                                        │
     │  同步回放（POST /api/replay/records/sync）│
     │  ──────────────────────────────────────>│  playback/list API → replay_records
     │                                        │
     │  批量全流程（POST /api/replay/tasks/enqueue）│
     │  ──────────────────────────────────────>│  ReplayProcessQueue
     │                                        │  ├─ extract: m3u8 提取
     │                                        │  │   ├─ HTTP API (playback/detail)
     │                                        │  │   └─ Playwright 浏览器兜底
     │                                        │  ├─ download: yt-dlp 下载
     │                                        │  ├─ cut: mkvmerge/ffmpeg 切片
     │                                        │  ├─ fix: ffmpeg 分辨率修复（单独动作）
     │                                        │  └─ upload: biliup 投稿
     │                                        │
     │  查询状态（GET /api/replay/tasks）       │
     │  <─────────────────────────────────────│
```

**前端路由**：`/replay-toolbox`（主播列表）→ `/replay-toolbox/:principalId/{records,uploads,tasks,settings}`

**状态机**：`pending → extracted → downloaded → cut → fixed → uploaded → completed`

## 测试

```bash
# 运行所有测试（400+ 个用例）
npm test

# 监听模式
npm run test:watch

# 覆盖率报告
npm run test:coverage
```

## 代码规范

```bash
# ESLint 检查（v9 flat config）
npm run lint

# Prettier 格式化（单引号、2空格缩进）
npm run format

# 提交前建议执行
npm run lint && npm run format && npm test
```

## 技术栈

- **运行时**：Node.js + Express 5（CommonJS）
- **前端**：Vue 3（Vite + Pinia + Vue Router, Tailwind CSS）
- **数据库**：PostgreSQL（pg 模块，启动时自动迁移）
- **缓存**：Redis（瞬时状态 + 任务队列）
- **下载引擎**：FFmpeg（TS 输出、分段录制）
- **弹幕渲染**：FFmpeg ASS 滤镜
- **投稿**：biliup CLI
- **测试**：Jest（v30，380+ 个用例，单元测试 + API 集成测试）

## 注意事项

- `.env` 已被 gitignore —— **切勿提交凭据**
- 模块系统为 CommonJS（`require`）
- FFmpeg 和 biliup 需单独安装，非 Node 依赖
- 全局设置存储于 `settings` 表，启动时自动插入默认值
- 设计原则：保持轻量，避免引入 chokidar / Worker Thread / 复杂状态机

## 关联项目

- **Chrome 扩展**（弹幕采集 + 直播监听）：`../chrome_live_listener/`

## 文档

- [数据库表结构](docs/DB.md)
- [API 接口文档](docs/API.md)
- [系统架构](docs/ARCHITECTURE.md)
- [开发指南](docs/DEV.md)
- [测试文档](docs/TEST.md)
- [踩坑记录](docs/lessons.md)
- [开发计划](docs/todo/TODO.md)
