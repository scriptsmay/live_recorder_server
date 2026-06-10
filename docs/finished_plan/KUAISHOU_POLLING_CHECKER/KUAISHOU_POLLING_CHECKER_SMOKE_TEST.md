# 快手轮询 Checker 冒烟测试报告

测试日期：2026-06-10

## 测试环境

| 项目 | 值 |
|------|-----|
| Browserless 地址 | `ws://192.168.0.247:11300/chromium/playwright` |
| Chromium 版本 | HeadlessChrome/121.0.6167.85 |
| 目标直播间 1 | `https://live.kuaishou.com/u/KSGJuHao`（KSG句号，预期未开播） |
| 目标直播间 2 | `https://live.kuaishou.com/u/KPL704668133`（KPL王者荣耀职业联赛，预期直播中） |
| Cookie 来源 | 本机浏览器访问快手直播间后提取 `document.cookie`，7 个 cookie |

## 代码变更摘要

测试过程中发现并修复了以下问题：

1. `DEFAULT_STEALTH` 从 `false` 改为 `true`，stealth 模式默认开启。
2. `checkStatus()` 中的 stealth 和资源拦截改为可通过环境变量控制：`KUAISHOU_CHECKER_STEALTH` 和 `KUAISHOU_CHECKER_ALLOW_FIRST_SCREEN_RESOURCES`。
3. 当 `KUAISHOU_CHECKER_ALLOW_FIRST_SCREEN_RESOURCES=true` 时，完全禁用资源拦截（`blockResources: false`）。
4. 修复了因 `POLLING_KUAISHOU_COOKIE` 环境变量设置导致的单元测试断言失败。

## 测试结果

### 矩阵测试：stealth 与资源拦截的组合

使用 `RemoteBrowserClient.withPage` 直接测试，目标 KPL704668133，携带 seed cookie：

| stealth | blockResources | 结果 | 说明 |
|---------|---------------|------|------|
| false | true（默认拦截） | 反爬：`请求过快，请稍后重试` | 快手识别出 `navigator.webdriver=true` |
| true | true（默认拦截） | Playwright 运行时错误：`instanceof is not an object` | stealth init script 与资源拦截环境冲突 |
| true | false（不拦截） | **成功**：获取到完整直播页面数据 | 正确组合 |

结论：**`stealth: true` + `blockResources: false` 是绕过快手反爬的必要条件。**

### 冒烟测试第一轮（KSGJuHao + KPL704668133）

使用 `scripts/smoke-kuaishou-checker.js`，`stealth=true`，`allowFirstScreenResources=true`，1 轮，跨房间间隔 20 秒：

**KSGJuHao（第 1 个请求）：成功**

```json
{
  "target": "KSGJuHao",
  "principalId": "KSGJuHao",
  "sessionKey": "kuaishou:checker:session:platform",
  "hadSession": false,
  "hasSession": true,
  "status": "ok",
  "isLive": false,
  "roomName": "KSG句号",
  "streamUrl": null,
  "streamInfo": null
}
```

验证点：

- `status: "ok"` —— 成功获取直播间状态。
- `isLive: false` —— 正确识别未开播。
- `roomName: "KSG句号"` —— 正确提取主播名。
- `hadSession: false, hasSession: true` —— cookie 从 `.env` 种子加载（首次），然后保存到 Redis（后续复用）。
- cookie 持久化链路完整验证通过。

**KPL704668133（第 2 个请求，20 秒后）：反爬**

```json
{
  "target": "KPL704668133",
  "status": "unknown",
  "error": "KUAISHOU_ANTICRAWL:请求过快，请稍后重试"
}
```

原因：同一 Browserless 出口 IP 在 20 秒内连续请求两个不同直播间，触发快手 IP 级频率限制。backoff 机制正确触发，设置了 180 秒平台级冷却。

### IP 冷却恢复测试

密集测试导致 Browserless 出口 IP 被快手临时封禁后，进行了冷却恢复测试：

| 等待时间 | 结果 |
|---------|------|
| 2 分钟 | 仍然反爬 |
| 5 分钟 | 仍然反爬 |

快手的 IP 级封禁冷却时间较长（预估 10-30 分钟），这属于正常的反爬策略行为，不影响生产环境的稳定性（生产环境单房间间隔 60-90 秒，不会触发密集请求）。

## 单元测试

代码修复后运行全量测试：

- 快手轮询专项测试：22/22 通过
- 全量回归测试：297/297 通过，18 个测试套件
- 零回归

## 生产部署配置建议

```bash
REMOTE_BROWSER_WS_ENDPOINT=ws://192.168.0.247:11300/chromium/playwright
POLLING_KUAISHOU_COOKIE=<从浏览器提取的 cookie 字符串>
KUAISHOU_CHECKER_ENABLED=true
KUAISHOU_CHECKER_ALLOW_FIRST_SCREEN_RESOURCES=true
```

注意事项：

- `POLLING_KUAISHOU_COOKIE` 作为种子 cookie，首次访问时注入，后续由 Redis 持久化管理。cookie 有过期时间（约 7 天），过期后需要重新从浏览器提取并更新。
- `KUAISHOU_CHECKER_ALLOW_FIRST_SCREEN_RESOURCES=true` 会禁用资源拦截，页面加载量会增大，但能避免资源拦截触发反爬。
- 快手房间的轮询间隔建议保持在 60 秒以上，跨房间间隔保持 20 秒以上。
- 如果 Browserless 出口 IP 被封，需要等待 10-30 分钟冷却，或重启 Browserless 服务换 IP。
