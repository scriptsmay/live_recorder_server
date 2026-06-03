# TODO

<!-- 这个目录存放后续开发计划文档。 -->

## 已完成计划

1. ~~[快手直播弹幕录制与视频弹幕压制开发计划](KUAISHOU_DANMAKU_RECORDING_PLAN.md)~~ → 已完成，已移至 `docs/finished_plan/KUAISHOU_DANMAKU_FULL_IMPLEMENTATION/`

2. ~~[弹幕压制模块独立化重构开发计划](../finished_plan/DANMAKU_BURN_DECOUPLE/DANMAKU_BURN_DECOUPLE_PLAN.md)~~ → 已完成，已移至 `docs/finished_plan/DANMAKU_BURN_DECOUPLE/`

3. ~~EJS → Vue 前端迁移（主体页面）~~ → 已完成（2026-06-04），详见下方遗留项

## 待完成计划

### EJS → Vue 迁移遗留项

以下为前端迁移后遗留的待处理事项，按优先级排列：

#### 1. `/logs` 路由冲突修复（严重）

`router/index.js` 中 `logsRouter` 注册在 `spaRouter` 之前，导致 `GET /logs` 请求始终由 EJS `logs.ejs` 响应，Vue 的 `Logs.vue` 在生产环境无法被加载。

**修复方案：** 移除 `logsRouter` 中 `GET /logs` 的 EJS 页面渲染（保留 `/api/logs/*` 的 API 端点），或将 `spaRouter` 注册顺序提到 `logsRouter` 之前。

#### 2. `/apiview` 页面处理（低优先级）

EJS 中有 `GET /apiview` 路由（渲染 `docs/API.md`），Vue 前端无对应页面。htmlRouter 注释后此路径已不可达。

**方案：** 如仍需此功能，创建 `ApiView.vue` 组件并在 Vue Router 和 spa.js 中添加路由；否则从文档中移除。

#### 3. `/upload_records` → `/upload-records` 路径重定向（低优先级）

EJS 使用 `/upload_records`（下划线），Vue 改为 `/upload-records`（连字符）。外部链接或浏览器书签指向旧路径时会 404。

**方案：** 在 `spa.js` 或 Vue Router 中添加重定向：`/upload_records` → `/upload-records`。

#### 4. 清理 `views/` 目录下 EJS 文件（低优先级）

`htmlRouter` 已完全注释禁用，`views/` 目录下 19 个 EJS 文件已无实际用途（`logs.ejs` 在修复问题 #1 后也将不再需要）。

**方案：** 确认无回退需求后，将 `views/` 目录归档或删除。同时可清理 `app.js` 中的 EJS 相关配置（`ejsLayouts`、`view engine` 设置、`viewLocalsMiddleware`）。

#### 5. 清理 EJS 相关依赖（低优先级）

`package.json` 中 `ejs`、`express-ejs-layouts` 等依赖在完全迁移后不再需要。`middleware/view-locals.js` 也可移除。

**方案：** 与问题 #4 一并处理。
