# Phase 5: 清理遗留代码

> **状态**: 待实施
> **最后更新**: 2026-06-02
> **预计工期**: 1-2 天

---

## 依赖关系

```
Phase 5 前置依赖:
✅ Phase 1 (自动压制关闭) — 必须完成
✅ Phase 2 (目录结构)   — 必须完成
✅ Phase 3 (数据库解耦) — 必须完成
✅ Phase 4 (前端工具箱) — 建议完成（清理旧入口依赖此）

Phase 5 可并行:
  Phase 4 Step 1-2 (全局搜索废弃引用、移除废弃 import) 可与 Phase 4 并行
```

---

## 1. 目标

在弹幕功能完全迁移到工具箱后，清理所有遗留代码：

- 移除录制文件列表中的弹幕操作入口
- 删除数据库中的废弃字段（推迟到发布后 1 个月）
- 清理废弃的环境变量和配置项（代码层面）
- 清理数据库中的废弃设置项（`settings` 表）
- 提供回滚方案

**保留安全网**：文件扫描逻辑（`watchdog.js`、`scan-files.js`、`RoomService.js`）保留，作为历史产物兼容层和防御性检查。

---

## 2. 清理范围

### 2.1 保留项（安全网）

| 文件             | 保留内容                   | 原因                      |
| ---------------- | -------------------------- | ------------------------- |
| `watchdog.js`    | `scanDanmakuFiles()`       | 历史产物兼容 + 防御性检查 |
| `scan-files.js`  | `scanDanmakuFiles()`       | 同上                      |
| `RoomService.js` | `checkDanmakuFiles()`      | 同上                      |
| `DataService.js` | `getDanmakuPlayUrl()`      | 兼容旧数据库记录          |
| `configs.json`   | `danmaku_output_dir`       | 历史产物路径参考          |
| 日志目录         | `DANMAKU_OUTPUT_DIR/logs/` | 保留最近 30 天日志        |

### 2.2 删除项

| 类别       | 待删除内容                              | 位置                                    |
| ---------- | --------------------------------------- | --------------------------------------- |
| 环境变量   | `AUTO_BURN_DANMAKU`                     | `configs.json` + `process.env` 读取代码 |
| 环境变量   | `DANMAKU_BURN_FONT_SIZE`                | 同上                                    |
| 环境变量   | `DANMAKU_BURN_OPACITY`                  | 同上                                    |
| 数据库字段 | `recording_files.danmaku_ass_path`      | 推迟到发布后 1 个月 DROP                |
| 数据库字段 | `recording_files.danmaku_burn_status`   | 同上                                    |
| 数据库字段 | `recording_files.danmaku_burn_queue_at` | 同上                                    |
| 数据库字段 | `recording_files.danmaku_burn_done_at`  | 同上                                    |
| 前端入口   | `sessions.ejs` 中的弹幕操作按钮         | 改为跳转链接                            |
| 前端入口   | `session-danmaku.ejs` 中的操作按钮      | 改为只读展示                            |
| 设置项     | `settings` 表中废弃的弹幕配置行         | `migrate.js` 中清理                     |

---

## 3. 实施步骤

### Step 1: 全局搜索确认（可并行）

**目标**：确认废弃配置项在代码中无硬编码引用。

```bash
# 精确搜索：仅搜索 .js 文件，排除 node_modules 和日志目录
grep -rn --include="*.js" "AUTO_BURN_DANMAKU" /path/to/project
grep -rn --include="*.js" "DANMAKU_BURN_FONT_SIZE" /path/to/project
grep -rn --include="*.js" "DANMAKU_BURN_OPACITY" /path/to/project

# 搜索 settings 表中的废弃 key
grep -rn --include="*.js" "danmaku_auto_burn" /path/to/project
grep -rn --include="*.js" "danmaku_font_size" /path/to/project
grep -rn --include="*.js" "danmaku_opacity" /path/to/project

# 搜索 database migration 中的废弃字段引用
grep -rn --include="*.js" "danmaku_ass_path" /path/to/project
grep -rn --include="*.js" "danmaku_burn_status" /path/to/project
```

> **预期结果**：除了读取 `process.env` 和数据库字段访问的代码外，无硬编码引用。

**✅ 检查点**：截图搜索结果为空，或仅有预期的读取代码。

---

### Step 2: 移除废弃环境变量读取（可并行）

**文件**: `services/ConfigService.js` 或环境变量读取处

```javascript
// REMOVE:
const AUTO_BURN_DANMAKU = process.env.AUTO_BURN_DANMAKU === 'true';
const DANMAKU_BURN_FONT_SIZE = parseInt(process.env.DANMAKU_BURN_FONT_SIZE) || 36;
const DANMAKU_BURN_OPACITY = parseFloat(process.env.DANMAKU_BURN_OPACITY) || 0.8;
```

