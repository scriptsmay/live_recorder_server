# 弹幕压制模块独立化重构方案

## 背景与问题

当前弹幕压制功能深度耦合在录制流程中，存在以下问题：

1. **竞态条件**：`_handleDanmakuFinish` 在会话结束时立即调用 `enqueueSession`，但此时转码尚未完成，导致压制输入路径指向即将被删除的 FLV/TS 原文件。
2. **文件混淆**：弹幕压制产物（`*_danmaku.mp4`）与录制文件存放在同一目录，导致看门狗扫描、文件统计、投稿选择等环节都需要额外过滤逻辑。
3. **职责不清**：弹幕压制本质是后处理工具，不应嵌入录制核心链路。录制模块应只负责「采集」，压制应作为独立「工具箱」功能。
4. **数据库污染**：`recording_files` 表被添加了 4 个弹幕相关字段（`danmaku_ass_path`、`danmaku_burn_path`、`is_danmaku_burned`、`danmaku_burned_at`），录制和压制的数据边界模糊。

## 目标

- 关闭自动压制，移除录制流程中所有自动触发弹幕压制的代码路径
- 弹幕压制从录制流程中完全解耦，成为独立的工具箱功能
- 弹幕文件和压制产物存放在独立目录中，不与录制文件混在一起
- `recording_files` 表回归纯净，弹幕数据全部存放在独立的 `danmaku_burn_records` 表中

---

## 现有架构耦合点清单

### 录制流程中的触发点（需移除）

| 文件                          | 行号     | 当前行为                                                              | 处理方式                                  |
| ----------------------------- | -------- | --------------------------------------------------------------------- | ----------------------------------------- |
| `services/RecorderService.js` | L274     | `finishSession` 调用 `_handleDanmakuFinish`                           | 保留弹幕采集和 ASS 生成，移除自动压制入队 |
| `services/RecorderService.js` | L439-443 | `_handleDanmakuFinish` 中 `auto_burn_danmaku` 检查 + `enqueueSession` | 移除                                      |
| `lib/core/TranscodeQueue.js`  | L207     | 转码完成后调用 `triggerDanmakuBurn`                                   | 移除                                      |
| `lib/core/TranscodeQueue.js`  | L343-376 | `triggerDanmakuBurn` 方法本体                                         | 移除                                      |

### 文件扫描过滤点（目录分离后不再需要）

| 文件                      | 行号   | 当前行为                                    |
| ------------------------- | ------ | ------------------------------------------- |
| `lib/core/watchdog.js`    | L211   | `scanActiveSegments` 排除 `_danmaku.mp4`    |
| `lib/core/watchdog.js`    | L86    | `checkStaleRecordings` 排除 `_danmaku.mp4`  |
| `lib/core/watchdog.js`    | L323   | `cleanupFragmentFiles` 排除 `_danmaku.mp4`  |
| `lib/core/scan-files.js`  | L69    | `walkDir` 排除 `_danmaku.mp4`               |
| `services/RoomService.js` | L141   | `cleanupOutputFiles` 排除 `_danmaku.mp4`    |
| `config/config.js`        | L11-14 | `DANMAKU_BURN_SUFFIX` + `isDanmakuBurnFile` |

### 数据库字段（需迁移）

| 表                                  | 字段          | 处理方式                                    |
| ----------------------------------- | ------------- | ------------------------------------------- |
| `recording_files.danmaku_ass_path`  | 分段 ASS 路径 | 迁移到 `danmaku_burn_records.ass_path`      |
| `recording_files.danmaku_burn_path` | 压制输出路径  | 迁移到 `danmaku_burn_records.output_path`   |
| `recording_files.is_danmaku_burned` | 是否已压制    | 从 `danmaku_burn_records.status` 派生       |
| `recording_files.danmaku_burned_at` | 压制时间      | 从 `danmaku_burn_records.completed_at` 派生 |

### 设置项（需清理）

| Key                            | 当前默认值         | 处理方式                   |
| ------------------------------ | ------------------ | -------------------------- |
| `auto_burn_danmaku`            | `false`            | **移除**（不再自动触发）   |
| `prefer_danmaku_burned_video`  | `false`            | **移除**（从未被代码读取） |
| `danmaku_preserve_clean_video` | `true`             | **移除**（从未被代码读取） |
| `kuaishou_danmaku_enabled`     | `false`            | 保留（控制弹幕采集）       |
| `danmaku_burn_concurrency`     | `1`                | 保留                       |
| `danmaku_density_per_second`   | `20`               | 保留                       |
| `danmaku_font_family`          | `Noto Sans CJK SC` | 保留                       |
| `danmaku_font_size`            | `32`               | 保留                       |
| `danmaku_opacity`              | `0.75`             | 保留                       |

