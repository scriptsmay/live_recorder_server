# 快手直播弹幕录制与压制 — 完整实现总结

完成日期：2026-06-01
关联计划：[KUAISHOU_DANMAKU_RECORDING_PLAN.md](./KUAISHOU_DANMAKU_RECORDING_PLAN.md)

---

## 概述

本项目实现了快手直播弹幕的完整生命周期：从 Chrome Extension 拦截页面 WebSocket 弹幕数据、后端 JSONL 持久化、ASS 字幕生成、FFmpeg 压制到视频，到前端管理界面的全链路。

整个过程按 5 个阶段推进：阶段 0（可行性验证）、阶段 1（弹幕录制基础链路）、阶段 2（ASS 生成）、阶段 3（弹幕压制队列）、阶段 4（前端 UI 与配置面板）。**所有阶段已全部完成。**

---

## 总体成果概览

| 指标     | 数值                  |
| -------- | --------------------- |
| 新增文件 | 15+                   |
| 修改文件 | 10+                   |
| 单元测试 | 14 suites / 247 tests |
| ESLint   | 0 errors, 0 warnings  |
| 代码行数 | ~3000+ 行（含测试）   |

---

## 阶段 0：可行性验证 ✅

**文档**：[kuaishou-danmaku-research.md](./kuaishou-danmaku-research.md)、[KUAISHOU_DANMAKU_FEASIBILITY_ASSESSMENT.md](./KUAISHOU_DANMAKU_FEASIBILITY_ASSESSMENT.md)

### 核心发现

- 快手弹幕使用 WebSocket + JSON envelope 协议
- `SC_FEED_PUSH`（PayloadType 310）是核心推送消息，包含 `commentFeeds[]`、`giftFeeds[]`、`likeFeeds[]`
- `websocketinfo` 接口有 `__NS_hxfalcon` 反爬保护
- **决策**：采用 Chrome Extension inject.js 拦截页面 WebSocket，绕过反爬

### 交付物

- 完整协议分析文档（42 种 SC* 消息类型 + 10 种 CS* 消息类型）
- 技术可行性评估报告（8 个风险维度，等级均为中/低）
- 开发工作量评估（6.5-13.5 天，实际约 1-2 天）

---

## 阶段 1：弹幕录制基础链路 ✅

**文档**：[PHASE1_DANMAKU_CAPTURE_TASKS.md](./PHASE1_DANMAKU_CAPTURE_TASKS.md)

### chrome_live_listener 改动（5 个任务）

| 任务    | 文件                | 说明                                              |
| ------- | ------------------- | ------------------------------------------------- |
| T1-CE-1 | `inject.js`         | monkey-patch WebSocket，拦截 SC_FEED_PUSH 消息    |
| T1-CE-2 | `danmaku-parser.js` | 解析 commentFeeds/giftFeeds 为标准事件格式        |
| T1-CE-3 | `content.js`        | postMessage 转发链路（inject.js → background.js） |
| T1-CE-4 | `background.js`     | 5 秒批量缓冲 + POST /api/danmaku/batch            |
| T1-CE-5 | `config.js`         | 弹幕 API 路径配置                                 |

**payload 格式验证结果**：SC_FEED_PUSH 的 payload 为 JSON 对象（非 protobuf），解析零依赖。

### live_recorder_server 改动（6 个任务）

| 任务    | 文件                                             | 说明                                                            |
| ------- | ------------------------------------------------ | --------------------------------------------------------------- |
| T1-BE-1 | `db/migrate.js`                                  | 新增 `danmaku_capture_records` 表 + recording_files 扩展字段    |
| T1-BE-2 | `lib/core/danmaku/DanmakuRecorder.js`            | 弹幕写入核心：start/appendEvents/stop，JSONL 持久化             |
| T1-BE-3 | `router/danmaku.js`                              | POST /api/danmaku/batch 接口（校验 session_id、批量写入）       |
| T1-BE-4 | `services/RecorderService.js`                    | 录制生命周期集成（startRecording 启动弹幕，finishSession 停止） |
| T1-BE-5 | `router/index.js`                                | 挂载 danmaku 路由                                               |
| T1-BE-6 | `services/DataService.js` + `views/sessions.ejs` | LEFT JOIN 弹幕记录 + sessions 页面显示弹幕状态 badge            |

