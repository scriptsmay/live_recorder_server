# 快手轮询 Checker 开发计划

创建日期：2026-06-09

## 目标

为 `live-recorder-server` 新增 `kuaishou` 平台轮询 Checker，使后端在不依赖 Chrome 扩展手动推流的情况下，能够通过远程浏览器检查快手直播间：

- 抓取主播名。
- 判断开播状态。
- 直播中时尽量提取可录制 FLV 地址。
- 在 60 秒以上轮询间隔下保持稳定。
- 遇到快手风控时保持上一轮状态，不误判下播。

## 范围

本阶段包含：

- 后端轮询 Checker 技术实现。
- 远程 browserless 连接封装。
- 快手页面状态抽取与风控识别。
- 单元测试和可选 smoke 脚本。
- 文档与配置说明。

本阶段不包含：

- 快手 `__NS_hxfalcon` 纯 HTTP 签名逆向。
- 登录态维护和验证码自动破解。
- 弹幕采集逻辑改造。
- 前端 UI 大改。

## 依赖选择

推荐新增依赖：

```bash
npm install playwright-core
```

理由：

- 只连接远程 Chromium，不下载本地浏览器。
- 与 infra 中的 `ws://192.168.0.247:11300/chromium/playwright` 匹配。
- API 与调研脚本验证路径一致。

不建议直接安装完整 `playwright`，避免引入本地浏览器下载和部署体积膨胀。

## 配置项

新增环境变量建议：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REMOTE_BROWSER_WS_ENDPOINT` | 空 | 远程浏览器 WebSocket 地址，例如 `ws://192.168.0.247:11300/chromium/playwright` |
| `KUAISHOU_CHECKER_ENABLED` | `true` | 是否启用快手浏览器 Checker |
| `KUAISHOU_CHECKER_TIMEOUT_MS` | `45000` | 单次页面检查超时 |
| `KUAISHOU_CHECKER_WAIT_MS` | `12000` | 页面进入后等待初始状态稳定的时间 |
| `KUAISHOU_CHECKER_MIN_INTERVAL_SECONDS` | `60` | 单房间最小检查间隔 |
| `KUAISHOU_CHECKER_BACKOFF_SECONDS` | `180` | 触发风控后的退避时间 |
| `KUAISHOU_CHECKER_HEADLESS_USER_AGENT` | Chrome 121 desktop UA | 页面 UA |

如果 `REMOTE_BROWSER_WS_ENDPOINT` 未配置，`KuaishouChecker` 应返回明确错误，且不注册或不启用轮询。

## 模块设计

### 1. `lib/core/browser/RemoteBrowserClient.js`

职责：

- 统一连接 browserless。
- 懒加载 `playwright-core`。
- 复用 browser 连接。
- 为每次检查创建独立 context/page。
- 提供资源拦截能力。
- 支持健康检查和关闭连接。

建议接口：

```js
class RemoteBrowserClient {
  async getBrowser();
  async withPage(task, options);
  async close();
}
```

资源拦截建议：

- 允许：主文档、核心 JS、必要 XHR。
- 阻断：图片、字体、media、Sentry、日志上报、验证码 iframe、广告。
- 不要阻断 `live.kuaishou.com/live_api/liveroom/livedetail`，这是页面初始状态来源之一。

### 2. `lib/core/polling/KuaishouChecker.js`

继承 `PlatformChecker`。

静态方法：

```js
static getPlatformId() {
  return 'kuaishou';
}

static canHandleUrl(url) {
  return /(?:live\.)?kuaishou\.com/i.test(url);
}
```

核心流程：

1. 检查 Redis 中 `kuaishou:checker:backoff:{roomKey}`，命中则抛出 `KUAISHOU_BACKOFF_ACTIVE`。
2. 通过 `RemoteBrowserClient.withPage()` 打开直播间 URL。
3. 等待 `window.__INITIAL_STATE__.liveroom.playList.length > 0` 或超时。
4. 抽取 `playList[activeIndex || 0]`。
5. 如果 `errorType.title` 包含 `请求过快`、`验证码`、`风控`，写入 backoff 并抛出 `KUAISHOU_ANTICRAWL`。
6. 解析主播名、开播状态、封面、标题、FLV 地址。
7. 返回 `PlatformChecker.normalizeResult()`。

结果映射：

| 页面状态 | Checker 行为 |
| --- | --- |
| `isLiving=true` | 返回 `isLive=true`，`recordable=true`，尽量返回 `streamUrl` |
| `isLiving=false` 且页面含 `主播尚未开播` | 返回 `isLive=false`，`recordable=true`，`streamUrl=null` |
| `请求过快` / 验证码 / 400002 | 抛错，不返回 `isLive=false` |
| 无 `__INITIAL_STATE__` | 抛错，不更新上一轮状态 |

### 3. `lib/core/polling/checkers.js`

注册：

```js
const KuaishouChecker = require('./KuaishouChecker');

module.exports = {
  huya: HuyaChecker,
  bilibili: BilibiliChecker,
  douyu: DouyuChecker,
  douyin: DouyinChecker,
  kuaishou: KuaishouChecker,
};
```

### 4. `PollingManager` 状态安全

当前 `PollingManager.checkRoom()` 只有 Checker 抛错时才不会更新状态。如果 Checker 返回 `normalizeResult({ error })`，默认会得到 `isLive=false`，可能误判下播。