---

## 独立目录结构设计

### 当前结构（问题）

弹幕文件散落在录制会话目录中，与录制文件混在一起：

```
VIDEO_DOWNLOAD_DIR/
  └── [roomId]/
      └── [sessionId]/
          ├── KSG小屿_20260602_143907.mp4        ← 录制分段
          ├── KSG小屿_20260602_151617.mp4        ← 录制分段
          ├── KSG小屿_20260602_155327.mp4        ← 录制分段
          ├── danmaku.jsonl                       ← 弹幕原始数据
          ├── danmaku.ass                         ← 会话级 ASS
          ├── danmaku_segments/                   ← 分段 ASS
          │   ├── 123.ass
          │   ├── 124.ass
          │   └── 125.ass
          ├── KSG小屿_20260602_143907_danmaku.mp4 ← 压制产物（混在录制文件中！）
          ├── KSG小屿_20260602_151617_danmaku.mp4
          └── KSG小屿_20260602_155327_danmaku.mp4
```

### 目标结构

压制产物输出到独立目录，与录制文件完全隔离：

```
VIDEO_DOWNLOAD_DIR/
  └── [roomId]/
      └── [sessionId]/
          ├── KSG小屿_20260602_143907.mp4        ← 录制分段（纯净）
          ├── KSG小屿_20260602_151617.mp4        ← 录制分段（纯净）
          ├── KSG小屿_20260602_155327.mp4        ← 录制分段（纯净）
          └── danmaku/                            ← 弹幕数据目录
              ├── danmaku.jsonl                   ← 弹幕原始数据
              ├── danmaku.ass                     ← 会话级 ASS
              └── segments/                       ← 分段 ASS
                  ├── 123.ass
                  ├── 124.ass
                  └── 125.ass

DANMAKU_OUTPUT_DIR/                               ← 独立压制输出目录
  └── [sessionId]/
      ├── 143907_danmaku.mp4                      ← 压制产物
      ├── 151617_danmaku.mp4
      ├── 155327_danmaku.mp4
      └── logs/                                   ← ffmpeg 压制日志
          ├── 143907.log
          ├── 151617.log
          └── 155327.log
```

### 目录配置

新增环境变量和设置项：

| 变量/Key                        | 说明                   | 默认值                                    |
| ------------------------------- | ---------------------- | ----------------------------------------- |
| `DANMAKU_OUTPUT_DIR`            | 压制产物输出根目录     | `${VIDEO_DOWNLOAD_DIR}/../danmaku_output` |
| `danmaku_output_dir` (settings) | 同上（数据库配置优先） | 同上                                      |

---

## 分阶段实施计划

### Phase 1：关闭自动压制 + 移除触发路径

**目标**：切断录制流程与弹幕压制的所有自动关联。

#### 1.1 `services/RecorderService.js` — `_handleDanmakuFinish`

保留弹幕采集停止和 ASS 生成逻辑，移除自动压制入队代码：

```javascript
// 保留（L381-435）
static async _handleDanmakuFinish(sessionId, roomUrl) {
  // 停止弹幕采集 ✓
  const { captureId, eventCount } = await danmakuRecorder.stopCapture(roomUrl);
  // ...

  // 生成会话级 ASS ✓
  const assResult = await danmakuAssGenerator.generateFromJsonl({ jsonlPath, assPath });
  // ...

  // 为每个分段生成分段 ASS ✓
  const segResults = await danmakuAssGenerator.generateSegmentAss({ ... });
  // 更新 danmaku_burn_records（替代 recording_files.danmaku_ass_path）
  // ...

  // ========== 移除以下代码（L438-443）==========
  // const autoBurn = await DataService.getSetting('auto_burn_danmaku', 'false');
  // if (autoBurn === 'true') {
  //   const enqueued = await danmakuBurnQueue.enqueueSession({ ... });
  // }
  // =============================================
}
```

#### 1.2 `lib/core/TranscodeQueue.js` — 移除弹幕压制触发

```javascript
// 删除 L207 的调用
// this.triggerDanmakuBurn(mp4Path, _sessionId).catch(...);

// 删除 L343-376 整个 triggerDanmakuBurn 方法

// 删除 L7 的 import
// const danmakuBurnQueue = require('./DanmakuBurnQueue');
```

#### 1.3 `views/settings.ejs` — 移除废弃设置项

从设置表单和提交列表中移除以下三项：

- `auto_burn_danmaku`
- `prefer_danmaku_burned_video`
- `danmaku_preserve_clean_video`

#### 1.4 `db/migrate.js` — 清理废弃设置默认值