### 数据库新增

**danmaku_capture_records 表**：

```sql
CREATE TABLE IF NOT EXISTS danmaku_capture_records (
  id SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES recording_sessions(id) ON DELETE CASCADE,
  room_id INTEGER,
  platform VARCHAR(50) DEFAULT 'kuaishou',
  status VARCHAR(20) DEFAULT 'recording',
  raw_path VARCHAR(1024) DEFAULT '',
  ass_path VARCHAR(1024) DEFAULT '',
  event_count BIGINT DEFAULT 0,
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  error TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW()
);
```

**recording_files 扩展字段**：

```sql
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS segment_start_ms INTEGER DEFAULT 0;
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS segment_end_ms INTEGER DEFAULT 0;
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS danmaku_ass_path VARCHAR(1024) DEFAULT '';
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS danmaku_burn_path VARCHAR(1024) DEFAULT '';
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS is_danmaku_burned BOOLEAN DEFAULT FALSE;
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS danmaku_burned_at TIMESTAMP;
```

### 设置

| 键                         | 默认值  | 说明                 |
| -------------------------- | ------- | -------------------- |
| `kuaishou_danmaku_enabled` | `false` | 是否启用快手弹幕录制 |

---

## 阶段 2：ASS 生成 ✅

**文档**：[PHASE2_ASS_GENERATION_TASKS.md](./PHASE2_ASS_GENERATION_TASKS.md)

### 核心模块

**DanmakuAssGenerator.js** — 完整 ASS 字幕生成器：

