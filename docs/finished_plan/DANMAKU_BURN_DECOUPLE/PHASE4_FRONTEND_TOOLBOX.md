# Phase 4: 前端工具箱页面

> **状态**: 待实施
> **最后更新**: 2026-06-02
> **预计工期**: 2-3 天

---

## 依赖关系

```
Phase 4 前置依赖:
✅ Phase 1 (自动压制关闭) — 必须完成
✅ Phase 2 (目录结构)   — 必须完成
✅ Phase 3 (数据库解耦) — 必须完成

Phase 4 可并行:
  Phase 5 Step 1-2 (全局搜索废弃引用、移除废弃 import)
```

---

## 1. 目标

提供一个独立的前端界面，统一管理所有弹幕相关操作：查看采集状态、预览 ASS、批量/单个压制、查看和管理压制产物。

**解除耦合**：将弹幕操作从 `sessions.ejs`（录制文件列表）和 `session-danmaku.ejs`（弹幕详情页）中解耦出来，原有页面只保留只读展示。

---

## 2. 界面设计

### 2.1 导航入口

在顶部导航栏新增「弹幕工具箱」入口，位于「转码记录」和「投稿管理」之间。

```html
<!-- views/partials/_header.ejs 修改 -->
<nav>
  <a href="/sessions">录制文件</a>
  <a href="/toolbox/danmaku">弹幕工具箱</a>
  <!-- 新增 -->
  <a href="/transcode">转码记录</a>
  <a href="/upload">投稿管理</a>
</nav>
```

### 2.2 页面整体布局（`views/toolbox-danmaku.ejs`）

```
┌──────────────────────────────────────────────────────┐
│  📺 弹幕工具箱                    [说明文档] [刷新] │
├──────────────────────────────────────────────────────┤
│  [活跃采集: 3] [ASS就绪: 12] [排队中: 2]          │
│  [压制中: 1] [已完成: 45] [失败: 0]                │
├──────────────────────────────────────────────────────┤
│  直播间: [全部 ▼]  状态: [全部 ▼]  [搜索弹幕]     │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌─ 直播间 #12345 (xx名字) ──────────────────┐    │
│  │  2024-01-15 录制会话  [生成ASS] [搜索弹幕]│    │
│  │  ┌────────┬────────┬────────┬──────────┐  │    │
│  │  │ 分段1  │ 00:00  │ ASS✅  │ ☑ 压制  │  │    │
│  │  ├────────┼────────┼────────┼──────────┤  │    │
│  │  │ 分段2  │ 05:23  │ ASS✅  │ ☑ 压制  │  │    │
│  │  └────────┴────────┴────────┴──────────┘  │    │
│  │                                [全部压制]    │    │
│  └────────────────────────────────────────────┘    │
│                                                      │
│  ┌─ 压制产物 ────────────────────────────────┐    │
│  │  output_20240115_12345_part1.mp4  [播放] [下载]│  │
│  │  output_20240115_12345_part2.mp4  [播放] [下载]│  │
│  └────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
         ┌─────────────────────────┐
         │ ☑ 已选 3 个分段        │  ← 悬浮批量操作栏
         │ [加入压制队列] [取消]   │
         └─────────────────────────┘
```

### 2.3 关键交互

| 交互       | 说明                                                                     |
| ---------- | ------------------------------------------------------------------------ |
| 分段复选框 | 仅 `ass_generated=true` 且 `burn_status` 为 `pending` 或 `failed` 时可选 |
| 全部压制   | 对该会话下所有可压制的分段发起压制，使用默认参数                         |
| 搜索弹幕   | 跳转到弹幕搜索页面（Phase 4 新增或已有页面）                             |
| 播放产物   | 打开视频播放器，显示叠加了弹幕的视频                                     |
| 下载产物   | 下载压制好的 MP4 文件                                                    |
| 批量操作栏 | 勾选 ≥1 个分段后从底部滑出，支持一键全部入队                             |

---

## 3. 后端 API 设计

### 基础 URL

所有工具箱 API 使用 `/api/danmaku-toolbox/` 前缀，与现有 `/api/danmaku/*` 路由明确区分，避免混淆。

### 统一错误响应格式

```json
// 400 / 404 / 500 统一格式
{
  "success": false,
  "error": {
    "code": "ERR_DANMAKU_SESSION_NOT_FOUND",
    "message": "Human readable message",
    "details": {}
  }
}
```

错误码规范：

| HTTP 状态码 | 错误码示例                      | 说明           |
| ----------- | ------------------------------- | -------------- |
| 400         | `ERR_DANMAKU_INVALID_PARAMS`    | 参数校验失败   |
| 404         | `ERR_DANMAKU_SESSION_NOT_FOUND` | 会话不存在     |
| 404         | `ERR_DANMAKU_SEGMENT_NOT_FOUND` | 分段不存在     |
| 409         | `ERR_DANMAKU_ALREADY_QUEUED`    | 分段已在队列中 |
| 500         | `ERR_DANMAKU_INTERNAL`          | 服务器内部错误 |