**✅ 检查点**：`grep -rn --include="*.js" "AUTO_BURN_DANMAKU" .` 仅返回 `configs.json` 中的定义。

---

### Step 3: 清理数据库中的废弃设置项

**文件**: `migrations/migrate.js`

> 注意：此步骤清理的是 `settings` 表中用户可能保存的废弃配置项，不是数据库字段。

```javascript
// migrations/20260101_cleanup_danmaku_settings.js
async function up(db) {
  await db.run(`
    DELETE FROM settings
    WHERE key IN (
      'danmaku_auto_burn',
      'danmaku_font_size',
      'danmaku_opacity'
    )
  `);
}

async function down(db) {
  // 无 down，这些设置项已废弃
}
```

**✅ 检查点**：执行后 `SELECT * FROM settings WHERE key LIKE 'danmaku_%'` 返回空。

---

### Step 4: 清理前端旧入口

**文件**: `views/sessions.ejs`

```html
<!-- REMOVE: 文件行中的弹幕操作按钮 -->
<button onclick="generateAss('<%= file.id %>')">生成 ASS</button>
<button onclick="burnDanmaku('<%= file.id %>')">压制弹幕</button>

<!-- ADD: 跳转链接 -->
<a href="/toolbox/danmaku?roomId=<%= room.roomId %>" class="btn btn-sm"> 弹幕工具箱 → </a>
```

**文件**: `views/session-danmaku.ejs`

```html
<!-- REMOVE: 所有操作按钮 -->
<button id="generate-ass-btn">生成 ASS</button>
<button id="burn-btn">压制弹幕</button>

<!-- KEEP: 只读展示 -->
<p>ASS 文件: <a href="<%= assPath %>">下载</a></p>
<p>压制状态: <%= burnStatus %></p>
<a href="/toolbox/danmaku">← 返回工具箱</a>
```

**✅ 检查点**：访问 `/sessions` 和 `/session/:id/danmaku`，确认无操作按钮。

---

### Step 5: 保留安全网代码（不删除）

确认以下文件中的弹幕扫描逻辑**保留**：

```
watchdog.js           → scanDanmakuFiles()  ← 保留
scan-files.js         → scanDanmakuFiles()  ← 保留
RoomService.js        → checkDanmakuFiles() ← 保留
DataService.js        → getDanmakuPlayUrl() ← 保留（兼容旧数据）
```

**✅ 检查点**：这些函数仍能编译，无 `undefined` 引用。

---

### Step 6: 数据库字段 DROP（推迟执行）

> ⚠️ **此步骤推迟到 Phase 5 发布后至少 1 个月执行**，确保无回滚需求。

**回滚脚本**（提前准备）：

```sql
-- rollback_danmaku_fields.sql
-- 如需恢复字段，执行此脚本

ALTER TABLE recording_files
  ADD COLUMN danmaku_ass_path VARCHAR(1024) DEFAULT '';

ALTER TABLE recording_files
  ADD COLUMN danmaku_burn_status VARCHAR(20) DEFAULT '';

ALTER TABLE recording_files
  ADD COLUMN danmaku_burn_queue_at DATETIME DEFAULT NULL;

ALTER TABLE recording_files
  ADD COLUMN danmaku_burn_done_at DATETIME DEFAULT NULL;

-- 恢复索引
CREATE INDEX idx_danmaku_burn_status
  ON recording_files(danmaku_burn_status);
```

**执行 DROP**（1 个月后）：

```javascript
// migrations/20260201_drop_danmaku_fields.js
async function up(db) {
  await db.run(`
    ALTER TABLE recording_files
      DROP COLUMN danmaku_ass_path,
      DROP COLUMN danmaku_burn_status,
      DROP COLUMN danmaku_burn_queue_at,
      DROP COLUMN danmaku_burn_done_at
  `);
}

async function down(db) {
  // 使用上述回滚脚本
  await db.run(fs.readFileSync('rollback_danmaku_fields.sql', 'utf8'));
}
```

**✅ 检查点**：

1. 执行 DROP 前，全量备份数据库
2. 执行后，`DESCRIBE recording_files` 无弹幕字段
3. 回滚脚本独立存放，通知运维团队

---

### Step 7: 日志清理策略

`DANMAKU_OUTPUT_DIR/logs/` 目录的清理策略：

```javascript
// services/LogFileCleanupService.js (新增或加入现有清理服务)
async function cleanupDanmakuLogs(retentionDays = 30) {
  const logDir = path.join(process.env.DANMAKU_OUTPUT_DIR, 'logs');
  const files = await fs.readdir(logDir);

  for (const file of files) {
    const filePath = path.join(logDir, file);
    const stat = await fs.stat(filePath);
    const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);

    if (ageDays > retentionDays) {
      await fs.unlink(filePath);
      console.log(`[Cleanup] Removed old log: ${file}`);
    }
  }
}
```

