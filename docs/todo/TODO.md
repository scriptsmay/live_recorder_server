# TODO

<!-- 这个目录存放后续开发计划文档。 -->

## 已完成计划

1. ~~[快手直播弹幕录制与视频弹幕压制开发计划](KUAISHOU_DANMAKU_RECORDING_PLAN.md)~~ → 已完成，已移至 `docs/finished_plan/KUAISHOU_DANMAKU_FULL_IMPLEMENTATION/`

## 待完成计划

- [弹幕压制模块独立化重构开发计划](./DANMAKU_BURN_DECOUPLE_PLAN.md)

- [分段文件时间记录实现方案](./SEGMENT_TIME_TRACKING.md) 中有个问题没有解决，视频分段文件不是按照文件 id 索引升序排序，导致弹幕生成后视频文件的**分段时间**展示是错的，对应前端页面： `sessions/49/danmuku`
