# 仪表盘（Dashboard）改造计划

状态：已完成并归档（2026-06-10）

## 背景

当前仪表盘只展示了 4 个统计卡片（活跃录制、转码队列、直播间总数、转码并发）和一张活跃录制表格，本质上是一个"谁在录"的实时状态页。但系统在过去几轮迭代中已经新增了弹幕采集/压制流水线、HLS 生成、5 平台轮询系统、自动投稿等成熟子系统，仪表盘完全没有反映这些能力。

主要问题：

1. **弹幕子系统不可见**：后端已有 `/api/danmaku/status` 接口输出采集/压制队列状态，但 Dashboard 完全没有展示。
2. **轮询状态缺失**：5 个平台的 PollingChecker 在后台运行，Dashboard 只显示"直播间总数"，看不出多少房间正在被轮询、多少检测到开播、轮询是否健康。
3. **缺少近期活动**：没有"今日完成了多少录制""最近投稿了什么""最近有没有中断"等汇总信息，用户每次都需要跳到其他页面查看。
4. **信息密度不均**：无活跃录制时页面几乎空白；底部健康状态与 Layout footer 信息重复。
5. **缺少磁盘/资源概览**：sessions 和 recording_files 表有 `total_size` / `file_size` 字段，可以聚合展示总录制量和磁盘占用。

## 目标

将 Dashboard 从"实时录制状态板"升级为**系统运维概览**，使用户在一个页面内就能掌握系统全貌。

改造遵循以下原则：

- **不引入新的外部依赖**，继续沿用 TailwindCSS + Vue 3 Composition API
- **后端 API 扩展优先于新建**，在现有 `/api/dashboard/status` 接口上增加字段，减少前端并发请求数
- **渐进式实施**，后端接口扩展和前端 UI 改造可分阶段独立上线
- **保持自动刷新**，新数据同样支持轮询刷新

### 废弃与降级内容

改造后以下现有内容将被移除或替代：

| 现有内容                                                         | 处理方式                                                                         | 原因                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| "直播间总数"卡片                                                 | **移除**，房间总数信息融入"轮询状态"卡片（`total_polled` + 副文字"已配置 x 间"） | 单纯的房间总数缺乏运维价值，轮询卡片已覆盖                           |
| "转码并发"卡片                                                   | **移除**，并发信息降级为转码队列卡片的副文字（"处理中 x / 并发 y"）              | 并发数是静态配置，不需要独占一个卡片                                 |
| Dashboard 底部健康指示（健康圆点 + 版本号 + "查看完整日志"链接） | **移除**，收敛到"系统状态"面板；版本信息由全局 Layout footer 统一展示            | 消除与 Layout footer 的重复信息                                      |
| Dashboard 内部的 `/api/health` 独立请求                          | **移除**，改用 appStore 全局健康状态                                             | Layout 已在 `onMounted` 调用 `fetchHealth()`，Dashboard 不应重复请求 |
| Dashboard 内部的 `/api/rooms` 请求（仅取 `total`）               | **移除**，房间统计由后端 dashboard API 统一返回                                  | 消除冗余请求                                                         |

---

## 现有 Dashboard API 数据结构

```javascript
// GET /api/dashboard/status
{
  status: 'ok',
  data: {
    active_recordings: [
      { room_url, room_name, pid, session_id, started_at, downloader }
    ],
    active_count: number,
    pool_size: number,
    transcode: {
      queue_length: number,
      processing: number,
      concurrency: number,
    },
  },
}
```

前端额外并发请求 `/api/rooms`（取 `total`）和 `/api/health`（取 `ok` + `version`）。

## 改造后目标数据结构