> **权限说明**：当前为单用户场景，暂未做权限校验。未来多用户场景下，所有写操作（`POST batch-burn`、`DELETE product`）需校验登录态，读操作可匿名访问。

### API 列表

#### `GET /api/danmaku-toolbox/sessions`

获取有弹幕数据的录制会话列表（分页）。

**请求参数**：

| 参数   | 类型   | 必填 | 默认值 | 说明                                                                 |
| ------ | ------ | ---- | ------ | -------------------------------------------------------------------- |
| page   | number | 否   | 1      | 页码                                                                 |
| limit  | number | 否   | 20     | 每页条数，最大 100                                                   |
| roomId | string | 否   | -      | 按直播间筛选                                                         |
| status | string | 否   | -      | 按状态筛选（`ass_ready` / `queued` / `burning` / `done` / `failed`） |

**响应**：

```json
{
  "success": true,
  "data": {
    "sessions": [
      {
        "sessionId": "abc-123",
        "roomId": "12345",
        "roomName": "xx主播",
        "startTime": "2024-01-15T10:00:00Z",
        "segments": [
          {
            "segmentIndex": 1,
            "assGenerated": true,
            "burnStatus": "pending",
            "burnQueueAt": null,
            "productPath": null
          }
        ],
        "stats": {
          "totalSegments": 2,
          "assReady": 2,
          "queued": 0,
          "burning": 0,
          "done": 0,
          "failed": 0
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 58
    }
  }
}
```

#### `GET /api/danmaku-toolbox/session/:sessionId/segments`

获取单个会话的分段详情（用于展开行异步加载）。

**响应**：

```json
{
  "success": true,
  "data": {
    "sessionId": "abc-123",
    "segments": [
      {
        "segmentIndex": 1,
        "startTime": "00:00:00",
        "endTime": "00:05:23",
        "assGenerated": true,
        "assFilePath": "/data/danmaku/ass/abc-123_part1.ass",
        "burnStatus": "pending",
        "burnQueueAt": null,
        "burnStartedAt": null,
        "burnFinishedAt": null,
        "productPath": null,
        "productSize": null
      }
    ]
  }
}
```

#### `POST /api/danmaku-toolbox/batch-burn`

将多个分段加入压制队列。

**请求体**：

```json
{
  "items": [
    { "sessionId": "abc-123", "segmentIndex": 1 },
    { "sessionId": "abc-123", "segmentIndex": 2 }
  ],
  "options": {
    "fontSize": 36,
    "opacity": 0.8,
    "position": "bottom"
  }
}
```

> **限制**：`items` 数组最大长度为 **50**，超出返回 400 `ERR_DANMAKU_INVALID_PARAMS`。

**响应**：

```json
{
  "success": true,
  "data": {
    "queued": 2,
    "skipped": 0,
    "failed": []
  }
}
```

#### `GET /api/danmaku-toolbox/products`

获取已完成压制产物列表（分页）。

**请求参数**：

| 参数   | 类型   | 必填 | 默认值 | 说明               |
| ------ | ------ | ---- | ------ | ------------------ |
| page   | number | 否   | 1      | 页码               |
| limit  | number | 否   | 20     | 每页条数，最大 100 |
| roomId | string | 否   | -      | 按直播间筛选       |

**响应**：

```json
{
  "success": true,
  "data": {
    "products": [
      {
        "sessionId": "abc-123",
        "segmentIndex": 1,
        "productPath": "/data/danmaku/output/abc-123_part1.mp4",
        "productSize": 104857600,
        "burnFinishedAt": "2024-01-15T12:00:00Z",
        "downloadUrl": "/api/danmaku-toolbox/download?path=..."
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 45 }
  }
}
```

#### `DELETE /api/danmaku-toolbox/product`

删除指定压制产物（软删除，标记 `burn_status=deleted`）。

**请求体**：

```json
{
  "sessionId": "abc-123",
  "segmentIndex": 1
}
```

---

## 4. 性能考虑

### 4.1 数据库索引

在 Phase 3 迁移时，确保以下索引已创建：

```sql
-- danmaku_capture_records
CREATE INDEX idx_danmaku_capture_session
  ON danmaku_capture_records(session_id, status);

-- danmaku_burn_records
CREATE INDEX idx_danmaku_burn_session
  ON danmaku_burn_records(session_id, burn_status);

-- danmaku_burn_queue
CREATE INDEX idx_danmaku_queue_status
  ON danmaku_burn_queue(status, queued_at);
```

### 4.2 查询优化

`GET /api/danmaku-toolbox/sessions` 的查询逻辑：

```javascript
// services/DanmakuService.js
async getToolboxSessions({ page = 1, limit = 20, roomId, status }) {
  // 使用复合索引加速筛选
  // 先查 session 列表，再批量查 stats（避免 N+1）
  const sessions = await db.query(`
    SELECT s.session_id, s.room_id, s.start_time, r.room_name
    FROM recording_sessions s
    JOIN rooms r ON s.room_id = r.room_id
    WHERE s.session_id IN (
      SELECT DISTINCT session_id FROM danmaku_capture_records
    )
    ORDER BY s.start_time DESC
    LIMIT ? OFFSET ?
  `, [limit, (page - 1) * limit]);

  // 批量查 stats
  const stats = await this.batchGetStats(sessions.map(s => s.session_id));
  return { sessions, stats };
}
```

