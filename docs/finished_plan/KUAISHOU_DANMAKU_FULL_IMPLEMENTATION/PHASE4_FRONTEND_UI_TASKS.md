# Phase 4：前端 UI 与配置面板

创建日期：2026-06-01

## 概述

阶段 4 的目标是为弹幕录制和压制系统提供完善的前端 UI，使用户可以在 Web 管理界面中查看弹幕录制状态、搜索弹幕内容、管理压制队列。

## 当前状态审查

### 已完成（前三个阶段累积）

| 功能                                        | 位置                    | 状态 |
| ------------------------------------------- | ----------------------- | :--: |
| 弹幕设置面板（9 项配置）                    | `views/settings.ejs`    |  ✅  |
| 弹幕设置保存逻辑                            | `views/settings.ejs` JS |  ✅  |
| 会话列表弹幕/压制状态 badge                 | `views/sessions.ejs`    |  ✅  |
| 文件表格弹幕列 + "生成 ASS"/"压制弹幕" 按钮 | `views/sessions.ejs`    |  ✅  |
| 压制队列 API                                | `router/danmaku.js`     |  ✅  |
| 弹幕录制/压制记录 API                       | `router/danmaku.js`     |  ✅  |

### 待完成

| 任务 | 说明                                   |   状态    |
| ---- | -------------------------------------- | :-------: |
| T4-1 | 会话弹幕详情页 `/sessions/:id/danmaku` | ✅ 已完成 |
| T4-2 | 弹幕搜索 API `GET /api/danmaku/search` | ✅ 已完成 |
| T4-3 | 转码页面扩展：弹幕压制队列展示         | ✅ 已完成 |

## 阶段 4 全部完成

### 变更文件

| 文件                                    | 类型     | 说明                                                                                    |
| --------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `router/html.js`                        | 修改     | 新增 `GET /sessions/:id/danmaku` 路由；`GET /transcode` 联动查询 `danmaku_burn_records` |
| `services/DataService.js`               | 修改     | 新增 `query()` 通用方法 + `getSessionDetail()` 会话详情（含弹幕+压制+分段）             |
| `router/danmaku.js`                     | 修改     | 新增 `GET /api/danmaku/search` 搜索 JSONL 弹幕（关键词+分页）                           |
| `views/session-danmaku.ejs`             | **新增** | 会话弹幕详情页 — 信息卡片、分段压制表格、弹幕搜索面板                                   |
| `views/sessions.ejs`                    | 修改     | 每个会话卡片新增「弹幕详情」导航按钮                                                    |
| `views/transcode.ejs`                   | 修改     | 标签页式 UI：转码记录 + 弹幕压制队列（含重试/删除操作）                                 |
| `docs/todo/PHASE4_FRONTEND_UI_TASKS.md` | 新增     | 阶段文档                                                                                |

### T4-1：会话弹幕详情页功能

| 模块         | 说明                                                     |
| ------------ | -------------------------------------------------------- |
| 会话信息卡片 | room、状态、时间范围、输出路径                           |
| 弹幕录制卡片 | event_count、status、raw/ass 路径、时间范围、错误信息    |
| 分段压制表格 | 文件名、大小、分段时间、ASS 状态、压制状态、单段压制按钮 |
| 弹幕搜索面板 | 关键词搜索、用户名/内容筛选、高亮显示、分页              |
| 操作按钮     | 重新生成 ASS、全部加入压制队列、单段压制                 |

### T4-2：弹幕搜索 API

- `GET /api/danmaku/search?session_id=1&keyword=你好&limit=50&offset=0`
- 返回：`{ status: "ok", data: [{ts_ms, ts_str, text, username, user_id}], total, offset, limit }`
- 支持按弹幕文本或用户名搜索，不区分大小写

### T4-3：转码页面标签页

- 「转码记录」tab：原有转码记录表格
- 「弹幕压制」tab：压制记录表格（状态、ASS 文件、输出文件、错误信息、删除/重试）

### 验证

- [x] ESLint 0 errors
- [x] Jest 14 suites / 247 tests 全部通过
- [x] 所有路由和模块 Node.js 加载成功