> 建议在 Phase 5 发布时加入定期清理任务（如每日凌晨清理超过 30 天的日志）。

**✅ 检查点**：手动执行 `cleanupDanmakuLogs(30)`，确认旧日志被正确删除。

---

### Step 8: 更新文档

| 文档                                      | 更新内容                                | 具体章节                         |
| ----------------------------------------- | --------------------------------------- | -------------------------------- |
| `docs/DB.md`                              | 移除 `recording_files` 弹幕字段说明     | 「表结构 → recording_files」章节 |
| `docs/API.md`                             | 移除废弃的弹幕 API 端点                 | 「API 目录」和「弹幕相关」章节   |
| `docs/SETUP.md`                           | 移除 `AUTO_BURN_DANMAKU` 等环境变量说明 | 「环境变量配置」章节             |
| `README.md`                               | 更新功能描述（弹幕功能指向工具箱）      | 「功能特性」章节                 |
| `docs/todo/DANMAKU_BURN_DECOUPLE_PLAN.md` | 标记 Phase 5 完成                       | 顶部状态标记                     |

**✅ 检查点**：文档更新后，新开发者按 `docs/SETUP.md` 配置环境无报错。

---

## 4. 测试策略

### 4.1 功能测试

| 测试场景                           | 预期结果                       |
| ---------------------------------- | ------------------------------ |
| 访问 `/sessions`，点击弹幕相关链接 | 正确跳转到工具箱页面           |
| 访问 `/toolbox/danmaku`            | 所有功能正常（Phase 4 已测试） |
| 历史录制文件的弹幕播放             | 仍能播放（安全网保留）         |
| 新增录制文件的弹幕采集             | 正常工作（Phase 2/3 已测试）   |

### 4.2 回归测试

```bash
# 运行现有测试套件
npm test

# 重点检查以下模块无报错
# - RecordingFileService (文件列表)
# - DanmakuService (弹幕采集)
# - WatchdogService (文件扫描)
```

### 4.3 数据库迁移测试

```bash
# 测试 migrate up (清理 settings)
npm run migrate:up

# 验证 settings 表中废弃项已删除
sqlite3 data/recorder.db "SELECT * FROM settings WHERE key LIKE 'danmaku_%';"
# 预期返回空

# 测试 migrate down (如有)
npm run migrate:down
```

---

## 5. 风险评估

| 风险                       | 等级  | 缓解措施                                      |
| -------------------------- | ----- | --------------------------------------------- |
| 遗留代码引用导致运行时错误 | 🟡 中 | Step 1 全局搜索 + Step 8 回归测试             |
| 历史数据无法访问           | 🟢 低 | 安全网保留（`watchdog.js` 等不删除）          |
| 用户找不到弹幕功能入口     | 🟡 中 | `sessions.ejs` 保留明显的跳转链接             |
| 数据库 DROP 后无法回滚     | 🔴 高 | 推迟 1 个月执行 + 提前准备回滚脚本 + 全量备份 |
| 日志目录占用磁盘空间       | 🟢 低 | Step 7 加入定期清理任务                       |

---

## 6. 完成标准

- [ ] `AUTO_BURN_DANMAKU` 等三个环境变量从 `configs.json` 和代码中移除
- [ ] `settings` 表中废弃的弹幕配置项已通过 migration 清理
- [ ] `sessions.ejs` 弹幕操作按钮移除，跳转链接正常工作
- [ ] `session-danmaku.ejs` 改为只读展示，无操作按钮
- [ ] 文件扫描逻辑（`watchdog.js` 等）保留，编译无报错
- [ ] 数据库字段 DROP 的 migration 已编写（但推迟执行）
- [ ] 回滚脚本 (`rollback_danmaku_fields.sql`) 已准备并归档
- [ ] 日志清理策略已实施（`cleanupDanmakuLogs`）
- [ ] `docs/DB.md`、`docs/API.md`、`docs/SETUP.md`、`README.md` 已更新
- [ ] 全量回归测试通过（重点：`sessions.ejs` 加载无报错）
- [ ] 功能测试通过（历史弹幕可播放、工具箱功能正常）
- [ ] 代码已合并到 `main`，部署到测试环境验证

---

## 7. 发布后检查清单（Phase 5 发布 1 个月后）

> 此清单在 Phase 5 发布后 1 个月执行，确认无回滚需求后执行数据库 DROP。

- [ ] 收集 1 个月的错误日志，确认无弹幕字段相关报错
- [ ] 用户反馈确认无功能缺失
- [ ] 数据库全量备份（执行 DROP 前）
- [ ] 执行 `migrations/20260201_drop_danmaku_fields.js`
- [ ] 执行回滚脚本验证（在备份库上验证）
- [ ] 更新 `docs/DB.md`，移除弹幕字段说明
- [ ] 通知运维团队：弹幕字段已清理，后续无需兼容