```javascript
// GET /api/dashboard/status（扩展后）
{
  status: 'ok',
  data: {
    // ── 保留现有字段 ──
    active_recordings: [...],
    active_count: number,
    pool_size: number,
    transcode: { queue_length, processing, concurrency },

    // ── 新增：弹幕子系统 ──
    danmaku: {
      active_captures: number,         // 当前正在采集弹幕的会话数
      burn_queue: {
        queue_length: number,
        processing: number,
        concurrency: number,
      },
    },

    // ── 新增：轮询概览 ──
    polling: {
      total_polled: number,            // 启用轮询的房间数
      total_rooms: number,             // 直播间配置总数
      currently_live: number,          // 当前检测到开播的房间数
      platform_breakdown: {            // 按平台统计
        [platform]: { total: number, live: number },
      },
    },

    // ── 新增：统计摘要 ──
    summary: {
      sessions_today: number,          // 今日完成的录制会话数
      sessions_today_total_size: number, // 今日录制总字节数
      interrupted_today: number,       // 今日异常中断数
      uploads_today: number,           // 今日投稿数
      uploads_failed_today: number,    // 今日投稿失败数
      orphaned_files: number,          // 未关联的孤文件数
    },

    // ── 新增：近期活动 ──
    recent_activity: [
      {
        type: 'session_completed' | 'session_interrupted' | 'upload_success'
              | 'upload_failed' | 'transcode_completed' | 'transcode_failed',
        title: string,                 // 如 "KSG小屿 录制完成"
        detail: string,                // 如 "3 个分段, 1.2 GB"
        timestamp: string,             // ISO-8601 时间
        link: string | null,           // vue-router 路径（见下方约定）
      },
    ],
  },
}
```

### `link` 字段路由约定

`link` 为 vue-router 的 **path 字符串**（如 `/sessions`、`/upload-records`、`/transcode`），前端使用 `<router-link :to="activity.link">` 渲染。不使用命名路由，避免后端需要感知前端路由名称。当 `link` 为 `null` 时，前端渲染为纯文本，不包裹链接标签。

---

## Phase 1：后端 API 扩展

**目标**：在 `/api/dashboard/status` 中聚合所有仪表盘需要的数据，前端只需一次请求即可拿到完整状态。

### 1.1 弹幕子系统状态

**数据来源**：复用 `danmakuRecorder.getActiveStats()` 和 `danmakuBurnQueue` 的方法（与 `/api/danmaku/status` 相同数据源）。

**实现**：

```javascript
// router/api.js — dashboard/status 路由内新增
const danmakuRecorder = require('../lib/core/danmaku/DanmakuRecorder');
const danmakuBurnQueue = require('../lib/core/DanmakuBurnQueue');

const activeStats = danmakuRecorder.getActiveStats();
const burnQueueLength = await danmakuBurnQueue.getQueueLength();
const burnProcessing = await danmakuBurnQueue.getCurrentProcessingCount();

// 添加到响应 data 中
danmaku: {
  active_captures: Array.isArray(activeStats) ? activeStats.length : (activeStats?.count ?? 0),
  burn_queue: {
    queue_length: burnQueueLength,
    processing: burnProcessing,
    concurrency: danmakuBurnQueue.concurrency,
  },
},
```

**已确认**：`DanmakuRecorder.getActiveStats()` 当前返回数组。上述兼容写法仍保留，避免未来该方法调整为 `{ count, sessions }` 结构后导致 Dashboard 崩溃。

### 1.2 轮询概览

**数据来源**：`pollingManager` 实例 + Redis `live_status` 缓存。

#### 性能设计（缓存式）

仪表盘接口 5 秒调用一次，如果每次都逐房间查 DB + Redis，当轮询房间数达数百时会严重拖慢响应。改为**在 PollingManager 内部维护内存快照**，状态变更时更新，接口直接读取。

**当前代码事实**：

- `PollingManager.timers` 是 `Map<room:${id}, Timeout>`，value 只有定时器，不包含平台信息。
- `PollingManager.roomLiveStatus` 已存在，类型是 `Map<roomId, boolean>`，由 Redis `polling:live_status:${id}` 恢复，并在每次成功检查后更新。
- `rooms.last_live_status` / `rooms.last_polled_at` 数据库字段已经被迁移脚本删除，不能作为 fallback 数据源。

因此需要新增一个独立的 `roomPollingMeta` Map 保存房间基础信息，避免从 timer value 反推平台：

```javascript
// lib/core/polling/PollingManager.js — 构造函数新增
this.roomPollingMeta = new Map(); // Map<roomId, { platform, roomName, roomUrl }>

// startRoomPolling(room) 成功注册定时器后写入
this.roomPollingMeta.set(room.id, {
  platform: room.polling_platform || 'unknown',
  roomName: room.room_name || '',
  roomUrl: room.room_url,
});

// stopRoomPolling(roomId) 删除
this.roomPollingMeta.delete(roomId);

/**
 * 获取轮询概览快照（内存式，O(n)，n = 已启用轮询房间数）
 * 只遍历内存 Map，不访问 DB / Redis
 */
getPollingSnapshot() {
  const platformBreakdown = {};
  let currentlyLive = 0;

  for (const [roomId, meta] of this.roomPollingMeta) {
    const platform = meta.platform || 'unknown';
    if (!platformBreakdown[platform]) {
      platformBreakdown[platform] = { total: 0, live: 0 };
    }

    platformBreakdown[platform].total++;

    const isLive = this.roomLiveStatus.get(roomId) === true;
    if (isLive) {
      currentlyLive++;
      platformBreakdown[platform].live++;
    }
  }

  return {
    total_polled: this.roomPollingMeta.size,
    total_rooms: this._totalRooms ?? this.roomPollingMeta.size,
    currently_live: currentlyLive,
    platform_breakdown: platformBreakdown,
  };
}
```

