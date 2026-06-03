# TODO

<!-- 这个目录存放后续开发计划文档。 -->

## 已完成计划

1. ~~[快手直播弹幕录制与视频弹幕压制开发计划](KUAISHOU_DANMAKU_RECORDING_PLAN.md)~~ → 已完成，已移至 `docs/finished_plan/KUAISHOU_DANMAKU_FULL_IMPLEMENTATION/`

2. ~~[弹幕压制模块独立化重构开发计划](../finished_plan/DANMAKU_BURN_DECOUPLE/DANMAKU_BURN_DECOUPLE_PLAN.md)~~ → 已完成，已移至 `docs/finished_plan/DANMAKU_BURN_DECOUPLE/`

3. ~~EJS → Vue 前端迁移（主体页面）~~ → 已完成（2026-06-04）

## 待完成计划

- 前端 Vue 迁移遗留问题：
  - 日志页面 Logs.vue ： 1、无法正常查看日志； 2、点击左侧文件选择时 url query 没有更新；

- 弹幕录制模块遗留问题：
  - 会话 52 录制已完成，而弹幕状态显示 `录制中`
  - 手动给 52 会话生成字幕文件：POST /api/sessions/52/danmaku/ass ，成功后请求会话文件列表，ASS状态还是空的，这个自动生成ASS文件的流程需要检查一下是不是没跑通？是否与直播间没设置分段时间有关？
  - 会话 #51 有设置分段时间，有2个分段文件，其中只有一个分段文件有ASS文件（ASS 就绪），另一个分段文件没有ASS文件。在前端页面 http://192.168.0.10:5173/sessions/51/danmaku 上,分段时间显示 `0s ~ 0s`
