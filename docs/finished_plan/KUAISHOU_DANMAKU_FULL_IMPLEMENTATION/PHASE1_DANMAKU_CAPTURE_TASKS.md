# 阶段 1：弹幕录制基础链路 — 开发任务清单

创建日期：2026-06-01
关联计划：[KUAISHOU_DANMAKU_RECORDING_PLAN.md](./KUAISHOU_DANMAKU_RECORDING_PLAN.md)
关联评估：[KUAISHOU_DANMAKU_FEASIBILITY_ASSESSMENT.md](./KUAISHOU_DANMAKU_FEASIBILITY_ASSESSMENT.md)
预估工期：2–4 天

---

## 背景与前提

阶段 0 已完成（2026-06-01），结论如下：

- 快手弹幕使用 WebSocket + Protobuf binary（SC_FEED_PUSH, PayloadType 310）协议。
- `websocketinfo` 接口有反爬，后端直连不可行。
- **采用 Chrome Extension inject.js 拦截页面 WebSocket**，被动监听，零风控风险。
- payload 格式已实机验证为 **protobuf binary**（所有 WebSocket 消息均为 ArrayBuffer），inject.js 内置零依赖 protobuf wire format 解码器。

---

## 任务分组

### 一、chrome_live_listener 改动（前置，必须先完成）

**所在项目**：`../chrome_live_listener/`

---

#### T1-CE-1：inject.js — WebSocket 拦截基础实现

**目标**：确认 payload 格式，并打印到 console。

**实现步骤**：

1. 新建 `inject.js`，在 `document_start` 阶段注入页面 MAIN world：
   ```js
   const OriginalWebSocket = window.WebSocket;
   window.WebSocket = function (url, protocols) {
     const ws = new OriginalWebSocket(url, protocols);
     if (url && url.includes('kuaishou')) {
       ws.addEventListener('message', (event) => {
         try {
           const data = JSON.parse(event.data);
           if (data.type === 'SC_FEED_PUSH') {
             console.log('[KS_WS]', data.type, data.payload);
             window.postMessage({ source: 'ks_danmaku', message: data }, '*');
           }
         } catch (_) {}
       });
     }
     return ws;
   };
   Object.assign(window.WebSocket, OriginalWebSocket);
   ```
2. 在 `manifest.json` 中声明：
   ```json
   "web_accessible_resources": [{ "resources": ["inject.js"], "matches": ["*://*.kuaishou.com/*"] }],
   "content_scripts": [{ "js": ["inject-loader.js"], "matches": ["*://*.kuaishou.com/*"], "run_at": "document_start", "world": "MAIN" }]
   ```
   > 注意：Manifest V3 中，`world: "MAIN"` 的 content script 可直接访问页面全局，不需要单独 loader。
3. **验证**：打开任意快手直播间，在 DevTools Console 观察 `[KS_WS]` 日志。

**完成标准**：

- [x] 能在 console 看到 `SC_FEED_PUSH` 消息
- [x] 确认 payload 为 protobuf binary（✅ 已内置 protobuf 解码器）

> **实机验证结果**（2026-06-01 更新）：所有 WebSocket 消息均为 ArrayBuffer（二进制 protobuf），inject.js 通过 `EventTarget.prototype.addEventListener` 和 `WebSocket.prototype.onmessage` 在页面 JS 之前拦截原始二进制数据，使用自实现的 protobuf wire format 解码器解析。JSON 仅作为字符串消息的 fallback 路径。

---

#### T1-CE-2：danmaku-parser.js — 弹幕消息解析

**目标**：将 SC_FEED_PUSH 解析为标准化事件格式。

**前提**：T1-CE-1 验证完成，确认 payload 格式。

**情况 A — protobuf binary（实际实现）**：

> **2026-06-01 更新**：实机验证确认所有消息均为 protobuf binary。inject.js 内置零依赖 protobuf wire format 解码器（~150 行），核心逻辑如下：
> - `readVarint()` / `decodeProto()` — 线格式解码，支持 varint、嵌套消息、UTF-8 字符串
> - `processBinaryMessage()` — 外层 protobuf 结构: field 1 = payloadType (varint), field 2 = seqId, field 3 = payload (nested message)
> - `extractPbEvents()` — PayloadType 分发: 310=FEED_PUSH 提取弹幕/礼物, 340=WATCHING_LIST 跳过
> - `tryExtractComment()` / `tryExtractGift()` — 子消息提取: commentFeeds (field 5)、giftFeeds (field 8)
> - `isRealText()` — 文本过滤器: 排除 base64 编码、URL、数字 ID 字符串、camelCase 标识符

