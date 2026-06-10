# 快手 Checker API 直连方案

创建日期：2026-06-10

## 背景

快手轮询 Checker 当前通过远程 Browserless/Chromium 加载直播间页面，从 `window.__INITIAL_STATE__` 提取开播状态和 FLV 流地址。在生产环境部署后，Browserless 的 headless Chromium 持续触发快手反爬（`KUAISHOU_ANTICRAWL:请求过快，请稍后重试`），即使已完成以下所有优化：

- `DEFAULT_STEALTH=true` + `DEFAULT_LAUNCH_ARGS=["--disable-blink-features=AutomationControlled"]`（Browserless 服务端）
- `addInitScript` 覆盖 `navigator.webdriver`（应用层）
- `POLLING_KUAISHOU_COOKIE` 注入真实浏览器 cookie
- `KUAISHOU_CHECKER_ALLOW_FIRST_SCREEN_RESOURCES=true` 关闭资源拦截
- Cookie 持久化（Redis session 跨轮询复用）
- 人类行为模拟（随机延迟 + 滚动）

通过诊断脚本逐步排除后确认：快手在 SSR 阶段通过 TLS 指纹（JA3/JA4）识别 headless Chromium，反爬发生在浏览器 JS 执行之前的服务端渲染层。无论是否携带 cookie、是否开启 stealth、是否拦截资源，只要 TLS 指纹匹配 headless Chromium 特征，SSR 直接返回 `errorType.title=请求过快`。

关键发现：同一 Browserless 实例中，使用 Node.js `fetch` 直接请求快手 API 端点 **不会触发反爬**。快手的反爬仅针对浏览器页面请求（通过 TLS 指纹区分），不拦截普通 HTTP API 调用。

## 已验证的 API 端点

以下端点均通过 Node.js `fetch`（非浏览器）验证可用，返回 200，无反爬：

### 1. `GET /live_api/liveroom/livedetail?principalId={id}`

返回开播状态和流信息，结构与 `__INITIAL_STATE__.liveroom.playList[0]` 高度一致：

```json
{
  "data": {
    "result": 2,
    "liveStream": {
      "playUrls": {
        "h264": {},
        "hevc": {}
      },
      "url": "https://m.gifshow.com/fw/live/undefined",
      "type": "live"
    },
    "author": {
      "living": false,
      "followStatus": "UN_FOLLOWED",
      "timestamp": 1781078893677,
      "verifiedStatus": { "type": 0 },
      "bannedStatus": { "banned": false }
    },
    "gameInfo": {},
    "noticeList": [],
    "config": { "canSendGift": false }
  }
}
```

关键字段：

- `data.author.living`：是否直播中（bool）
- `data.liveStream.playUrls.h264`：H.264 流信息，直播中包含 `adaptationSet.representation[]`（与现有 `pickBestStreamUrl` 输入结构一致）
- `data.liveStream.playUrls.hevc`：H.265 流信息（fallback）
- `data.result`：结果码，`2` 表示未开播

直播中时 `playUrls.h264` 预期结构（与 SSR `__INITIAL_STATE__` 一致）：

```json
{
  "adaptationSet": {
    "representation": [
      {
        "url": "https://tx-origin.pull.yximgs.com/...flv?...",
        "bitrate": 4000,
        "hidden": false
      }
    ]
  }
}
```

### 2. `GET /live_api/profile/public?principalId={id}`

轻量版接口，只含 `living` 状态和 `playUrls` 数组：

```json
{
  "data": {
    "live": {
      "playUrls": [],
      "author": { "living": false },
      "living": false,
      "quality": "standard",
      "type": "live"
    },
    "result": 2
  }
}
```

适合作为 `livedetail` 的 fallback，或在只需要判断开播状态时使用。

### 3. HTML `<title>` 提取主播名

快手直播间页面 HTML 可通过 Node.js `fetch` 直接获取（59KB，无反爬）：

```html
<title data-vm-ssr="true">KSG无言-快手直播</title>
<meta name="keywords" content="快手,直播,游戏直播,热门游戏,高清游戏,KSG无言,3xhpa8nk4a7xdg6">
```

提取方式：`document.title.replace(/-快手直播$/, '')` 或正则匹配 `<title[^>]*>([^<]+)</title>`。

注意：主播名提取只需在首次添加房间或房间名变更时执行一次，不必每轮轮询都请求 HTML 页面。提取后存入数据库 `rooms` 表即可。

## 方案设计