快照更新时机：

| 触发点                                  | 更新内容                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `loadPollingRooms()`                    | 设置 `_totalRooms = rooms.length`                                              |
| `startRoomPolling(room)`                | 写入 `roomPollingMeta.set(room.id, ...)`                                       |
| `stopRoomPolling(roomId)`               | 删除 `roomPollingMeta.delete(roomId)` 和可选的 `roomLiveStatus.delete(roomId)` |
| `checkRoom(room)` 成功拿到非 error 结果 | 更新 `roomLiveStatus.set(room.id, isLive)`                                     |
| `stop()`                                | 清空 `timers` 和 `roomPollingMeta`，`roomLiveStatus` 可保留用于下一次启动恢复  |

Dashboard API 中直接调用：

```javascript
const pollingManager = require('../lib/core/polling/PollingManager');

polling: pollingManager.getPollingSnapshot(),
```

#### Redis live_status 的恢复策略

Redis 缓存可能未命中（如服务刚启动尚未轮询、Redis 连接异常等）。由于数据库已不再保存 `rooms.last_live_status` 字段，Dashboard 不做 DB fallback：

1. `loadPollingRooms()` 和 `startRoomPolling()` 尝试从 Redis `polling:live_status:${room.id}` 恢复 `roomLiveStatus`
2. Redis 无数据时默认 `false`，即 `currently_live` 初始偏保守
3. 首轮 `checkRoom()` 成功后立即刷新内存 Map 和 Redis
4. `getPollingSnapshot()` 只读内存，绝不在 Dashboard 请求路径里逐房间查 Redis

```javascript
// 内存快照：roomLiveStatus 是 Map<roomId, boolean>
getPollingSnapshot() {
  let currentlyLive = 0;
  const platformBreakdown = {};

  for (const [roomId, meta] of this.roomPollingMeta) {
    const platform = meta.platform || 'unknown';
    if (!platformBreakdown[platform]) {
      platformBreakdown[platform] = { total: 0, live: 0 };
    }
    platformBreakdown[platform].total++;

    const isLive = this.roomLiveStatus.get(roomId) ?? false;
    if (isLive) {
      currentlyLive++;
      platformBreakdown[platform].live++;
    }
  }

  return {
    total_polled: this.roomPollingMeta.size,
    total_rooms: this._totalRooms ?? this.roomPollingMeta.size,
    currently_live: currentlyLive,
    platform_breakdown: platformBreakdown,
  };
}
```

### 1.3 统计摘要

**数据来源**：PostgreSQL 聚合查询。

**时区处理**：不使用 `CURRENT_DATE`（依赖数据库服务器时区），改为由应用传入当天零点的时间戳：

```javascript
// 使用 dayjs 获取当天零点（应用服务器时区）
const todayStart = dayjs().startOf('day').toISOString();
```

```sql
-- 合并查询：今日录制统计
SELECT
  COUNT(*) FILTER (WHERE status = 'completed') AS sessions_today,
  COALESCE(SUM(total_size) FILTER (WHERE status = 'completed'), 0) AS sessions_today_total_size,
  COUNT(*) FILTER (WHERE status = 'interrupted') AS interrupted_today
FROM recording_sessions
WHERE ended_at >= $1;  -- $1 = todayStart

-- 今日投稿统计
SELECT
  COUNT(*) FILTER (WHERE status = 'success') AS uploads_today,
  COUNT(*) FILTER (WHERE status = 'failed') AS uploads_failed_today
FROM upload_records
WHERE created_at >= $1;

-- 孤文件数
SELECT COUNT(*) AS orphaned_files
FROM recording_files
WHERE status = 'orphaned';
```

推荐在 `DataService` 中新增 `getDashboardSummary(todayStart)` 方法封装这些查询。3 条查询可并行执行（`Promise.all`）。

