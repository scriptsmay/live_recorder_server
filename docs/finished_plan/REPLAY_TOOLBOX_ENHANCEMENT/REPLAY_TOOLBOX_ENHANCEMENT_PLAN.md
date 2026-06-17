# 回放工具箱补全 — 开发方案 v2

> 日期：2026-06-17
> 状态：已完成
> 修订：纳入代码审查意见（时区防御、ids 判空、确认框 UX）

> 完成日期：2026-06-17

## 完成记录

- `ReplayService` 支持 `principal_name` 读写，并在主播列表中优先展示自定义名称。
- `KuaishouReplayClient.syncReplays()` 在同步开始时读取主播设置，按 `Asia/Shanghai` 生成 `{principal_name}_{YYYY-MM-DD_HH_mm_SS}` 文件名。
- 新增 `GET /api/replay/records/:id/upload-preview`，返回模板渲染后的标题、标签、简介预览。
- 回放记录页在执行 `upload` / `all` 前展示投稿预览，确认框支持多行展示。
- 已补充 Jest 覆盖 `principal_name` 设置、文件名时区格式和投稿预览。
- 修复迁移版 m3u8 浏览器提取器与 wuyan-replay 原实现的差异：补回播放器清晰度 UI 切换兜底，并修正 `selectBestStreamFromV3()` 返回 URL 字符串但调用方按对象读取导致的提取失败。
- 回放队列任务接入 `logs/replay_{recordId}.log` 持久化日志，extract/download/cut/fix 阶段的诊断和子进程输出可在日志页查看。
- 回放投稿变量动态解析显示名：优先使用回放配置 `principal_name`，其次使用快手直播间 `room_name`，并让 `{room_name}` 与 `{principal_name}` 同值，便于和直播录制共用投稿模板。

---

## 原项目 `wuyan-replay` 文件名格式确认

通过代码考古确认，原项目的文件名生成逻辑为：

```js
// wuyan-replay/lib/video.js:865
const videoFileName = `${displayName || principalId}_${timeStr}.mp4`;

// wuyan-replay/lib/config.js:281 — formatTimestamp
function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}_${pad(date.getMinutes())}_${pad(date.getSeconds())}`;
}

// 实际效果：主播名_2026-06-17_19_30_05.mp4
```

原项目投稿标题格式：

```js
// wuyan-replay/lib/biliup.js:68
function generateTitle(videoFileName, principalName) {
  const name = principalName || '直播回放';
  const match = videoFileName.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})/);
  if (match) {
    const [, year, month, day, hour] = match;
    const hourNum = parseInt(hour, 10);
    return `【${name}·直播回放】${year}${month}${day} ${hourNum}点 | 存档`;
  }
  return `【${name}·直播回放】${videoFileName} | 存档`;
}