### 核心思路

将 `KuaishouChecker` 从浏览器模式切换为纯 HTTP API 模式，复用现有 `PlatformChecker` 接口和 `PollingManager` 调度机制。参考 `HuyaChecker` 的纯 HTTP 实现模式。

### 请求流程

```
checkStatus()
  ├─ 1. 检查 Redis backoff（复用现有逻辑）
  ├─ 2. GET /live_api/liveroom/livedetail?principalId={id}
  │     ├─ 成功 → 提取 living、playUrls
  │     └─ 失败/超时 → fallback 到 profile/public
  ├─ 3. GET /live_api/profile/public?principalId={id}（fallback）
  ├─ 4. 解析开播状态
  │     ├─ living=true → pickBestStreamUrl(playUrls.h264) → 返回 streamUrl
  │     ├─ living=false → 返回 isLive=false
  │     └─ result 异常 → 抛错，不更新状态
  └─ 5. 如果房间名缺失 → GET HTML 页面提取 <title>
```

### 模块改动

#### `lib/core/polling/KuaishouChecker.js`（重写）

去掉所有浏览器相关代码（`RemoteBrowserClient`、`humanBehavior`、`withPage`），改为纯 HTTP：

```js
class KuaishouChecker extends PlatformChecker {
  static getPlatformId() { return 'kuaishou'; }
  static canHandleUrl(url) { return /(?:live\.)?kuaishou\.com/i.test(url || ''); }
  static extractPrincipalId(url) { /* 现有逻辑不变 */ }

  async checkStatus() {
    // 1. Redis 守卫（backoff、interval、lock）— 复用现有逻辑
    // 2. HTTP 请求 livedetail API
    // 3. 解析响应，提取 living、streamUrl
    // 4. 如果房间名缺失，请求 HTML 提取 title
    // 5. 返回 normalizeResult
  }
}
```

关键设计点：

- `pickBestStreamUrl()` 现有逻辑直接复用，`livedetail` 的 `liveStream` 结构与 `__INITIAL_STATE__` 一致。
- `redactUrl()` 脱敏逻辑不变。
- Redis 守卫（backoff、interval、lock）逻辑不变，但不再需要 Browserless 相关的 session/cookie 管理。
- 不需要 `REMOTE_BROWSER_WS_ENDPOINT`、`KUAISHOU_CHECKER_ENABLED`（改为始终可用）、`POLLING_KUAISHOU_COOKIE`。
- 新增 `KUAISHOU_API_TIMEOUT_MS`（默认 15000），HTTP 请求超时。

#### 请求头配置

```js
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://live.kuaishou.com/',
  Origin: 'https://live.kuaishou.com',
};
```

UA 使用主流 Chrome 版本，定期更新。不需要与 Browserless Chromium 的 UA 对齐，因为不再是浏览器请求。

#### 反爬处理

虽然 API 端点目前不触发反爬，仍需保留防御机制：

- HTTP 响应非 200 或返回异常 JSON 时，抛错不更新状态。
- 如果 API 响应中出现 `result: 400002`（验证码）或 `errorType`，视为反爬，触发 backoff。
- 保留 Redis backoff、interval、lock 机制，但 backoff 时间可缩短（如 60 秒，因为 API 请求比浏览器轻量）。

### 环境变量变更

| 变量 | 变更 | 说明 |
|------|------|------|
| `REMOTE_BROWSER_WS_ENDPOINT` | 不再需要（快手） | 其他平台如果有浏览器 Checker 仍可能需要 |
| `KUAISHOU_CHECKER_ENABLED` | 保留 | 控制是否启用快手轮询 |
| `POLLING_KUAISHOU_COOKIE` | 移除 | 纯 HTTP 不需要 cookie |
| `KUAISHOU_CHECKER_ALLOW_FIRST_SCREEN_RESOURCES` | 移除 | 不再加载页面 |
| `KUAISHOU_API_TIMEOUT_MS` | 新增，默认 15000 | HTTP 请求超时 |

### `RemoteBrowserClient` 和 `humanBehavior`

这两个模块不再被 `KuaishouChecker` 使用。如果未来没有其他平台需要浏览器 Checker，可以标记为 deprecated 或移除。本阶段保留代码，只修改 `KuaishouChecker` 的引用。

### 房间名获取策略