### 1.4 近期活动

**数据来源**：从多个表中取活动记录，使用 `UNION ALL` 合并后全局排序截取。

```sql
SELECT * FROM (
  SELECT 'session_completed' AS type,
         room_name AS title,
         COALESCE(total_segments::text, '0') || ' 个分段, ' ||
           pg_size_pretty(COALESCE(total_size, 0)::bigint) AS detail,
         ended_at AS timestamp,
         '/sessions' AS link
  FROM recording_sessions
  WHERE status = 'completed' AND ended_at IS NOT NULL

  UNION ALL

  SELECT 'session_interrupted' AS type,
         room_name AS title,
         COALESCE(total_segments::text, '0') || ' 个分段' AS detail,
         ended_at AS timestamp,
         '/sessions' AS link
  FROM recording_sessions
  WHERE status = 'interrupted' AND ended_at IS NOT NULL

  UNION ALL

  SELECT CASE WHEN status = 'success' THEN 'upload_success'
              ELSE 'upload_failed' END AS type,
         title,
         COALESCE(bv_id, status) AS detail,
         completed_at AS timestamp,
         '/upload-records' AS link
  FROM upload_records
  WHERE completed_at IS NOT NULL

  UNION ALL

  SELECT CASE WHEN status = 'completed' THEN 'transcode_completed'
              ELSE 'transcode_failed' END AS type,
         REGEXP_REPLACE(original_path, '^.*/', '') AS title,
         pg_size_pretty(
           COALESCE((SELECT file_size FROM recording_files
                     WHERE file_path = t.original_path), 0)::bigint
         ) AS detail,
         completed_at AS timestamp,
         '/transcode' AS link
  FROM transcode_records t
  WHERE completed_at IS NOT NULL
) activities
ORDER BY timestamp DESC
LIMIT 10;
```

**关键改进**：

- 使用全局 `UNION ALL` + 外层 `LIMIT 10`，避免子查询各自 LIMIT 导致遗漏
- `COALESCE` 处理 NULL 值，避免字符串拼接产生 NULL
- `pg_size_pretty()` 将字节数转为可读格式（如 "1.2 GB"）
- `REGEXP_REPLACE(original_path, '^.*/', '')` 提取文件名，避免展示完整路径
- 转码记录的 `detail` 展示文件大小而非空字符串

**已确认**：`transcode_records.original_path` 已存在且有唯一约束，可与 `recording_files.file_path` 做弱关联。查询仍需 `COALESCE` 兜底，避免历史记录缺少对应文件时返回空 detail。

### 1.5 多用户/权限说明

当前系统为单用户模式，所有聚合查询不需要按用户过滤。如果未来引入多用户或房间分组，`getDashboardSummary()` 和近期活动查询应预留 `WHERE room_url IN (...)` 或 `WHERE user_id = $x` 的扩展参数。

### 1.6 消除前端冗余请求

扩展完成后，前端 Dashboard 不再需要额外请求 `/api/rooms` 获取 `total`，也不再内部调用 `/api/health`。健康状态和版本信息统一从 `appStore` 读取（Layout 组件已在 `onMounted` 中调用 `fetchHealth()`）。Dashboard 的 API 调用简化为 1 次 `/api/dashboard/status`。

---

## Phase 2：前端 UI 改造

**目标**：重新设计 Dashboard.vue 的布局，充分利用扩展后的 API 数据。

### 2.1 页面布局设计

