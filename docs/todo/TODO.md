# TODO

<!-- 这个目录存放后续开发计划文档。 -->

## 后续开发计划

1. [快手直播弹幕录制与视频弹幕压制开发计划](KUAISHOU_DANMAKU_RECORDING_PLAN.md)

## 已完成：重构logger.js日志轮转模块

```js
// 配置项
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_BACKUPS_PER_DAY = 5; // 每天最多5个备份
const RETENTION_DAYS = 30; // 保留30天
```

文件命名规则：

```
server.log                              # 当前日志（今天）
server.2026-01-15.1.log                 # 今天的第1个备份（超过10MB时）
server.2026-01-15.2.log                 # 今天的第2个备份
server.2026-01-14.log                   # 昨天的日志
server.2026-01-13.log                   # 前天的日志
```

已实现一个支持日期+大小双重维度的日志轮转系统，包括：

- 自动检测日期变更
- 按日期分组管理备份文件
- 智能清理过期日志
- 保持API接口不变（write/end方法）

实现位置：`lib/core/logger.js`。测试覆盖见 `test/logger.test.js`。