---

## 5. 前端状态刷新策略

### 5.1 轮询策略（初始方案）

工具箱页面使用**指数退避轮询**，根据活跃任务数量动态调整间隔：

```javascript
// public/js/toolbox-danmaku.js
class PollingManager {
  constructor() {
    this.baseInterval = 5000; // 基础间隔 5s
    this.maxInterval = 30000; // 最大间隔 30s
    this.minInterval = 2000; // 最小间隔 2s（活跃任务多时）
    this.timer = null;
  }

  start() {
    this.poll();
  }

  async poll() {
    const data = await fetchToolboxData();
    this.updateUI(data);

    // 动态计算下次轮询间隔
    const activeCount = data.stats.burning + data.stats.queued;
    let interval;
    if (activeCount > 5) {
      interval = this.minInterval;
    } else if (activeCount > 0) {
      interval = this.baseInterval;
    } else {
      interval = this.maxInterval; // 无活跃任务，30s 轮询一次
    }

    this.timer = setTimeout(() => this.poll(), interval);
  }

  stop() {
    clearTimeout(this.timer);
  }
}
```

### 5.2 SSE 推送（未来优化方向）

当活跃任务较多时，轮询效率较低。未来可升级为 SSE（Server-Sent Events）：

```
前端: GET /api/danmaku-toolbox/stream  (Accept: text/event-stream)
后端: 每次队列状态变化时 push event
event: queue_update
data: { queued: 2, burning: 1, done: 45 }
```

> Phase 4 初始实现使用轮询方案，SSE 作为 Phase 6（性能优化）的候选方案。

---

## 6. 对现有页面的影响

### 6.1 `views/sessions.ejs`

Remove：

- 文件列表中的「生成 ASS」按钮
- 文件列表中的「压制弹幕」按钮

Add：

- 文件列表中保留「▶ 弹幕」播放按钮（只读，播放已压制产物）
- 新增「弹幕工具箱 →」链接，跳转到 `/toolbox/danmaku`

### 6.2 `views/session-danmaku.ejs`

改为只读展示页：

- 显示弹幕采集状态、ASS 文件预览链接
- Remove 所有操作按钮（生成 ASS、加入压制队列等）
- 新增「返回工具箱」链接

### 6.3 文件列表弹幕播放

`sessions.ejs` 中已有的弹幕播放功能（`▶ 弹幕` 按钮）**保持不变**，它直接播放 `recording_files.danmaku_ass_path` 关联的已压制文件，属于只读功能。

---

## 7. 实施步骤

### Step 1: 路由和页面骨架

- [ ] 在 `router/danmaku.js` 中新增 `GET /toolbox/danmaku` 路由
- [ ] 创建 `views/toolbox-danmaku.ejs`（基于 `sessions.ejs` 的布局风格）
- [ ] 在 `_header.ejs` 中新增导航入口

### Step 2: 后端 API

- [ ] 创建 `services/DanmakuToolboxService.js`
- [ ] 实现 `GET /api/danmaku-toolbox/sessions`（分页 + 筛选）
- [ ] 实现 `GET /api/danmaku-toolbox/session/:id/segments`
- [ ] 实现 `POST /api/danmaku-toolbox/batch-burn`（含批量上限校验）
- [ ] 实现 `GET /api/danmaku-toolbox/products`
- [ ] 实现 `DELETE /api/danmaku-toolbox/product`

### Step 3: 前端交互

- [ ] 创建 `public/js/toolbox-danmaku.js`
- [ ] 实现会话列表渲染（含分页）
- [ ] 实现分段表格展开/折叠（异步加载）
- [ ] 实现批量选择 + 悬浮操作栏
- [ ] 实现指数退避轮询刷新
- [ ] 实现产物列表 + 播放/下载

### Step 4: 清理旧入口

- [ ] 修改 `sessions.ejs`：移除操作按钮，新增跳转链接
- [ ] 修改 `session-danmaku.ejs`：改为只读展示

### Step 5: 测试

- [ ] 单元测试：新增 Service 方法
- [ ] 集成测试：API 端点（含错误响应格式校验）
- [ ] E2E 测试：批量选择 → 入队 → 刷新状态 → 产物下载

---

## 8. 完成标准

- [ ] 工具箱页面可访问，导航入口正常显示
- [ ] 会话列表正确展示，分页/筛选功能正常
- [ ] 分段可展开，复选框状态正确（仅可压制时可选）
- [ ] 批量操作栏在勾选后正常弹出，入队成功
- [ ] 轮询刷新正常，活跃任务多时间隔自动缩短
- [ ] 产物列表可播放/下载，删除功能正常
- [ ] 所有 API 错误响应格式符合规范
- [ ] 现有 `sessions.ejs` 和 `session-danmaku.ejs` 功能不受影响
- [ ] 单元测试覆盖率 > 80%