```
┌───────────────────────────────────────────────────────────────────┐
│  仪表盘                                自动刷新: 5s  [暂停刷新]   │
├───────────────────────────────────────────────────────────────────┤
│  ┌───────────┐ ┌───────────┐ ┌───────────┐                       │
│  │ 活跃录制   │ │ 转码队列   │ │ 轮询状态   │    ← 第一排：实时状态  │
│  │   2 / 3   │ │  1 等待    │ │ 8 轮询中   │                       │
│  │  线程池    │ │ 2处理/并发3│ │ 3 直播中   │                       │
│  └───────────┘ └───────────┘ └───────────┘                       │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐                       │
│  │ 弹幕状态   │ │ 今日录制   │ │ 今日投稿   │    ← 第二排：辅助统计  │
│  │ 采集 2     │ │  12 次    │ │  5 成功    │                       │
│  │ 压制 0/1   │ │ 45.2 GB   │ │  1 失败    │                       │
│  │           │ │ ⚠ 中断 2   │ │           │                       │
│  └───────────┘ └───────────┘ └───────────┘                       │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─ 活跃录制进程 ────────────────────────────────────────────┐    │
│  │ (表格，与现有相同，保留 PID、时长、引擎等列)                 │    │
│  │ 无录制时显示"暂无活跃录制"的友好空状态                      │    │
│  └───────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ┌─ 近期活动 ────────────────────────────────────────────────┐    │
│  │ 🟢 14:32  KSG小屿 录制完成    3 个分段, 1.2 GB            │    │
│  │ 🔵 14:28  转码完成            xxx_20260610.ts  856 MB     │    │
│  │ 🟠 13:55  投稿成功            BV1xxxxxx                   │    │
│  │ 🔴 13:10  录制中断            某房间 - 2 个分段            │    │
│  │ ...                                                       │    │
│  └───────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ┌─ 系统状态 ────────────────────────────────────────────────┐    │
│  │ DB: ● 正常    Redis: ● 正常    孤文件: 2 (⚠)              │    │
│  └───────────────────────────────────────────────────────────┘    │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 2.2 统计卡片改造

从现有 4 个卡片改为 6 个，采用 **3+3 等宽网格**（`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`），视觉更平衡：

**第一排（核心实时状态）**：

| 卡片     | 主数字                   | 副文字              | 数据来源                              |
| -------- | ------------------------ | ------------------- | ------------------------------------- |
| 活跃录制 | `active_count`           | 线程池 x/y          | `data.active_count`, `data.pool_size` |
| 转码队列 | `transcode.queue_length` | 处理中 x / 并发 y   | `data.transcode`                      |
| 轮询状态 | `polling.total_polled`   | 直播中 x / 已配置 y | `data.polling`                        |

**第二排（辅助统计）**：

| 卡片     | 主数字                    | 副文字                       | 数据来源       |
| -------- | ------------------------- | ---------------------------- | -------------- |
| 弹幕状态 | `danmaku.active_captures` | 采集 x / 压制等待 y 处理中 z | `data.danmaku` |
| 今日录制 | `summary.sessions_today`  | x GB / ⚠ 中断 y              | `data.summary` |
| 今日投稿 | `summary.uploads_today`   | 失败 x                       | `data.summary` |

**弹幕卡片语义说明**：主数字展示"采集"会话数（实时状态），副文字中"压制"指压制队列（后处理状态），二者用"采集"/"压制"标签明确区分，避免用户混淆。

**今日录制卡片的中断提示**：`interrupted_today > 0` 时显示 `⚠ 中断 x`，使用黄色/红色强调，作为关键运维信号。为 0 时不显示此行。

卡片样式沿用现有渐变背景 + 白色文字的设计语言。配色方案：

| 卡片     | 渐变                                      |
| -------- | ----------------------------------------- |
| 活跃录制 | `from-blue-500 to-blue-600`（保留现有）   |
| 转码队列 | `from-amber-500 to-amber-600`（保留现有） |
| 轮询状态 | `from-indigo-500 to-indigo-600`           |
| 弹幕状态 | `from-cyan-500 to-cyan-600`               |
| 今日录制 | `from-teal-500 to-teal-600`               |
| 今日投稿 | `from-rose-500 to-rose-600`               |

### 2.3 近期活动区

新增组件 `ActivityTimeline.vue`，展示时间线式的活动流：

- 每条活动左侧用彩色圆点标识类型：
  - `session_completed` → 绿色 `bg-green-500`
  - `session_interrupted` → 红色 `bg-red-500`
  - `transcode_completed` → 蓝色 `bg-blue-500`
  - `transcode_failed` → 红色 `bg-red-500`
  - `upload_success` → 橙色 `bg-orange-500`
  - `upload_failed` → 红色 `bg-red-500`
- 显示相对时间（如"3 分钟前"），使用自定义 `formatRelativeTime()` 函数
- `title` 加粗，`detail` 用灰色小字
- `link` 非空时使用 `<router-link :to="activity.link">` 包裹整行，`link` 为 null 时渲染为 `<div>` 纯文本
- 移动端：router-link 渲染为 `<a>` 标签，浏览器原生触摸反馈；添加 `active:bg-gray-100` 触摸态
- 最多显示 10 条，无需分页

**列表更新动画**：使用 Vue `<TransitionGroup>` 包裹活动列表项，添加 `slide-fade` 过渡效果，避免 5 秒刷新时列表突兀变化：

```html
<TransitionGroup name="activity-list" tag="div">
  <div v-for="item in activities" :key="item.type + item.timestamp" ...>...</div>