```js
// danmaku-parser.js (ES module)
export function normalizeDanmakuBatch(rawEvents, sessionId) { ... }
export function filterDanmakuEvents(events) { ... }
```

**~~情况 B — JSON payload~~（已废弃，实际未出现）**：

~~从快手 JS bundle 提取 proto 定义文件~~
~~引入 `protobufjs`~~
~~离线 decode 后转为上述标准格式~~

> 实际不需要 protobufjs，也不需要提取 proto 定义文件。inject.js 的自实现解码器足以处理所有已知消息。

**完成标准**：

- [x] parser 输出标准事件格式：`{ type, ts_ms, user, user_id, text, raw }`
- [x] comment 和 gift 均可解析
- [x] 未知字段保留到 `raw` 中

---

#### T1-CE-3：content.js — postMessage 转发链路

**目标**：把 inject.js 发出的 postMessage 转发给 background.js。

**改动点**（在现有 `content.js` 基础上追加）：

```js
window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== 'ks_danmaku') return;
  chrome.runtime.sendMessage({ type: 'KS_DANMAKU_EVENT', payload: event.data.message });
});
```

**完成标准**：

- [x] background.js 收到 `KS_DANMAKU_EVENT` 消息

---

#### T1-CE-4：background.js — 弹幕缓冲与批量推送

**目标**：5 秒批量收集弹幕事件，POST 到后端 `/api/danmaku/batch`。

**改动点**（在现有 background.js 基础上增加）：

```js
// 弹幕缓冲
let danmakuBuffer = [];
let flushTimer = null;
let activeLiveSessionId = null; // 从 live download 通知时设置

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'KS_DANMAKU_EVENT') {
    const events = danmakuParser.parseFeedPush(msg.payload.payload);
    danmakuBuffer.push(...events);
    if (!flushTimer) {
      flushTimer = setTimeout(flushDanmaku, 5000);
    }
  }
  // 录制开始/结束时更新 activeLiveSessionId
  if (msg.type === 'RECORDING_STARTED') activeLiveSessionId = msg.sessionId;
  if (msg.type === 'RECORDING_STOPPED') activeLiveSessionId = null;
});

async function flushDanmaku() {
  flushTimer = null;
  if (!danmakuBuffer.length || !activeLiveSessionId) return;
  const batch = danmakuBuffer.splice(0);
  try {
    await fetch(`${API_BASE}/api/danmaku/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: activeLiveSessionId, events: batch }),
    });
  } catch (e) {
    // 推送失败只 warn，不影响录制
    console.warn('[KS_DANMAKU] flush failed', e.message);
  }
}
```

**完成标准**：

- [x] 每 5 秒 POST 一次（有数据时）
- [x] 无数据或无会话 ID 时不发请求
- [x] 推送失败不抛异常

---

#### T1-CE-5：config.js — 弹幕 API 路径配置

**目标**：统一管理弹幕相关的 API 路径。

**改动**：

```js
// 在现有 config.js 中追加
const DANMAKU_BATCH_PATH = '/api/danmaku/batch';
```

---

### 二、live_recorder_server 改动

---

#### T1-BE-1：数据库迁移 — 新增弹幕相关表和字段

**文件**：`db/migrate.js`

**需要新增**：

```sql
-- 弹幕采集记录表
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

-- recording_files 补充分段时间和弹幕字段
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS segment_start_ms INTEGER DEFAULT 0;
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS segment_end_ms INTEGER DEFAULT 0;
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS danmaku_ass_path VARCHAR(1024) DEFAULT '';
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS danmaku_burn_path VARCHAR(1024) DEFAULT '';
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS is_danmaku_burned BOOLEAN DEFAULT FALSE;
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS danmaku_burned_at TIMESTAMP;
```

**settings 初始化追加**：

| 键                         | 默认值  | 说明                 |
| -------------------------- | ------- | -------------------- |
| `kuaishou_danmaku_enabled` | `false` | 是否启用快手弹幕录制 |

**完成标准**：

- [x] 启动时自动执行迁移无报错
- [x] `danmaku_capture_records` 表存在
- [x] `recording_files` 新字段存在

---

#### T1-BE-2：DanmakuRecorder.js — 弹幕写入核心模块

**文件**：`lib/core/danmaku/DanmakuRecorder.js`

**职责**：

- 管理会话级弹幕采集生命周期（start / append / stop）
- 接收批量弹幕事件，写入 `danmaku.jsonl`
- 维护数据库记录（`danmaku_capture_records`）
- 时间戳归一化（相对会话 started_at 的 offset_ms）

**核心接口**：

```js
class DanmakuRecorder {
  // 开始录制，绑定 sessionId，创建 danmaku.jsonl
  async start({ sessionId, roomId, sessionDir, sessionStartedAt }) {}