移除上述三个 key 的默认插入。

### Phase 2：独立目录结构

**目标**：弹幕数据和压制产物与录制文件物理隔离。

#### 2.1 弹幕数据目录迁移

将 `danmaku.jsonl`、`danmaku.ass`、`danmaku_segments/` 的存放位置从会话根目录改为 `会话目录/danmaku/` 子目录。

**涉及文件**：

- `services/RecorderService.js` — `_handleDanmakuFinish` 中的路径计算
- `router/danmaku.js` — ASS 重新生成、弹幕搜索中的路径
- `lib/core/danmaku/DanmakuRecorder.js` — JSONL 写入路径

**改动示例**（`_handleDanmakuFinish`）：

```javascript
// 旧
const jsonlPath = path.join(sessionDir, 'danmaku.jsonl');
const assPath = path.join(sessionDir, 'danmaku.ass');

// 新
const danmakuDir = path.join(sessionDir, 'danmaku');
if (!fs.existsSync(danmakuDir)) fs.mkdirSync(danmakuDir, { recursive: true });
const jsonlPath = path.join(danmakuDir, 'danmaku.jsonl');
const assPath = path.join(danmakuDir, 'danmaku.ass');
```

**注意**：需要兼容旧路径。如果 `会话目录/danmaku.jsonl` 存在但 `会话目录/danmaku/danmaku.jsonl` 不存在，回退到旧路径。

#### 2.2 压制输出目录

压制产物输出到独立的 `DANMAKU_OUTPUT_DIR/[sessionId]/` 目录。

**涉及文件**：

- `config/config.js` — 新增 `getDanmakuOutputDir()` 函数
- `lib/core/DanmakuBurnQueue.js` — `enqueueSession` 和 `enqueue` 中的输出路径计算
- `lib/core/danmaku-burner.js` — ffmpeg 输出路径

**新增配置函数**（`config/config.js`）：

```javascript
function getDanmakuOutputDir() {
  return envs.DANMAKU_OUTPUT_DIR
    || path.join(path.dirname(envs.VIDEO_DOWNLOAD_DIR || '.'), 'danmaku_output');
}

module.exports = { ..., getDanmakuOutputDir };
```

**`enqueueSession` 输出路径计算改动**：

```javascript
// 旧（与录制文件同目录）
const outputPath = inputPath.replace(new RegExp(`${ext}$`), '_danmaku.mp4');

// 新（独立输出目录）
const { getDanmakuOutputDir } = require('../../config/config');
const outputDir = path.join(getDanmakuOutputDir(), String(sessionId));
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
const outputFileName = `${path.basename(inputPath, ext)}_danmaku.mp4`;
const outputPath = path.join(outputDir, outputFileName);
```

#### 2.3 旧文件兼容

对于已存在的旧压制产物（`会话目录/*_danmaku.mp4`），在压制记录查询和播放时做路径兼容，不主动迁移。

### Phase 3：数据库解耦

**目标**：`recording_files` 表移除弹幕字段，所有弹幕数据集中在 `danmaku_burn_records`。

#### 3.1 `danmaku_burn_records` 表结构调整

当前表已有 `ass_path`、`output_path`、`input_path` 字段，基本满足需求。新增以下字段：

```sql
-- 会话级 ASS 路径（原存储在 danmaku_capture_records.ass_path）
ALTER TABLE danmaku_burn_records ADD COLUMN IF NOT EXISTS session_ass_path VARCHAR(1024) DEFAULT '';

-- 弹幕 JSONL 路径
ALTER TABLE danmaku_burn_records ADD COLUMN IF NOT EXISTS jsonl_path VARCHAR(1024) DEFAULT '';
```

#### 3.2 移除 `recording_files` 弹幕字段

在迁移脚本中：

```sql
-- 数据迁移：将现有数据从 recording_files 迁移到 danmaku_burn_records
-- （通过 recording_file_id 关联）

-- 移除列（在确认数据迁移完成后）
ALTER TABLE recording_files DROP COLUMN IF EXISTS danmaku_ass_path;
ALTER TABLE recording_files DROP COLUMN IF EXISTS danmaku_burn_path;
ALTER TABLE recording_files DROP COLUMN IF EXISTS is_danmaku_burned;
ALTER TABLE recording_files DROP COLUMN IF EXISTS danmaku_burned_at;
```

#### 3.3 查询适配

所有读取弹幕压制状态的查询改为 JOIN `danmaku_burn_records`：