</TransitionGroup>
```

```css
.activity-list-enter-active,
.activity-list-move {
  transition: all 0.3s ease;
}
.activity-list-enter-from {
  opacity: 0;
  transform: translateY(-10px);
}
.activity-list-leave-active {
  position: absolute;
}
```

### 2.4 系统状态区

替代现有的 Dashboard 底部健康指示，改为简洁的状态行：

- DB 状态 / Redis 状态：从 `appStore` 全局健康状态派生（`/api/health` 已返回 `db` 和 `redis` 字段）。注意：当前 `appStore` 只存了 `isHealthy` 聚合值，需要扩展 store 的 `fetchHealth()` 保存 `db` 和 `redis` 的独立状态
- 孤文件数：`summary.orphaned_files`，大于 0 时用黄色 `text-amber-600` 警告色
- 版本信息（应用版本、Docker 镜像版本）**不在此处展示**，由全局 Layout footer 统一管理

### 2.5 空状态优化

活跃录制表格在无数据时，使用更友好的空状态：

- 居中图标 + "暂无活跃录制"
- 轮询状态摘要（如"8 个房间正在监控中，3 个主播在线"），引导用户关注监控能力而非空白表格
- 将用户的注意力通过布局引导到下方的近期活动区

### 2.6 错误与加载状态

每个区块需要定义数据缺失时的降级表现：

**统计卡片**：

- 加载中：使用骨架屏（灰色占位块 + `animate-pulse`），保持卡片布局不变
- 数据缺失（如 `summary` 为 `undefined`，后端未部署时）：主数字显示 `--`，副文字不显示，卡片不隐藏

**近期活动区**：

- 加载中：显示 3 行骨架屏条目
- 空数组：显示"暂无近期活动"居中提示
- 加载失败：显示"加载失败"+ 手动重试按钮

**系统状态区**：

- appStore 健康数据未就绪时：所有状态点显示灰色 `bg-gray-400` + "检查中"

**向后兼容降级**：前端使用 `??` 提供默认值，确保在后端未部署新版本时页面不崩溃：

```typescript
const polling = dashboard.value?.polling ?? {
  total_polled: 0,
  total_rooms: roomTotal.value,
  currently_live: 0,
  platform_breakdown: {},
};
const summary = dashboard.value?.summary ?? {
  sessions_today: 0,
  sessions_today_total_size: 0,
  interrupted_today: 0,
  uploads_today: 0,
  uploads_failed_today: 0,
  orphaned_files: 0,
};
const recentActivity = dashboard.value?.recent_activity ?? [];
```

---

## Phase 3：代码组织优化

### 3.1 DataService 封装

在 `DataService.js` 中新增两个方法，封装所有聚合查询，避免在 router 中直接写 SQL：

- `getDashboardSummary(todayStart)` — 返回统计摘要
- `getRecentActivity()` — 返回近期活动列表

### 3.2 前端 API 请求简化

改造后 Dashboard 只需要一次 API 调用：

```typescript
// 改造前：3 个并发请求
const [statusRes, roomsRes, healthRaw] = await Promise.all([
  apiGet('/api/dashboard/status'),
  apiGet('/api/rooms'),
  fetch('/api/health').then((r) => r.json()),
]);

// 改造后：1 个请求 + store 已有的 health 状态
const statusRes = await apiGet<DashboardStatus>('/api/dashboard/status');
// 健康状态、版本信息从 appStore 读取（Layout 已经在全局调用 fetchHealth）
```

### 3.3 TypeScript 类型更新

扩展 `types/api.ts` 中的 `DashboardStatus` 接口：

```typescript
export interface DashboardStatus {
  active_recordings: ActiveRecording[];
  active_count: number;
  pool_size: number;
  transcode: { queue_length: number; processing: number; concurrency: number };
  // 新增
  danmaku: {
    active_captures: number;
    burn_queue: { queue_length: number; processing: number; concurrency: number };
  };
  polling: {
    total_polled: number;
    total_rooms: number;
    currently_live: number;
    platform_breakdown: Record<string, { total: number; live: number }>;
  };
  summary: {
    sessions_today: number;
    sessions_today_total_size: number;
    interrupted_today: number;
    uploads_today: number;
    uploads_failed_today: number;
    orphaned_files: number;
  };
  recent_activity: ActivityItem[];
}

