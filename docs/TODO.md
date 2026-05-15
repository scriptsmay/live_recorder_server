# TODO

## ~~feature: 全局设置~~ ✅

- 已完成全局设置表 `settings`（KV 结构），前端 `/settings` 页面
- 配置项：
  - `pool_size`：下载线程池大小，限制最大同时录制数，默认 `3`
  - `watchdog_interval`：看门狗检查间隔（秒），默认 `30`
  - `watchdog_timeout`：录制状态检查超时（秒），超过则标记为完成，默认 `60`
  - `filtering_threshold`：碎片过滤 (MB)，默认 `10`
  - `delay`：下播延迟检测（秒），默认 `60`
  - `submit_api`、`lines`、`threads`、`pool2_size`：biliup 上传相关

## ~~feature: 直播间加入通知开关配置~~ ✅

- `rooms` 表新增 `notification_enabled` 字段
- 前端表单增加通知开关
- 所有通知点（录制开始/完成、投稿开始/完成）均已集成检查

## ~~feature: 直播间增加监听状态开关~~ ✅

- `rooms` 表新增 `monitoring_enabled` 字段
- 关闭时：`api/notify/live_download` 直接返回已暂停状态
- `api/notify/status` 查询时返回 `monitoring_paused` 信息

## ~~0. 优先解决：重启服务后重连 ffmpeg 下载进程后直播间状态不对的问题~~ ✅

- 将 `ffmpeg.on('close')` 注册提前到 spawn 之后立即执行，避免丢失 close 事件
- 初始化等待后增加 process-alive 确认
- catch 块增加 session 状态二次校验，防止重复处理