建议本次实现两层保护：

1. `KuaishouChecker` 对不可信状态直接抛错。
2. `PollingManager` 增加通用保护：

```js
const result = await checker.checkStatus();
if (result.error) {
  console.warn(`[PollingManager] 状态检查返回错误，保留上一轮状态: ${result.error}`);
  return;
}
```

这能避免其他平台未来也因 `error` 误写 `false`。

## 快手状态抽取细节

主播名：

```js
const author = item.author || {};
const roomName =
  author.userName ||
  author.user_name ||
  author.name ||
  author.nickname ||
  pageTitle.replace(/-快手直播$/, '');
```

开播状态：

```js
const streamUrl = pickBestStreamUrl(item.liveStream);
const isLive = item.isLiving === true || Boolean(streamUrl);
const isOffline = item.isLiving === false && /主播尚未开播/.test(bodyText);
```

注意：

- 不要用 `在线观众`、`礼物`、`快币` 这类全局文案判断直播中。
- “请求过快”页也可能包含通用直播页模块文本。

FLV 选择：

```js
function pickBestStreamUrl(liveStream) {
  const reps = liveStream?.playUrls?.h264?.adaptationSet?.representation || [];
  const candidates = reps
    .filter((r) => r.url && !r.hidden && /\.flv(\?|$)/i.test(r.url))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return candidates[0]?.url || null;
}
```

日志输出时必须脱敏：

```js
url.replace(/([?&](txSecret|hwSecret|wsSecret|stat|token|sign|sig)=)[^&]+/gi, '$1<redacted>');
```

## 轮询策略

建议默认配置：

- 快手房间默认 `polling_interval=90` 秒。
- 最小允许值 `60` 秒。
- 每个快手房间使用 Redis 分布式锁，避免多实例或重复 reload 并发检查。
- 触发 `KUAISHOU_ANTICRAWL` 后退避 180 秒，并保留上一轮状态。

Redis key：

```text
kuaishou:checker:last_poll:{roomIdOrPrincipalId}
kuaishou:checker:lock:{roomIdOrPrincipalId}
kuaishou:checker:backoff:{roomIdOrPrincipalId}
polling:live_status:{roomId}
```

## 测试计划

### 单元测试

新增 `test/polling-kuaishou.test.js`：

- `canHandleUrl()` 能识别 `live.kuaishou.com/u/...`。
- `extractPrincipalId()` 能解析 `/u/KSGJuHao`、`/u/KPL704668133`。
- 正常直播 state 返回 `isLive=true`、`roomName`、`streamUrl`。
- 正常未开播 state 返回 `isLive=false`、`roomName`、`streamUrl=null`。
- `errorType.title=请求过快，请稍后重试` 时抛出 `KUAISHOU_ANTICRAWL`。
- FLV URL 脱敏函数不泄漏签名参数。

### 集成 smoke

新增可选脚本：

```text
scripts/smoke-kuaishou-checker.js
```

执行：

```bash
REMOTE_BROWSER_WS_ENDPOINT=ws://192.168.0.247:11300/chromium/playwright \
node scripts/smoke-kuaishou-checker.js
```

脚本检查两个固定 URL：

- `KSGJuHao`：期望 `roomName=KSG句号`，正常窗口下 `isLive=false`。
- `KPL704668133`：期望 `roomName=KPL王者荣耀职业联赛`，`isLive=true`。

smoke 脚本默认两轮，间隔 70 秒。若出现 `KUAISHOU_ANTICRAWL`，输出 `UNKNOWN` 并标记为风控，不算作下播。

## 开发步骤

1. 新增 `playwright-core` 依赖。
2. 新增 `RemoteBrowserClient`，实现 browserless 连接、页面创建、资源拦截、关闭。
3. 新增 `KuaishouChecker`，实现页面加载、状态抽取、风控识别、FLV 选择。
4. 注册 `kuaishou` 到 `checkers.js`。
5. 给 `PollingManager` 增加 `result.error` 不更新状态保护。
6. 给平台检测和 DB 文档补充 `kuaishou` 已支持轮询。
7. 新增 `test/polling-kuaishou.test.js`。
8. 新增可选 smoke 脚本并在文档中说明不要频繁运行。
9. 执行 `npm run lint && npm test`。

## 验收命令

```bash
npm run lint
npm test -- test/polling-kuaishou.test.js
REMOTE_BROWSER_WS_ENDPOINT=ws://192.168.0.247:11300/chromium/playwright node scripts/smoke-kuaishou-checker.js
```

## 风险与回滚

风险：

- 快手风控策略变化，页面返回 `请求过快` 或验证码。
- Browserless 服务不可用。
- 直播页 JS 包 hash 更新，字段结构变化。
- FLV URL 有签名时效，轮询取到后必须尽快用于录制。

缓解：

- 风控状态抛错，不覆盖上一轮状态。
- 快手 Checker 受 `KUAISHOU_CHECKER_ENABLED` 控制，可快速关闭。
- 字段抽取保留多路径 fallback。
- `streamUrl` 不持久化长期复用，只传给当前录制启动流程。

回滚：

1. 从 `checkers.js` 移除 `kuaishou` 注册。
2. 设置 `KUAISHOU_CHECKER_ENABLED=false`。
3. 对已有快手房间关闭 `polling_enabled` 或改回 Chrome 扩展触发。