export interface ActivityItem {
  type:
    | 'session_completed'
    | 'session_interrupted'
    | 'upload_success'
    | 'upload_failed'
    | 'transcode_completed'
    | 'transcode_failed';
  title: string;
  detail: string;
  timestamp: string;
  link: string | null;
}
```

### 3.4 appStore 扩展

当前 `appStore.fetchHealth()` 只保存了 `isHealthy` 聚合值。Dashboard 系统状态区需要 DB 和 Redis 的独立状态，需扩展 store：

```typescript
// stores/app.ts 新增
const dbHealthy = ref(true);
const redisHealthy = ref(true);

async function fetchHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    appVersion.value = data.version ?? '';
    dockerImageVersion.value = data.docker_image_version ?? '';
    serverStartTime.value = data.server_start_time ?? '';
    dbHealthy.value = data.db === true;
    redisHealthy.value = data.redis === true;
    isHealthy.value = data.ok === true;
  } catch {
    isHealthy.value = false;
    dbHealthy.value = false;
    redisHealthy.value = false;
  }
}
```

### 3.5 实施检查清单

- [ ] `PollingManager` 增加 `roomPollingMeta` 和 `getPollingSnapshot()`，并覆盖 start/stop/reload/restart 场景
- [ ] `DataService` 增加 `getDashboardSummary(todayStart)` 和 `getRecentActivity(limit = 10)`
- [ ] `/api/dashboard/status` 聚合弹幕、轮询、统计摘要和近期活动字段，保持旧字段不变
- [ ] `frontend/src/types/api.ts` 扩展 Dashboard 相关类型
- [ ] `frontend/src/stores/app.ts` 保存 DB / Redis 独立健康状态
- [ ] `frontend/src/views/Dashboard.vue` 移除 `/api/rooms` 和内部 `/api/health` 请求
- [ ] 新增 `ActivityTimeline.vue`，并完成空状态、错误态和移动端展示
- [ ] 更新 `docs/API.md` 的 Dashboard 接口响应示例
- [ ] 必要时更新 `docs/ARCHITECTURE.md` 的 Dashboard / PollingManager 状态说明
- [ ] 完成 lint、后端测试、前端 type-check/build

---

## 实施顺序与依赖

```
Phase 1（后端）──→ Phase 2（前端）──→ Phase 3（整理）
     │                  │                  │
     │  可独立部署测试   │  依赖 Phase 1    │  与 Phase 2 合并
     │  前端兼容旧格式   │  可独立上线      │  或紧随上线