  // 批量写入弹幕事件（来自 /api/danmaku/batch）
  // events: [{ type, ts_ms(绝对时间), user, text, raw }]
  async appendEvents(sessionId, events) {}

  // 结束录制，flush 文件，更新数据库
  async stop(sessionId) {}

  // 获取当前状态
  getStatus(sessionId) {}
}
```

**时间戳规则**：

- 入参 `ts_ms` 为浏览器绝对时间戳
- 写入 JSONL 时转为相对偏移：`offset_ms = ts_ms - sessionStartedAt`
- `offset_ms` 是最终用于 ASS 生成的时间轴

**JSONL 格式**：

```json
{ "offset_ms": 12345, "type": "comment", "user": "用户名", "user_id": "xxx", "text": "弹幕内容", "raw": {} }
```

**完成标准**：

- [x] `start()` 创建 JSONL 文件并写入数据库记录（status=recording）
- [x] `appendEvents()` 原子追加，不阻塞主线程
- [x] `stop()` flush 文件、更新 event_count、status=completed
- [x] 对同一 sessionId 重复 start 时，幂等处理（不重复创建记录）

---

#### T1-BE-3：POST /api/danmaku/batch 接口

**文件**：`router/danmaku.js`（新增）

**接口规格**：

```
POST /api/danmaku/batch
Content-Type: application/json

请求体：
{
  "session_id": 123,
  "events": [
    { "type": "comment", "ts_ms": 1717200000000, "user": "xxx", "text": "弹幕" },
    ...
  ]
}

成功响应 200：
{ "ok": true, "received": 5 }