// 实际效果：【主播名·直播回放】20260617 19点 | 存档
```

---

## 需求 1：`replay_settings` 新增 `principal_name` 字段

**目标**：允许为每个 `principal_id` 自定义主播显示名称。

**设计决策**：`principal_name` 作为 `replay_settings` 表的 key-value 条目存储，无需 DDL 变更。

### 改动清单

| # | 层级 | 文件 | 改动 |
|---|------|------|------|
| 1 | 后端 | `services/ReplayService.js` | `updateSettings()` allowed 新增 `'principal_name'`；`getSettings()` defaults 新增 `principal_name: ''`；`getPrincipals()` 批量读 settings 并判空兜底 |
| 2 | 后端 | `lib/core/replay/KuaishouReplayClient.js` | `syncReplays()` 开头读一次 `settings`（循环外），用 `displayName` 写入 `replay_records` |
| 3 | 前端类型 | `frontend/src/types/api.ts` | `ReplaySettings` 接口新增 `principal_name?: string` |
| 4 | 前端页面 | `frontend/src/views/replay-toolbox/SettingsPage.vue` | 表单新增「主播名称」输入框 |
| 5 | 前端组件 | `frontend/src/components/replay/PrincipalCard.vue` | 显示名优先使用 `principal_name` |

### 关键代码片段

**ReplayService.js — getPrincipals()（含 ids 判空兜底）**

```js
async getPrincipals() {
  const result = await pool.query('SELECT * FROM replay_principals ORDER BY created_at DESC');
  const principals = result.rows;

  // ✅ 审查意见 1.1：ids 判空兜底
  const ids = principals.map(p => p.principal_id);
  if (!ids.length) return []; // 无主播时直接返回空数组，避免 ANY('{}') 报错

  const nameResult = await pool.query(
    `SELECT principal_id, value FROM replay_settings WHERE key = 'principal_name' AND principal_id = ANY($1)`,
    [ids]
  );
  const nameMap = new Map(nameResult.rows.map(r => [r.principal_id, r.value]));

  return principals.map(p => ({
    ...p,
    principal_name: nameMap.get(p.principal_id) || p.room_name || p.principal_id,
  }));
}
```

**KuaishouReplayClient.js — syncReplays()（settings 读取提到循环外）**

```js
async function syncReplays(principalId, count = 12, principalName) {
  // ✅ 审查意见 1.2：settings 读取提到函数开头，循环外只查一次
  const settings = await ReplayService.getSettings(principalId);
  const displayName = settings.principal_name || principalName || principalId;

  const cookies = await getKuaishouCookies();
  const result = await fetchLiveList(principalId, cookies, Math.min(count, 50));
  if (result.error) throw new Error(`获取回放列表失败: ${result.error}`);

  const items = result.data.list || [];
  let created = 0, updated = 0;

  for (const item of items) {
    const replayId = item.id || item.photoId || '';
    if (!replayId) continue;

    const existing = await ReplayService.getRecordByReplayId(principalId, replayId);
    const recordData = {
      principal_id: principalId,
      principal_name: displayName,  // ✅ 使用 settings 中的自定义名称
      replay_id: replayId,
      play_url: item.playUrl || `https://live.kuaishou.com/playback/${replayId}`,
      video_file_name: item.createTime
        ? `${displayName}_${formatTimestamp(item.createTime)}`
        : `${displayName}_${replayId}`,
      status: 'pending',
      start_time: item.createTime ? new Date(item.createTime) : null,
      duration: item.duration || 0,
    };

    if (existing) { updated++; }
    else { created++; }
    await ReplayService.upsertRecord(recordData);
  }
  return { created, updated, records: items };
}
```

---

## 需求 2：`video_file_name` 与原项目对齐

**现状问题**：`video_file_name` 为 `${principalId}_${replayId}`，不可读。

**目标格式**：`{principal_name}_{YYYY-MM-DD_HH_mm_SS}`（与 wuyan-replay 完全一致）

### ⚠️ 时区处理（审查意见 2.1）

`formatTimestamp` 必须使用 **`Intl.DateTimeFormat` 硬编码 `Asia/Shanghai`**，不依赖容器时区：

```js
/**
 * 格式化时间戳为 "YYYY-MM-DD_HH_mm_SS" 格式（Asia/Shanghai 时区）
 * 与 wuyan-replay/lib/config.js:281 输出格式对齐
 * ✅ 审查意见 2.1：不依赖容器时区，强制使用 Asia/Shanghai (UTC+8)
 */