```

Phase 1 后端扩展是向后兼容的（只新增字段，不修改/删除现有字段），可以先上线后端，前端在下次部署时跟进。

### 预估工作量

以下时间为**纯开发时间**，不含联调、测试和 code review。实际含测试的交付时间建议按 1.5~2 倍估算。

| 阶段                        | 主要工作                                                  | 开发时间    | 含测试预估            |
| --------------------------- | --------------------------------------------------------- | ----------- | --------------------- |
| Phase 1.1 弹幕状态          | 引入 danmakuRecorder / danmakuBurnQueue，聚合数据         | 15 min      | 30 min                |
| Phase 1.2 轮询概览          | PollingManager `roomPollingMeta` + `getPollingSnapshot()` | 1 h         | 1.5 h                 |
| Phase 1.3 统计摘要          | DataService 新增方法，聚合 SQL + 时区处理                 | 30 min      | 45 min                |
| Phase 1.4 近期活动          | UNION ALL 查询，NULL 处理，路径/文件名提取                | 40 min      | 1 h                   |
| Phase 2.1-2.2 统计卡片      | 6 个卡片 + 3+3 网格布局 + 中断数展示                      | 40 min      | 1 h                   |
| Phase 2.3 近期活动区        | ActivityTimeline 组件 + TransitionGroup 动画              | 40 min      | 1 h                   |
| Phase 2.4 系统状态区        | 状态行 + appStore 扩展                                    | 20 min      | 30 min                |
| Phase 2.5-2.6 空状态/错误态 | 骨架屏 + 降级展示 + 向后兼容                              | 30 min      | 45 min                |
| Phase 3 代码整理            | DataService 封装、类型更新、请求简化                      | 20 min      | 30 min                |
| **合计**                    |                                                           | **~4.75 h** | **~7.5 h（约 1 天）** |

---

## 测试要点

### 后端测试

| 测试场景                         | 预期结果                                                       | 验证方式                      |
| -------------------------------- | -------------------------------------------------------------- | ----------------------------- |
| 轮询房间数为 0                   | `polling.total_polled = 0`，`platform_breakdown` 为空对象      | 停止所有轮询后请求            |
| 所有房间均未开播                 | `polling.currently_live = 0`                                   | 正常场景                      |
| 今日无录制/投稿                  | `summary.sessions_today = 0`，`uploads_today = 0`              | 正常场景                      |
| `total_segments` 为 NULL         | 近期活动 `detail` 显示 "0 个分段" 而非 null                    | 构造脏数据验证                |
| `original_path` 无法关联文件大小 | 转码活动 `detail` 显示状态文字而非空串                         | 删除 recording_files 对应记录 |
| DB 时区与应用不一致              | 使用应用传入的 `todayStart`，统计结果不受 DB 时区影响          | 修改 DB timezone 参数         |
| Redis 连接异常                   | 轮询快照使用内存 Map，不受 Redis 影响                          | 停止 Redis 后请求             |
| `getActiveStats()` 返回数组/对象 | 两种格式均正确处理 `active_captures`                           | mock 不同返回值               |
| `startRoomPolling()` 后          | `roomPollingMeta` 记录 roomId/platform，Dashboard 平台统计正确 | 单元测试或集成测试            |
| `stopRoomPolling()` 后           | `total_polled` 下降，平台 total 同步下降                       | 单元测试或集成测试            |
| `reloadRoom()` 关闭轮询          | `roomPollingMeta` 清理对应房间                                 | 单元测试或集成测试            |

### 前端测试

| 测试场景                                 | 预期结果                                   |
| ---------------------------------------- | ------------------------------------------ |
| 后端未部署新版（`summary` 为 undefined） | 卡片显示 `--`，不报错                      |
| `recent_activity` 为空数组               | 显示"暂无近期活动"                         |
| 所有卡片数据正常                         | 6 个卡片均显示正确数字和副文字             |
| `interrupted_today = 0`                  | 今日录制卡片不显示中断提示                 |
| `interrupted_today > 0`                  | 今日录制卡片显示 `⚠ 中断 x`，黄色/红色高亮 |
| `orphaned_files = 0`                     | 系统状态区孤文件不显示或灰色               |
| `orphaned_files > 0`                     | 孤文件数用黄色警告色                       |
| `link` 为 null 的活动条目                | 渲染为纯文本，不可点击                     |
| `link` 为路径字符串                      | 渲染为 router-link，可跳转                 |
| 5 秒自动刷新                             | 新增活动有 slide-fade 过渡动画，无闪烁     |
| 移动端访问                               | 3+3 网格降级为单列，触摸反馈正常           |

---

## 风险与注意事项

1. **PollingManager 元数据同步**：`timers` value 只有 timer 引用，必须新增 `roomPollingMeta`。重点检查 `startRoomPolling()` 覆盖重启已有 timer 的场景，避免重复计数或残留旧平台。
2. **Redis live_status 恢复语义**：Redis key 格式已确认为 `polling:live_status:${room.id}`。Redis 无数据时 Dashboard 会保守显示未开播，直到首轮检查完成；这是可接受降级。
3. **近期活动查询性能**：UNION ALL 4 张表的查询在数据量不大时没有问题。如果 `recording_sessions` 超过 10 万行，确保 `ended_at` 和 `status` 上有复合索引。`transcode_records` 和 `upload_records` 的 `completed_at` 同理。
4. **自动刷新间隔**：改造后单次请求的后端计算量增大（多次 DB 查询）。如果 DB 负载敏感，可将刷新间隔从 5 秒调整为 10 秒。建议在 Phase 1 完成后实测接口响应时间，如果 P95 > 500ms 则调整。
5. **pg_size_pretty 依赖**：近期活动 SQL 使用了 PostgreSQL 的 `pg_size_pretty()` 函数，需要确认当前 PG 版本支持（PostgreSQL 8.2+，基本无兼容问题）。
6. **appStore 扩展影响**：`fetchHealth()` 新增 `dbHealthy` / `redisHealthy` 是纯新增字段，不影响现有消费 `isHealthy` 的组件。但需确保 Layout footer 中不新增对这些字段的引用，避免与 Dashboard 系统状态区重复。