| 功能         | 方法                   | 说明                                 |
| ------------ | ---------------------- | ------------------------------------ |
| ASS 字符转义 | `_escapeAssText()`     | 转义 `{`、`}`、`\`、换行等特殊字符   |
| 时间戳转换   | `_msToAssTime()`       | 毫秒 → ASS 时间格式 `H:MM:SS.cc`     |
| 字号缩放     | `_scaleFontSize()`     | 基于视频宽度的字号自适应             |
| 密度限制     | `_applyDensityLimit()` | 每秒最大弹幕数控制                   |
| 轨道分配     | `_generateAssEvents()` | 避免同轨重叠的多轨道分配             |
| ASS 模板     | `_buildAssFile()`      | 完整 ASS 文件结构（Style + Events）  |
| JSONL 生成   | `generateFromJsonl()`  | 从 JSONL 生成完整 ASS，支持 offsetMs |
| 分段生成     | `generateSegmentAss()` | 按时间窗口裁剪生成分段 ASS           |

### 关键特性

- **offsetMs 时间偏移**：支持正偏移（延迟）和负偏移（提前），负偏移不溢出到负数
- **空文本处理**：trim 后为空字符串的弹幕直接跳过
- API 透传：`POST /api/sessions/:id/danmaku/ass` 接受 `{ offsetMs, videoWidth, videoHeight }`

### 单元测试（52 个）

| 测试分组             | 测试数 | 覆盖内容                                            |
| -------------------- | :----: | --------------------------------------------------- |
| `_escapeAssText`     |   8    | 正常文本/特殊字符/花括号/反斜杠/换行/Unicode/空文本 |
| `_msToAssTime`       |   7    | 零值/整秒/带毫秒/大值/边界值/负数舍弃               |
| `_scaleFontSize`     |   5    | 1080p/720p/4K/极小分辨率/零值兜底                   |
| `_applyDensityLimit` |   5    | 正常/超限/混合类型/空数组/全部超限                  |
| `_generateAssEvents` |   8    | 单轨/多轨/空输入/长文本/换行文本/类型过滤           |
| `_buildAssFile`      |   5    | 标准/自定义样式/无事件/大分辨率/超长文本            |
| `generateFromJsonl`  |   9    | 正常/空JSONL/坏行跳过/offsetMs正值/负偏移/零偏移    |
| `generateSegmentAss` |   6    | 标准分段/空分段/时间窗口外/精确边界/部分重叠        |

---

## 阶段 3：弹幕压制队列 ✅

**文档**：[PHASE3_DANMAKU_BURN_TASKS.md](./PHASE3_DANMAKU_BURN_TASKS.md)

### 核心模块

**danmaku-burner.js** — FFmpeg 弹幕压制器：

| 功能                   | 说明                                                  |
| ---------------------- | ----------------------------------------------------- |
| `burn()`               | FFmpeg spawn，subtitle 滤镜，libx264/QSV 双编码器支持 |
| `_buildArgs()`         | 构建完整 FFmpeg 参数（含 `-movflags +faststart`）     |
| `_buildFilterChain()`  | ASS 路径转义（`\`→`/`、`:`→`\:`）、单引号处理         |
| `probeCapabilities()`  | subtitles 滤镜、编码器、fontconfig 能力检测           |
| `estimateTimeout()`    | `max(30min, 视频时长×4)` 超时估算                     |
| `getVideoDurationMs()` | ffprobe 获取视频时长                                  |
| 安全特性               | NICE=10 低优先级 + SIGTERM/SIGKILL 优雅终止           |
| 前置检查               | 输入文件存在、ASS 文件存在、ASS 非空、输出覆盖判断    |

**DanmakuBurnQueue.js** — Redis 队列管理器：

| 功能                  | 说明                                                               |
| --------------------- | ------------------------------------------------------------------ |
| 队列存储              | Redis LIST (`danmaku_burn_queue`)                                  |
| 并发控制              | Redis 计数器 (`danmaku_burn_processing_count`)，强制 concurrency=1 |
| `enqueue()`           | 单任务入队，含前置检查（input/ass 存在、输出覆盖）                 |
| `enqueueSession()`    | 批量入队，自动寻找 mp4→ass 映射                                    |
| `processQueue()`      | 轮询处理，concurrency 限流                                         |
| `processTask()`       | FFmpeg 压制 + DB 记录更新 + 失败清理 + recording_files 同步        |
| `_createBurnRecord()` | INSERT ... ON CONFLICT DO UPDATE                                   |

### 数据库新增

**danmaku_burn_records 表**（已有，在阶段 1 迁移中一同创建）

### API

| 端点                             | 方法   | 说明             |
| -------------------------------- | ------ | ---------------- |
| `/api/sessions/:id/danmaku/burn` | POST   | 手动加入压制队列 |
| `/api/danmaku_burn_records`      | GET    | 查询压制记录     |
| `/api/danmaku_burn_records/:id`  | DELETE | 删除压制记录     |

### 页面改动

- `services/DataService.js`：`getSessions()` SQL 新增子查询 LEFT JOIN `danmaku_burn_records`，聚合 total/completed/failed 计数
- `views/sessions.ejs`：会话卡片新增压制状态 badge（压制中/完成/失败 + X/Y 进度）

### 单元测试

**danmaku-burner.test.js**（24 个测试）：

| 分组                                                  | 测试数 |
| ----------------------------------------------------- | :----: |
| `_buildFilterChain`（正常/反斜杠/冒号/单引号/中文）   |   5    |
| `_buildArgs`（libx264/QSV）                           |   2    |
| burn 前置检查（输入不存在/ASS不存在/空事件/输出覆盖） |   4    |
| burn 成功（正常/QSV/多行弹幕/无Events）               |   4    |
| burn 失败（非零退出码/spawn错误）                     |   2    |
| `getVideoDurationMs`（正常解析/ffprobe失败）          |   2    |
| `estimateTimeout`（短视频/长视频）                    |   2    |
| `probeCapabilities`（全检测/ffmpeg不可用）            |   2    |
| 自定义路径（FFMPEG_PATH/FFPROBE_PATH）                |   1    |

**danmaku-burn-queue.test.js**（24 个测试）：

| 分组                                                          | 测试数 |
| ------------------------------------------------------------- | :----: |
| init（正常配置/强限制最大1/DB失败）                           |   3    |
| enqueue（正常/输入不存在/ASS不存在/输出覆盖）                 |   4    |
| enqueueSession（多分段/无文件/无ASS/优先MP4）                 |   4    |
| processTask（成功+DB同步/burn失败/burner异常）                |   3    |
| 并发控制（getCount/increment/decrement/reset/getQueueLength） |   7    |
| processQueue（空队列/并发上限/重入防护）                      |   3    |

---

## 阶段 4：前端 UI 与配置面板 ✅

**文档**：[PHASE4_FRONTEND_UI_TASKS.md](./PHASE4_FRONTEND_UI_TASKS.md)

### 新增页面

**会话弹幕详情页**（`views/session-danmaku.ejs`）— `GET /sessions/:id/danmaku`：

| 模块         | 说明                                                         |
| ------------ | ------------------------------------------------------------ |
| 会话信息卡片 | room、状态、时间范围、输出路径                               |
| 弹幕录制卡片 | event_count、status、raw/ass 路径、时间范围、错误信息        |
| 分段压制表格 | 文件名、大小、分段时间、ASS 状态、压制状态、单段压制按钮     |
| 弹幕搜索面板 | 关键词搜索、用户名/内容筛选、高亮显示（`<mark>` 标签）、分页 |
| 操作按钮     | 重新生成 ASS、全部加入压制队列、单段压制                     |

### 新增 API

**弹幕搜索 API** — `GET /api/danmaku/search`：

- 参数：`session_id`、`keyword`、`limit`、`offset`
- 读取 JSONL 流式筛选，支持 text/username 关键词匹配（不区分大小写）
- 返回：`{ status: "ok", data: [{ts_ms, ts_str, text, username, user_id}], total, offset, limit }`

### 转码页面改造

**views/transcode.ejs** — 标签页式 UI：

- 「转码记录」tab：原有转码记录表格
- 「弹幕压制」tab：压制记录表格（文件名、ASS、状态、输出、错误、删除/重试按钮 + 活跃任务计数 badge）

### sessions 页面导航

每个会话卡片新增「弹幕详情」按钮，直接跳转到 `/sessions/:id/danmaku`

### 后端改动

- `services/DataService.js`：新增 `query()` 通用查询方法 + `getSessionDetail()` 会话详情（并行查询 session + capture + burn + files + room，含文件存在性检查）
- `router/html.js`：新增 `GET /sessions/:id/danmaku` 路由；`GET /transcode` 联动查询 `danmaku_burn_records`
- `router/danmaku.js`：新增 `GET /api/danmaku/search`

---

## 完整变更文件清单

### live_recorder_server

| 文件                                      | 类型      | 说明                                                                 |
| ----------------------------------------- | --------- | -------------------------------------------------------------------- |
| `db/migrate.js`                           | 修改      | danmaku_capture_records + recording_files 扩展字段                   |
| `services/RecorderService.js`             | 修改      | 弹幕录制生命周期集成                                                 |
| `services/DataService.js`                 | 修改      | getSessions LEFT JOIN 弹幕/压制记录；新增 query()/getSessionDetail() |
| `lib/core/danmaku/DanmakuRecorder.js`     | 新增      | 弹幕写入核心模块                                                     |
| `lib/core/danmaku/DanmakuAssGenerator.js` | 新增+修改 | ASS 生成器（含 offsetMs + 空文本修复）                               |
| `lib/core/danmaku-burner.js`              | 新增      | FFmpeg 弹幕压制器                                                    |
| `lib/core/DanmakuBurnQueue.js`            | 新增      | Redis 压制队列                                                       |
| `router/danmaku.js`                       | 新增+修改 | 所有弹幕 API 端点（batch/ass/burn/search/records）                   |
| `router/index.js`                         | 修改      | 挂载 danmaku 路由                                                    |
| `router/html.js`                          | 修改      | sessions/:id/danmaku + /transcode 联动查询                           |
| `views/sessions.ejs`                      | 修改      | 弹幕状态 badge + 压制状态 badge + 弹幕详情按钮                       |
| `views/session-danmaku.ejs`               | 新增      | 会话弹幕详情页                                                       |
| `views/transcode.ejs`                     | 修改      | 标签页 UI（转码记录 + 弹幕压制）                                     |
| `views/settings.ejs`                      | 已有      | 9 项弹幕配置                                                         |

### chrome_live_listener

| 文件                | 类型 | 说明                                      |
| ------------------- | ---- | ----------------------------------------- |
| `inject.js`         | 新增 | WebSocket monkey-patch，拦截 SC_FEED_PUSH |
| `danmaku-parser.js` | 新增 | 弹幕消息解析（comment/gift）              |
| `content.js`        | 修改 | postMessage 转发链路                      |
| `background.js`     | 修改 | 5 秒批量缓冲 + POST /api/danmaku/batch    |
| `config.js`         | 修改 | 弹幕 API 路径                             |
| `manifest.json`     | 修改 | web_accessible_resources 声明             |

### 测试文件

| 文件                                 | 类型 | 测试数 |
| ------------------------------------ | ---- | :----: |
| `test/danmaku-ass-generator.test.js` | 新增 |   52   |
| `test/danmaku-burner.test.js`        | 新增 |   24   |
| `test/danmaku-burn-queue.test.js`    | 新增 |   24   |

### 文档

| 文件                                                                                                 | 说明                     |
| ---------------------------------------------------------------------------------------------------- | ------------------------ |
| `docs/finished_plan/KUAISHOU_DANMAKU_FULL_IMPLEMENTATION/kuaishou-danmaku-research.md`               | 弹幕协议研究（阶段 0）   |
| `docs/finished_plan/KUAISHOU_DANMAKU_FULL_IMPLEMENTATION/KUAISHOU_DANMAKU_FEASIBILITY_ASSESSMENT.md` | 技术可行性评估（阶段 0） |
| `docs/finished_plan/KUAISHOU_DANMAKU_FULL_IMPLEMENTATION/KUAISHOU_DANMAKU_RECORDING_PLAN.md`         | 总体开发计划             |
| `docs/finished_plan/KUAISHOU_DANMAKU_FULL_IMPLEMENTATION/PHASE1_DANMAKU_CAPTURE_TASKS.md`            | 阶段 1 任务清单          |
| `docs/finished_plan/KUAISHOU_DANMAKU_FULL_IMPLEMENTATION/PHASE2_ASS_GENERATION_TASKS.md`             | 阶段 2 任务清单          |
| `docs/finished_plan/KUAISHOU_DANMAKU_FULL_IMPLEMENTATION/PHASE3_DANMAKU_BURN_TASKS.md`               | 阶段 3 任务清单          |
| `docs/finished_plan/KUAISHOU_DANMAKU_FULL_IMPLEMENTATION/PHASE4_FRONTEND_UI_TASKS.md`                | 阶段 4 任务清单          |
| `docs/finished_plan/KUAISHOU_DANMAKU_FULL_IMPLEMENTATION/KUAISHOU_DANMAKU_IMPLEMENTATION_SUMMARY.md` | 本文档                   |

---

## 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                    Chrome Extension                              │
│                                                                 │
│  inject.js          content.js          background.js           │
│  (WebSocket Hook) → (postMessage)    → (5s 批量缓冲)            │
│                            │                  │                  │
│                            ▼                  ▼                  │
│                    danmaku-parser.js   POST /api/danmaku/batch   │
└─────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                    live_recorder_server                         │
│                                                                 │
│  router/danmaku.js  →  DanmakuRecorder  →  danmaku.jsonl       │
│       │                      │                                  │
│       │                      ▼                                  │
│       │              DanmakuAssGenerator  →  danmaku.ass        │
│       │                      │                 danmaku_segments/│
│       │                      ▼                                  │
│       │              DanmakuBurnQueue  →  *_danmaku.mp4         │
│       │                      │                                  │
│       ▼                      ▼                                  │
│  PostgreSQL (danmaku_capture_records / danmaku_burn_records)    │
│  Redis (danmaku_burn_queue / danmaku_burn_processing_count)     │
│                                                                 │
│  EJS Views:                                                     │
│    sessions.ejs        — 弹幕/压制状态总览                       │
│    session-danmaku.ejs — 会话弹幕详情页（搜索+分段压制）          │
│    transcode.ejs       — 转码+弹幕压制标签页                     │
│    settings.ejs        — 弹幕设置面板                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 验证结果

- ✅ **ESLint**：0 errors, 0 warnings
- ✅ **Jest**：14 suites / 247 tests 全部通过
- ✅ **Node.js 加载**：所有路由和模块 require 成功
- ✅ **Chrome Extension**：manifest.json 结构正确，content.js/background.js 通信链路完整

---

## 部署注意事项

1. **kuaishou_danmaku_enabled 默认 `false`**：需在 settings 页面手动开启
2. **压制并发固定 1**：N100 NAS 性能考虑，后端强制 `Math.min(value, 1)`
3. **自动压制默认关闭**：`auto_burn_danmaku=false`，先使用手动入口验证
4. **Docker 镜像要求**：FFmpeg 需包含 `libass`、`fontconfig`、`fonts-noto-cjk`
5. **弹幕失败隔离**：弹幕录制/压制失败不会影响视频录制、转码、HLS 和投稿
