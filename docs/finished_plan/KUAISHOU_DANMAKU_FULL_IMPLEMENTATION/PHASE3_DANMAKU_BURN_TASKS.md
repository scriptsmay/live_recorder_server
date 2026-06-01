# 阶段 3：弹幕压制队列

> 基于 KUAISHOU_DANMAKU_RECORDING_PLAN.md 阶段 3 需求
>
> 将 ASS 弹幕字幕压制到视频文件，输出 `*_danmaku.mp4`

## 架构

```
┌─────────────┐     enqueueSession      ┌────────────────────┐     burn()     ┌──────────────────┐
│  Recorder   │ ──────────────────────→ │ DanmakuBurnQueue   │ ────────────→ │  danmaku-burner  │
│  Service    │   (auto/manual)         │  (Redis LIST)       │               │  (FFmpeg spawn)  │
└─────────────┘                         │  concurrency=1      │               │  subtitles       │
                                        │  DB: burn_records   │               │  libx264/QSV     │
                                        └────────────────────┘               └──────────────────┘
```

## 任务清单

| ID      | 任务                                                 |   状态    |
| ------- | ---------------------------------------------------- | :-------: |
| T3-BE-1 | `lib/core/danmaku-burner.js` — FFmpeg 压制器         | ✅ 已完成 |
| T3-BE-2 | `lib/core/DanmakuBurnQueue.js` — Redis 队列          | ✅ 已完成 |
| T3-BE-3 | `POST /api/sessions/:id/danmaku/burn` — 手动压制 API | ✅ 已完成 |
| T3-BE-4 | `GET/DELETE /api/danmaku_burn_records` — 查询/删除   | ✅ 已完成 |
| T3-BE-5 | `RecorderService.js` — auto_burn_danmaku 集成        | ✅ 已完成 |
| T3-BE-6 | `db/migrate.js` — danmaku_burn_records + 扩展字段    | ✅ 已完成 |
| T3-BE-7 | `sessions.ejs` — 压制按钮 + 文件列表压制状态         | ✅ 已完成 |
| T3-8    | `DataService.getSessions()` LEFT JOIN 压制记录       | ✅ 已完成 |
| T3-9    | `sessions.ejs` 会话卡片压制汇总状态                  | ✅ 已完成 |
| T3-10   | 单元测试 — danmaku-burner                            | ✅ 已完成 |
| T3-11   | 单元测试 — DanmakuBurnQueue                          | ✅ 已完成 |

## 阶段 3 全部完成

---

## 审查结果

### danmaku-burner.js（已完成）

- ✅ `burn()` — FFmpeg spawn，subtitle 滤镜，libx264/QSV 双编码
- ✅ `probeCapabilities()` — subtitles 滤镜、编码器、fontconfig 能力检测
- ✅ `estimateTimeout()` — `max(30min, 视频时长×4)` 超时估算
- ✅ `getVideoDurationMs()` — ffprobe 获取时长
- ✅ `_buildArgs()` — 构建完整 FFmpeg 参数
- ✅ `_buildFilterChain()` — ASS 路径转义（`\`→`/`、`:`→`\:`）
- ✅ 前置检查：输入文件、ASS 文件、ASS 空事件、输出覆盖
- ✅ NICE=10 低优先级执行
- ✅ 超时 + SIGTERM/SIGKILL 优雅终止

### DanmakuBurnQueue.js（已完成）

- ✅ Redis LIST 队列 (`danmaku_burn_queue`)
- ✅ Redis 计数器并发控制 (`danmaku_burn_processing_count`)，强制 concurrency=1
- ✅ `enqueue()` — 单任务入队，含前置检查（input/ass 存在、输出覆盖）
- ✅ `enqueueSession()` — 批量入队，自动查找 mp4→ass 映射
- ✅ `processQueue()` — 轮询处理，concurrency 限流
- ✅ `processTask()` — FFmpeg 压制 + DB 记录更新（processing→completed/failed）
- ✅ `_createBurnRecord()` — INSERT ... ON CONFLICT DO UPDATE
- ✅ 失败清理：删除失败的输出文件
- ✅ recording_files 状态同步：`is_danmaku_burned`, `danmaku_burn_path`

---

## 当前会话变更

| 文件                                     | 类型     | 说明                                                                                                                    |
| ---------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `services/DataService.js`                | 修改     | `getSessions()` 左连接 `danmaku_burn_records` 汇总统计                                                                  |
| `views/sessions.ejs`                     | 修改     | 会话卡片压制汇总状态（压制中/完成/失败）                                                                                |
| `test/danmaku-burner.test.js`            | **新增** | 24 个测试：buildFilterChain/buildArgs/burn 前置/成功/失败/getVideoDuration/estimateTimeout/probeCapabilities/自定义路径 |
| `test/danmaku-burn-queue.test.js`        | **新增** | 24 个测试：init/enqueue/enqueueSession/processTask 成功失败/并发控制/processQueue                                       |
| `docs/todo/PHASE3_DANMAKU_BURN_TASKS.md` | 新增     | 阶段文档                                                                                                                |

## 单元测试覆盖

### danmaku-burner (24 tests)

- `_buildFilterChain`: 正常/反斜杠/冒号/单引号/中文 (5 tests)
- `_buildArgs`: libx264/QSV (2 tests)
- `burn()` 前置检查: 输入不存在/ASS不存在/空事件/输出覆盖 (4 tests)
- `burn()` 成功: 正常/QSV/多行弹幕/无Events (4 tests)
- `burn()` 失败: 非零退出码/spawn错误 (2 tests)
- `getVideoDurationMs`: 正常解析/ffprobe失败 (2 tests)
- `estimateTimeout`: 短视频/长视频 (2 tests)
- `probeCapabilities`: 全检测/ffmpeg不可用 (2 tests)
- 自定义路径: FFMPEG_PATH/FFPROBE_PATH (1 test)

### DanmakuBurnQueue (24 tests)

- `init()`: 正常配置/强限制最大1/DB失败 (3 tests)
- `enqueue()`: 正常/输入不存在/ASS不存在/输出覆盖 (4 tests)
- `enqueueSession()`: 多分段/无文件/无ASS/优先MP4 (4 tests)
- `processTask()`: 成功(DB同步)/burn失败/burner异常 (3 tests)
- 并发控制: getCount/increment/decrement/reset/getQueueLength (7 tests)
- `processQueue()`: 空队列/并发上限/重入防护 (3 tests)

## 验证结果

- ✅ ESLint: 0 errors, 0 warnings
- ✅ Jest: 14 suites / 247 tests 全部通过

---

下一步：**阶段 4 — 前端 UI 与配置面板**（settings 页面、session 详情页、弹幕搜索/统计面板）