1. 数据库 `rooms` 表中已有 `room_name` 字段。如果已有值且非空，不重复请求。
2. 如果 `room_name` 为空或需要刷新，请求 HTML 页面提取 `<title>`。
3. HTML 请求使用独立方法 `fetchRoomName()`，与 `checkStatus()` 解耦。
4. HTML 请求频率限制：同一房间 24 小时内最多请求一次。

## 轮询策略调整

API 请求比浏览器轻量很多，可以适当调整默认参数：

| 参数 | 浏览器模式 | API 模式 | 说明 |
|------|-----------|----------|------|
| 房间间隔 | 60s | 60s | 保持不变，避免过于激进 |
| 全局间隔 | 20s | 10s | API 请求轻量，可适当缩短 |
| Backoff | 180s | 120s | API 反爬概率低，缩短退避 |
| 超时 | 45s | 15s | HTTP 请求远快于浏览器页面加载 |

轮询间隔（`polling_interval`）建议保持 90s 不变，不因为切换到 API 就提高频率——过快请求仍可能触发 IP 级风控。

## 依赖变更

- 移除对 `playwright-core` 的运行时依赖（`KuaishouChecker` 不再 `require`）。
- `playwright-core` 可作为 `optionalDependencies` 保留，供未来调试使用。
- 不引入新依赖，使用 Node.js 22+ 内置的 `fetch` API。

## 测试计划

### 单元测试

重写 `test/polling-kuaishou.test.js`：

- `canHandleUrl()`、`extractPrincipalId()` 逻辑不变。
- Mock `fetch`，验证 `livedetail` 返回正常数据时的解析逻辑。
- Mock `fetch`，验证 `living=true` 时 `pickBestStreamUrl` 从 `liveStream.playUrls.h264` 提取 FLV。
- Mock `fetch`，验证 HTTP 错误/超时时的 fallback 到 `profile/public`。
- Mock `fetch`，验证 `result: 400002` 时抛错不更新状态。
- 验证 HTML `<title>` 提取逻辑。
- 验证 FLV URL 脱敏。
- 验证 Redis backoff/interval/lock 逻辑（复用现有测试，微调参数）。

### 集成测试

改造 `scripts/smoke-kuaishou-checker.js`：

- 去掉 Browserless 连接。
- 直接调用 `KuaishouChecker.checkStatus()`。
- 验证两个目标房间的返回结果。
- 可缩短 smoke 间隔到 30 秒（API 模式更轻）。

## 开发步骤

1. 重写 `KuaishouChecker.checkStatus()`，从浏览器模式切换为纯 HTTP API 模式。
2. 实现 `fetchLivedetail()` 和 `fetchProfilePublic()` 方法。
3. 实现 `fetchRoomName()` HTML 提取方法。
4. 复用现有 `pickBestStreamUrl()` 和 `redactUrl()`。
5. 调整 Redis 守卫参数（缩短 backoff、超时）。
6. 更新环境变量：移除浏览器相关变量，新增 `KUAISHOU_API_TIMEOUT_MS`。
7. 更新 `.env.example` 和 `.env.docker.example`。
8. 重写单元测试。
9. 改造 smoke 脚本。
10. 运行 `npm test` 确认全量回归通过。

## 风险与回滚

### 风险

- 快手 API 端点可能变更路径或增加签名验证。缓解：保留 `profile/public` 作为 fallback；HTML `<title>` 提取作为最终兜底。
- IP 级频率限制仍然可能触发（API 请求和页面请求共享出口 IP）。缓解：保持合理轮询间隔，不激进提速。
- `livedetail` 在直播中时的 `playUrls` 结构未经过实际验证（当前测试目标均未开播）。缓解：结构预期与 `__INITIAL_STATE__` 一致，`pickBestStreamUrl` 已有兼容处理；上线后首次遇到开播目标时观察日志。
- FLV URL 签名时效性不变，轮询取到后仍需尽快用于录制。

### 回滚

1. `KUAISHOU_CHECKER_ENABLED=false` 关闭快手轮询。
2. 如果 API 方案不可用，可回退到浏览器模式（代码保留在 git 历史中）。

## 验收标准

- `KSG无言`（`3xhpa8nk4a7xdg6`）：返回 `isLive=false`，`roomName=KSG无言`。
- 直播中的目标：返回 `isLive=true`，`streamUrl` 为可用 FLV。
- 连续轮询（90s 间隔）至少 5 轮无反爬。
- 不依赖 `REMOTE_BROWSER_WS_ENDPOINT`，Docker 部署无需 Browserless 即可轮询快手。
