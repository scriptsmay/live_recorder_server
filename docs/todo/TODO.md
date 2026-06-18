# TODO

<!-- 这个目录存放后续开发计划文档。 -->

## 已完成计划

1. ~~[快手直播弹幕录制与视频弹幕压制开发计划](KUAISHOU_DANMAKU_RECORDING_PLAN.md)~~ → 已完成，已移至 `docs/finished_plan/KUAISHOU_DANMAKU_FULL_IMPLEMENTATION/`

2. ~~[弹幕压制模块独立化重构开发计划](../finished_plan/DANMAKU_BURN_DECOUPLE/DANMAKU_BURN_DECOUPLE_PLAN.md)~~ → 已完成，已移至 `docs/finished_plan/DANMAKU_BURN_DECOUPLE/`

3. ~~[快手轮询 Checker 技术调研](../finished_plan/KUAISHOU_POLLING_CHECKER/KUAISHOU_POLLING_CHECKER_TECH_RESEARCH.md)~~ → 已完成，已移至 `docs/finished_plan/KUAISHOU_POLLING_CHECKER/`

4. ~~[快手轮询 Checker 开发计划](../finished_plan/KUAISHOU_POLLING_CHECKER/KUAISHOU_POLLING_CHECKER_DEV_PLAN.md)~~ → 已完成，已移至 `docs/finished_plan/KUAISHOU_POLLING_CHECKER/`

5. ~~[快手轮询反爬改进方案](../finished_plan/KUAISHOU_ANTICRAWL_IMPROVEMENT/KUAISHOU_ANTICRAWL_IMPROVEMENT_PLAN.md)~~ → 已完成，已移至 `docs/finished_plan/KUAISHOU_ANTICRAWL_IMPROVEMENT/`

6. ~~[快手 Checker API 直连方案](../finished_plan/KUAISHOU_API_DIRECT/KUAISHOU_API_DIRECT_PLAN.md)~~ → 已完成，已移至 `docs/finished_plan/KUAISHOU_API_DIRECT/`。API 直连作为备用方案（KuaishouAPIChecker），主方案恢复为远程浏览器模式。

7. ~~[仪表盘（Dashboard）改造计划](../finished_plan/DASHBOARD_UPGRADE/DASHBOARD_UPGRADE_PLAN.md)~~ → 已完成，已移至 `docs/finished_plan/DASHBOARD_UPGRADE/`

8. ~~[前端登录认证开发计划](../finished_plan/AUTH_LOGIN/AUTH_LOGIN_PLAN.md)~~ → 已完成，新增单管理员登录、HttpOnly Cookie session、首次启动自动生成密码、前端路由守卫与用户菜单

9. ~~[回放工具箱补全开发方案](../finished_plan/REPLAY_TOOLBOX_ENHANCEMENT/REPLAY_TOOLBOX_ENHANCEMENT_PLAN.md)~~ → 已完成，新增主播显示名配置、北京时间文件名、投稿预览 API 与确认框

## 待完成计划

暂无。

## 设计说明待整理

为什么弹幕工具箱页面（danmaku-toolbox）点击展开文件（组件： SegmentsPanel.vue ）时要同时请求2个API： `api/recording_files?session_id=51` 和 `api/danmaku_burn_records?session_id=51` 是出于什么设计这么做的？

答：这是故意拆分的数据源设计。`recording_files` 是录制分段文件的事实表，负责展示每个原始视频分段的文件名、路径、大小、状态、分段序号和时间范围；`danmaku_burn_records` 是弹幕压制任务/产物表，负责展示每个分段是否已压制、压制状态、输出文件、错误信息和删除操作。弹幕压制被独立成队列后，一个录制分段可以没有压制记录，也可能有正在处理/失败/完成的压制记录；前端需要先拿完整分段列表，再按 `recording_file_id` 或 `segment_index` 合并压制状态，所以并行请求两个 API 比把压制状态塞回 `recording_files` 更符合模块解耦设计。