```sql
-- 旧：直接从 recording_files 读取
SELECT danmaku_burn_path, is_danmaku_burned FROM recording_files WHERE id = $1;

-- 新：JOIN danmaku_burn_records
SELECT rf.*, dbr.output_path AS danmaku_burn_path, dbr.status AS burn_status
FROM recording_files rf
LEFT JOIN danmaku_burn_records dbr ON dbr.recording_file_id = rf.id
WHERE rf.id = $1;
```

**涉及文件**：

- `views/sessions.ejs` — 分段列表渲染（L374, L385）
- `router/danmaku.js` — 手动压制、ASS 重新生成
- `services/DataService.js` — 录制文件查询

### Phase 4：前端工具箱页面

**目标**：在现有 UI 中新增独立的「弹幕工具箱」入口。

#### 4.1 新增页面

在 `views/` 下新增 `danmaku-toolbox.ejs`，包含：

- **会话列表**：展示有弹幕数据的会话（`danmaku_capture_records` 中有记录）
- **批量压制**：选择会话 → 选择分段 → 一键加入压制队列
- **压制状态**：实时展示压制队列状态（排队中 / 处理中 / 已完成 / 失败）
- **产物管理**：查看、播放、下载、删除压制产物

#### 4.2 新增路由

```javascript
// router/html.js 中新增
router.get('/danmaku-toolbox', async (req, res) => {
  res.render('danmaku-toolbox', { ... });
});
```

#### 4.3 移除会话详情页中的内联压制按钮

`sessions.ejs` 中现有的弹幕相关 UI（如 `▶弹幕` 播放按钮和手动压制按钮）改为跳转到工具箱页面，或保留为只读状态展示。

### Phase 5：清理遗留代码

**目标**：移除不再需要的过滤逻辑和废弃引用。

#### 5.1 文件扫描过滤点（可保留为安全网）

以下过滤逻辑在目录分离后理论上不再触发，但建议保留作为安全防护：

- `config/config.js` — `isDanmakuBurnFile()` 保留
- `lib/core/watchdog.js` — 保留 `_danmaku.mp4` 过滤
- `lib/core/scan-files.js` — 保留过滤
- `services/RoomService.js` — 保留过滤

#### 5.2 移除废弃引用

- `lib/core/DanmakuBurnQueue.js` — 移除 `SUPPORTED_TRANSCODE_EXT` import（不再需要转码判断）
- `services/RecorderService.js` — 移除 `danmakuBurnQueue` require（如果 `_handleDanmakuFinish` 不再引用）

---

## 实施优先级与依赖关系

```
Phase 1（关闭自动压制）
  │
  ├── 无前置依赖，可立即执行
  ├── 影响最小：仅移除自动触发代码
  └── 产出：录制流程不再自动触发弹幕压制
  │
Phase 2（独立目录结构）
  │
  ├── 依赖 Phase 1（自动压制关闭后改动路径更安全）
  ├── 需要处理旧路径兼容
  └── 产出：弹幕文件和压制产物与录制文件物理隔离
  │
Phase 3（数据库解耦）
  │
  ├── 依赖 Phase 2（目录结构稳定后再迁移数据）
  ├── 需要数据迁移脚本
  ├── 需要更新所有查询弹幕状态的代码
  └── 产出：recording_files 表回归纯净
  │
Phase 4（前端工具箱）
  │
  ├── 依赖 Phase 3（数据库结构稳定后再开发 UI）
  ├── 独立的前端开发工作
  └── 产出：用户可手动管理弹幕压制
  │
Phase 5（清理遗留）
  │
  ├── 依赖 Phase 1-4 全部完成
  └── 产出：代码库整洁
```

## 风险评估

| 风险               | 影响                   | 缓解措施                                       |
| ------------------ | ---------------------- | ---------------------------------------------- |
| 旧压制产物路径失效 | 历史数据无法播放       | Phase 2 中做路径兼容，查询时 fallback 到旧路径 |
| 数据迁移丢失关联   | 压制记录与录制文件脱钩 | Phase 3 先迁移数据再删列，保留回滚能力         |
| 前端功能回归       | 用户操作入口变化       | Phase 4 提供完整工具箱替代，保留会话页只读展示 |
| ASS 生成路径变更   | 旧会话无法重新生成 ASS | `DanmakuAssGenerator` 兼容旧路径               |

## 测试策略

每个 Phase 完成后运行完整测试套件（`npx jest --no-coverage`），确保 267 个现有测试全部通过。

重点关注的测试文件：

- `test/danmaku-burn-queue.test.js` — 压制队列核心逻辑
- `test/danmaku-burner.test.js` — ffmpeg 压制逻辑
- `test/danmaku-ass-generator.test.js` — ASS 生成逻辑
- `test/danmaku-recorder.test.js` — 弹幕采集逻辑
- `test/api-coverage.test.js` — API 接口覆盖
