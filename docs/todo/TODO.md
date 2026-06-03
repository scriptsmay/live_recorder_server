# TODO

<!-- 这个目录存放后续开发计划文档。 -->

## 已完成计划

1. ~~[快手直播弹幕录制与视频弹幕压制开发计划](KUAISHOU_DANMAKU_RECORDING_PLAN.md)~~ → 已完成，已移至 `docs/finished_plan/KUAISHOU_DANMAKU_FULL_IMPLEMENTATION/`

2. ~~[弹幕压制模块独立化重构开发计划](../finished_plan/DANMAKU_BURN_DECOUPLE/DANMAKU_BURN_DECOUPLE_PLAN.md)~~ → 已完成，已移至 `docs/finished_plan/DANMAKU_BURN_DECOUPLE/`

3. ~~EJS → Vue 前端迁移（主体页面）~~ → 已完成（2026-06-04），详见下方遗留项

## 待完成计划

（暂无）

## 已完成 — EJS → Vue 迁移遗留项（2026-06-04）

以下遗留项已全部处理完毕：

1. ~~`/logs` 路由冲突修复~~ → 移除了 `logsRouter` 中 `GET /logs` 的 EJS 页面渲染，仅保留 `/api/logs/*` 端点
2. ~~`/apiview` 页面处理~~ → 不再需要，已从文档中移除引用
3. ~~`/upload_records` → `/upload-records` 路径重定向~~ → 在 `spa.js` 和 Vue Router 中均添加了 301 重定向
4. ~~清理 `views/` 目录下 EJS 文件~~ → 已通过 `git rm` 移除全部 19 个 EJS 文件及 `router/html.js`、`middleware/view-locals.js`
5. ~~清理 EJS 相关依赖~~ → 从 `package.json` 移除 `ejs`、`express-ejs-layouts`；从 `app.js` 移除 `ejsLayouts`、`view engine`、`viewLocalsMiddleware` 配置