function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const p = (type) => parts.find(x => x.type === type)?.value;
  return `${p('year')}-${p('month')}-${p('day')}_${p('hour')}_${p('minute')}_${p('second')}`;
}
```

> **补充说明**：如果项目后续引入 `dayjs`，可替换为 `dayjs(timestamp).tz('Asia/Shanghai').format('YYYY-MM-DD_HH_mm_ss')`。当前零依赖方案在 Node.js 12+ 均可运行。

---

## 需求 3：投稿确认框展示模板渲染后的标题预览

### 后端新增 `getUploadPreview` 方法

```js
// ReplayUploadService.js
static async getUploadPreview(replayRecordId) {
  const recordResult = await pool.query('SELECT * FROM replay_records WHERE id = $1', [replayRecordId]);
  const record = recordResult.rows[0];
  if (!record) return { error: true, message: '回放记录不存在' };

  const settingsResult = await pool.query(
    `SELECT value FROM replay_settings WHERE principal_id = $1 AND key = 'upload_template_id'`,
    [record.principal_id]
  );
  const templateId = settingsResult.rows[0]?.value;
  if (!templateId) return { error: true, message: '未配置回放投稿模板' };

  const tmplResult = await pool.query('SELECT * FROM upload_templates WHERE id = $1', [templateId]);
  const tmpl = tmplResult.rows[0];
  if (!tmpl) return { error: true, message: '回放投稿模板不存在或已删除' };

  const vars = getReplayTemplateVars(record);
  const title = UploadService.renderTemplate(tmpl.title_template || '', vars);
  const desc  = UploadService.renderTemplate(tmpl.desc_template || '', tmplVars);
  const tags  = UploadService.renderTemplate(tmpl.tags || '', vars);

  return {
    error: false,
    preview: {
      title,
      desc: desc.length > 100 ? desc.slice(0, 100) + '...' : desc, // ✅ 审查意见 4：简介截断
      desc_full: desc,
      tags,
      template_name: tmpl.name || '',
    },
  };
}
```

### 前端确认框（审查意见 3.1 & 4）

```ts
// RecordsPage.vue — handleAction() 中 upload/all 分支
if (action === 'upload' || action === 'all') {
  try {
    const preview = await store.fetchUploadPreview(recordId);
    if (!preview) {
      const ok = await confirm('无法获取投稿预览，仍要继续？', { title: `回放 #${recordId}` });
      if (!ok) return;
    } else {
      // ✅ 审查意见 4：只展示标题 + 标签（标题最易因变量拼接出错）
      // ✅ 审查意见 3.1：用 \n\n 分段，确保前端 confirm 组件支持 pre-line
      const message = [
        `【投稿标题】`,
        `  ${preview.title}`,
        ``,
        `【标签】 ${preview.tags || '（无）'}`,
        ``,
        preview.desc_full && preview.desc_full.length > 100
          ? `【简介】${preview.desc}（完整简介见投稿模板）`
          : `【简介】${preview.desc || '（无）'}`,
        ``,
        `模板：${preview.template_name}`,
        ``,
        `确认执行 ${action}？`,
      ].join('\n');

      const ok = await confirm(message, {
        title: `回放 #${recordId} — 投稿预览`,
        // ✅ 审查意见 3.1：如 confirm 组件不支持 \n，需在其样式加 white-space: pre-line
      });
      if (!ok) return;
    }
  } catch {
    const ok = await confirm('投稿预览获取失败，仍要继续？', { title: `回放 #${recordId}` });
    if (!ok) return;
  }
}
```

> **⚠️ CSS 配套**（审查意见 3.1）：确认 `confirm` 对话框的内容容器样式包含：
> ```css
> .confirm-message { white-space: pre-line; word-break: break-all; }
> ```
> 若使用 Element Plus `ElMessageBox`，需通过 `customClass: 'whitespace-pre-line'` 实现。

---

## 开发顺序

```
需求 1 (principal_name)  ──→  需求 2 (video_file_name + 时区修复)
         │                          │
         └──────────────────────────┴──→  需求 3 (投稿预览确认框)
```

- 需求 2 依赖需求 1（`displayName` 来自 `principal_name` 设置）
- 无 DB DDL 变更（全部复用 `replay_settings` EAV 表）

---

## 测试计划

| 测试项 | 验证点 |
|--------|--------|
| `principal_name` 读写 | Settings 保存/读取正确；`ids` 为空时 `getPrincipals()` 不报错 |
| `principal_name` 联动 | 主播列表显示自定义名；`syncReplays` 只查一次 settings |
| 文件名时区 | Docker UTC 模式下 `formatTimestamp` 仍输出北京时间 |
| 文件名对齐 | 新同步记录格式为 `主播名_2026-06-17_19_30_05` |
| 投稿预览 API | `desc` 字段截断正确；`desc_full` 保留完整内容 |
| 投稿确认框 | 标题/标签展示正确；`\n` 换行在正常渲染；其他操作不受影响 |
| 已有数据兼容 | 已有记录的 `video_file_name` 不被覆盖 |

---

## 部署注意事项

| 项目 | 说明 |
|------|------|
| Docker 时区 | `formatTimestamp` 已硬编码 `Asia/Shanghai`，容器无需设置 `TZ`（双重保险） |
| `.env` 配置 | 无新增环境变量 |
| 数据库 | 无迁移脚本（复用 EAV 表） |
