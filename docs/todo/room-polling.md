# 直播间轮询功能开发计划

## 功能概述

在直播间新增**是否开启轮询**字段，默认关闭。如果开启轮询，则调用对应平台的工具去查询直播间的开播状态，检测到开播后自动启动录制。

## 目标平台

- 第一期：虎牙
- 设计上支持扩展其他平台

## 技术设计

### 1. 数据库设计

#### 1.1 新增字段

在 `rooms` 表中添加以下字段：

| 字段名             | 类型        | 默认值 | 说明                         |
| ------------------ | ----------- | ------ | ---------------------------- |
| `polling_enabled`  | BOOLEAN     | FALSE  | 是否开启轮询                 |
| `polling_platform` | VARCHAR(50) | NULL   | 平台标识（huya, douyu, etc） |
| `polling_interval` | INTEGER     | 60     | 轮询间隔（秒）               |
| `last_polled_at`   | TIMESTAMP   | NULL   | 上次轮询时间                 |
| `last_live_status` | BOOLEAN     | FALSE  | 上次检测的直播状态           |

### 2. 平台检查器架构

采用**策略模式**设计平台检查器，便于扩展：

```
lib/core/polling/
├── PollingManager.js       # 轮询管理器
├── PlatformChecker.js      # 平台检查器基类
├── HuyaChecker.js          # 虎牙平台检查器
└── index.js                # 导出模块
```

#### 2.1 平台检查器基类 (`PlatformChecker.js`)

```javascript
class PlatformChecker {
  constructor(roomUrl) {
    this.roomUrl = roomUrl;
  }

  // 检查直播状态，返回 { isLive: boolean, streamUrl?: string, roomName?: string }
  async checkStatus() {
    throw new Error('Not implemented');
  }

  // 获取平台标识
  static getPlatformId() {
    throw new Error('Not implemented');
  }

  // 验证是否支持该 URL
  static canHandleUrl(url) {
    throw new Error('Not implemented');
  }
}
```

#### 2.2 虎牙平台检查器 (`HuyaChecker.js`)

参考 biliup 的虎牙实现，使用 HTTP API 方式查询：

- 使用移动 API（更稳定）：`https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid={roomId}`
- 解析返回的 JSON，检查 `liveStatus` 字段
- 无需获取真实流地址，由浏览器扩展推送或后续补充

### 3. 轮询管理器 (`PollingManager.js`)

- 单例模式管理
- 从数据库加载所有开启轮询的房间
- 维护每个房间的轮询定时器
- 检测到开播时：
  - 标记状态
  - 可选：通过现有机制启动录制（暂时依赖浏览器扩展推送 URL）
  - 发送通知

### 4. 集成到看门狗

在 `lib/core/watchdog.js` 中集成轮询逻辑：

- 在 `runWatchdog` 中添加轮询检查步骤
- 或独立运行轮询循环

## 开发任务清单

### 阶段一：数据库和基础结构

- [ ] 1. 编写数据库迁移脚本
  - [ ] 在 `db/migrate.js` 中添加 ALTER TABLE 语句
  - [ ] 添加默认轮询间隔到 settings 表（默认 60 秒）

- [ ] 2. 创建平台检查器基础结构
  - [ ] 创建 `lib/core/polling/` 目录
  - [ ] 实现 `PlatformChecker.js` 基类
  - [ ] 实现 `index.js` 导出
  - [ ] 添加单元测试

### 阶段二：虎牙平台检查器

- [ ] 3. 实现虎牙检查器
  - [ ] 实现 `HuyaChecker.js`
  - [ ] 实现 URL 匹配逻辑（匹配 huya.com 域名）
  - [ ] 实现房间号解析（支持数字 ID 和字符串房间号）
  - [ ] 实现 `checkStatus()` 方法
  - [ ] 添加请求重试和错误处理
  - [ ] 编写测试用例

- [ ] 4. 实现轮询管理器
  - [ ] 实现 `PollingManager.js`
  - [ ] 实现从数据库加载房间列表
  - [ ] 实现按房间配置的间隔轮询
  - [ ] 实现状态变更检测（离线 -> 开播）
  - [ ] 更新 `last_polled_at` 和 `last_live_status`
  - [ ] 添加日志

### 阶段三：API 和前端更新

- [ ] 5. 更新 API
  - [ ] 更新 `router/rooms.js` 中的 GET/POST/PUT 接口
  - [ ] 添加轮询相关字段到查询和更新
  - [ ] 更新 `ROOM_FIELDS_IDLE` 和 `ROOM_FIELDS_WHILE_RECORDING`

- [ ] 6. 更新数据服务
  - [ ] 更新 `services/DataService.js` 中的 `getRooms` 和 `getRoomById`
  - [ ] 确保返回新字段

- [ ] 7. 更新前端界面
  - [ ] 更新 `views/rooms.ejs`
  - [ ] 在表格中添加轮询状态列
  - [ ] 在 Modal 中添加轮询开关
  - [ ] 在 Modal 中添加平台选择下拉框
  - [ ] 在 Modal 中添加轮询间隔输入框（可选）
  - [ ] 更新 JavaScript 逻辑

- [ ] 8. 更新 HTML 路由
  - [ ] 更新 `router/html.js` 中的 `/rooms` 路由
  - [ ] 确保渲染新字段

### 阶段四：集成和测试

- [ ] 9. 集成到看门狗
  - [ ] 更新 `lib/core/watchdog.js`
  - [ ] 在启动时初始化轮询管理器
  - [ ] 在关闭时停止所有轮询

- [ ] 10. 编写测试
  - [ ] 单元测试
  - [ ] API 集成测试
  - [ ] 手动测试虎牙平台

- [ ] 11. 更新文档
  - [ ] 更新 `docs/DB.md`
  - [ ] 更新 `docs/API.md`
  - [ ] 更新 `README.md`（可选）

## 技术细节

### 虎牙 API 参考

参考 biliup 的实现：

```python
# 获取房间信息
url = f"https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid={roomId}"
# 返回 JSON 中 data.liveStatus == 'ON' 表示开播
```

### 注意事项

1. **流地址获取**：轮询只检测开播状态，不获取流地址。流地址仍由浏览器扩展推送。
2. **防封禁**：添加随机延迟，避免请求过于规律
3. **错误处理**：单个房间查询失败不影响其他房间
4. **状态保持**：记录上次状态，仅在状态变化时触发动作
5. **性能优化**：使用 Redis 缓存房间信息，减少数据库查询

## 后续扩展

- 支持更多平台（斗鱼、B站等）
- 实现自动获取流地址并启动录制
- 轮询历史记录和统计
- 更智能的轮询策略（根据主播习惯调整间隔）