失败响应 400/404：
{ "ok": false, "error": "session not found" }
```

**逻辑**：

1. 校验 `session_id` 存在且对应会话状态为 `recording`。
2. 调用 `DanmakuRecorder.appendEvents()`。
3. 返回接收数量。

**完成标准**：

- [x] 接口可用，返回 200
- [x] session_id 不存在时返回 404
- [x] 批量接收无性能问题（单批 100 条以内）

---

#### T1-BE-4：RecorderService.js 集成弹幕录制生命周期

**文件**：`services/RecorderService.js`

**改动点**：

1. `startRecording()` 末尾：若 `kuaishou_danmaku_enabled=true` 且房间平台为快手，调用 `danmakuRecorder.start()`。
2. `finishSession()` 中：调用 `danmakuRecorder.stop(sessionId)`。
3. 录制启动时通过响应告知 Chrome Extension 当前 `session_id`（或在已有 `/api/notify/live_download` 响应体中加入 `danmaku_session_id` 字段）。

**关键细节**：

- 弹幕录制失败不影响视频录制（try/catch 隔离）。
- 若 `kuaishou_danmaku_enabled=false`，不做任何弹幕操作。

**完成标准**：

- [x] 录制开始时自动创建弹幕录制记录（若启用）
- [x] 录制结束时自动 stop 弹幕录制
- [x] 弹幕模块异常不影响视频录制流程

---

#### T1-BE-5：路由挂载

**文件**：`router/index.js`

```js
const danmakuRouter = require('./danmaku');
router.use('/api', danmakuRouter);
```

---

#### T1-BE-6：sessions 页面显示弹幕状态

**文件**：`views/sessions.ejs`、`router/html.js`

**改动**：

- `html.js` 查询 sessions 时左连接 `danmaku_capture_records`，带出 `danmaku_status`、`event_count`。
- `sessions.ejs` 每行会话增加"弹幕"列，显示：
  - `—`：未启用或非快手平台
  - `录制中 (N条)` （绿色）
  - `已完成 (N条)`
  - `失败`（红色）

**完成标准**：

- [x] 页面能看到弹幕录制状态

---

## 验证顺序

建议按如下顺序端到端验证：

```
1. 安装修改后的 chrome_live_listener
2. 打开快手直播间，观察 console 中 [KS_WS] 日志（T1-CE-1）
3. 确认 payload 格式后完成 danmaku-parser.js（T1-CE-2）
4. 启动 live_recorder_server（已有弹幕数据库迁移）
5. 触发一次录制，在 Extension 中设置 activeLiveSessionId
6. 观察 /api/danmaku/batch 收到请求，JSONL 文件写入成功
7. 停止录制，确认 danmaku_capture_records 状态更新为 completed
8. 在 sessions 页面看到弹幕事件数量
```

---

## 阻塞项与注意事项

| 项目                    | 说明                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **payload 格式验证**    | ~~若是 protobuf binary 需额外 1-2 天~~ → **已解决**：实机验证确认为 protobuf binary，inject.js 自实现解码器已实现 |
| **session_id 传递**     | Extension 需要知道当前会话 ID；最简单方式是在 `/api/notify/live_download` 响应中带上，Extension 收到后存入 `activeLiveSessionId` |
| **分段时间记录**        | 建议同步在 `FFmpegDownloader.js` 中记录每个分段打开时间，为阶段 2 ASS 裁剪提供精确数据                                           |
| **Service Worker 保活** | Extension background.js 的 service worker 可能被浏览器 sleep，弹幕心跳（5s 刷新计时）本身足以保活                                |

---

---

## 阶段 1 全部完成 ✅

完成日期：2026-06-01

### 完成状态

| 任务    | 说明                          |                         状态                          |
| ------- | ----------------------------- | :---------------------------------------------------: |
| T1-CE-1 | inject.js — WebSocket 拦截    |      ✅ payload 为 protobuf binary，内置解码器      |
| T1-CE-2 | danmaku-parser.js — 弹幕解析  |               ✅ comment/gift 均可解析                |
| T1-CE-3 | content.js — postMessage 转发 |                      ✅ 链路正常                      |
| T1-CE-4 | background.js — 5s 批量推送   |                  ✅ 推送失败不抛异常                  |
| T1-CE-5 | config.js — API 路径配置      |                          ✅                           |
| T1-BE-1 | 数据库迁移                    | ✅ danmaku_capture_records + recording_files 扩展字段 |
| T1-BE-2 | DanmakuRecorder.js — 写入核心 |         ✅ start/appendEvents/stop + 幂等处理         |
| T1-BE-3 | POST /api/danmaku/batch       |              ✅ session 校验 + 批量接收               |
| T1-BE-4 | RecorderService.js 集成       |               ✅ 弹幕失败不影响视频录制               |
| T1-BE-5 | 路由挂载                      |                          ✅                           |
| T1-BE-6 | sessions 页面弹幕状态         |               ✅ LEFT JOIN + badge 显示               |

### 核心决策

- **payload 格式**：Protobuf binary（非 JSON），inject.js 内置零依赖 protobuf wire format 解码器
- **protobuf 字段映射**：SC_FEED_PUSH (pt=310) payload 中，field 5 = commentFeeds, field 8 = giftFeeds; comment 子消息: field 2.f1=userId, field 2.f2=userName, comment text 取最长有效文本
- **文本过滤**：`isRealText()` 函数排除 base64 编码、URL、数字 ID 串、camelCase 标识符等非弹幕文本
- **PayloadType 过滤**：pt=340 (LIVE_WATCHING_LIST) 包含用户名但无弹幕，已跳过避免误判
- **时间戳规则**：写入 JSONL 时 `offset_ms = ts_ms - sessionStartedAt`
- **弹幕隔离**：弹幕模块异常不影响视频录制（try/catch 隔离）

---

## 后续阶段

- **阶段 2**：ASS 生成（`DanmakuAssGenerator.js`）→ 已完成，见 `PHASE2_ASS_GENERATION_TASKS.md`
- **阶段 3**：弹幕压制队列（`DanmakuBurnQueue.js`）→ 已完成，见 `PHASE3_DANMAKU_BURN_TASKS.md`
- **阶段 4**：前端 UI 与配置面板 → 已完成，见 `PHASE4_FRONTEND_UI_TASKS.md`
