# 阶段 2：ASS 生成 — 任务清单

创建日期：2026-06-01

## 状态总览

| 任务  | 说明                              |   状态    |
| ----- | --------------------------------- | :-------: |
| T2-1  | DanmakuAssGenerator.js 核心生成器 | ✅ 已实现 |
| T2-2  | ASS 字符转义 (`_escapeAssText`)   | ✅ 已实现 |
| T2-3  | 密度限制 (`_applyDensityLimit`)   | ✅ 已实现 |
| T2-4  | 轨道分配 (`_generateAssEvents`)   | ✅ 已实现 |
| T2-5  | 分段裁切 (`generateSegmentAss`)   | ✅ 已实现 |
| T2-6  | 手动重新生成 ASS API              | ✅ 已实现 |
| T2-7  | 时间偏移参数支持                  | ✅ 已实现 |
| T2-8  | 单元测试 — ASS 转义               | ✅ 已完成 |
| T2-9  | 单元测试 — 轨道分配               | ✅ 已完成 |
| T2-10 | 单元测试 — 密度限制               | ✅ 已完成 |
| T2-11 | 单元测试 — 分段裁剪               | ✅ 已完成 |
| T2-12 | 单元测试 — 端到端生成             | ✅ 已完成 |

## 阶段 2 全部完成

- **52 个单元测试** 覆盖 ASS 生成全链路
- **offsetMs 时间偏移** 支持正偏移（延迟）和负偏移（提前，不溢出到负数）
- API `POST /api/sessions/:id/danmaku/ass` 接受 `{ offsetMs, videoWidth, videoHeight }`

### 变更文件

| 文件                                       | 类型 | 说明                           |
| ------------------------------------------ | ---- | ------------------------------ |
| `lib/core/danmaku/DanmakuAssGenerator.js`  | 修改 | 白空格弹幕 trim、offsetMs 参数 |
| `router/danmaku.js`                        | 修改 | offsetMs 参数透传              |
| `test/danmaku-ass-generator.test.js`       | 新增 | 52 个测试用例                  |
| `docs/todo/PHASE2_ASS_GENERATION_TASKS.md` | 新增 | 阶段文档                       |

### 验证

- ✅ ESLint 0 errors
- ✅ Jest 12 suites / 199 tests 全部通过

---

下一步：**阶段 3 — 弹幕压制队列**（DanmakuBurnQueue + danmaku-burner + 性能基准测试）
