# 快手轮询反爬改进方案

创建日期：2026-06-10

## 最终实现修订

初版方案为便于调试，设计了较多快手专属环境变量。实际落地后，为避免可选小模块的配置项喧宾夺主，已将超时、等待、backoff、UA、session TTL、session scope 和行为模拟参数收敛为代码常量；用户侧只保留 `REMOTE_BROWSER_WS_ENDPOINT`、`KUAISHOU_CHECKER_ENABLED` 和平台级初始访问态 `POLLING_KUAISHOU_COOKIE`。

## 背景

快手轮询 Checker 基础功能已开发完成（见 `docs/finished_plan/KUAISHOU_POLLING_CHECKER/`），单元测试 13/13 全部通过，全量回归 283 用例无回归。但冒烟测试中，首次访问即触发快手反爬（"请求过快，请稍后重试"），导致两个目标直播间均未能获取到真实数据。

当前实现每次轮询都创建全新的浏览器上下文（无 cookie、无历史访问记录），配合资源拦截和无登录态的 session，在快手风控视角下是一个典型的自动化访问特征。反爬检测和 backoff 机制本身工作正常，但触发频率过高会严重影响轮询有效性。

本方案针对两个方向进行改进：

1. 持久化浏览器上下文与 cookie 保持——让轮询看起来像"回头用户"而非每次都是全新访客。
2. 人类行为模拟——在页面加载后加入随机延迟、滚动等行为，降低自动化指纹特征。

## 现状分析

### 当前 RemoteBrowserClient 生命周期

```
withPage(task, options)
  → browser.newContext({ userAgent, viewport, locale, timezoneId })
    → context.newPage()
      → page.route() 资源拦截
      → task(page, context)
    → finally: page.close(), context.close()
```

每次 `withPage` 调用产生一个全新的 context，没有任何历史 cookie、localStorage 或其他浏览器存储状态。对快手而言，这意味着：

- 每次访问都没有 `did_key` / `client_key` 等快手常用 cookie，等同于一个从未访问过的新设备。
- 没有浏览历史，没有先前页面交互产生的任何状态。
- 同一出口 IP 在短时间内反复出现"全新访客"，是典型的自动化特征。

### 当前 KuaishouChecker 页面交互

```
page.goto(url, { waitUntil: 'domcontentloaded' })
  → page.waitForFunction(() => __INITIAL_STATE__ ready, { timeout: waitMs })
  → page.evaluate(() => extract state)
```

整个过程中页面没有任何用户交互行为：无鼠标移动、无滚动、无随机延迟。页面加载完成后立即执行 `evaluate` 提取数据，整个过程耗时极短且行为高度一致，容易被反爬系统识别。

## 改进方向一：持久化浏览器上下文与 Cookie 保持

### 目标

在保持浏览器指纹隔离的前提下，跨轮询保持快手相关的 cookie，使每次访问看起来是同一个"回头用户"，而不是每次都从零开始的新设备。

### 设计原则

- 只持久化 cookie，不持久化 localStorage、IndexedDB、Cache Storage。快手可能在 localStorage 中写入风控标记（如设备指纹哈希），这些应该每轮清除。
- cookie 默认按快手平台共享存储，更接近同一用户连续访问多个直播间的真实行为；如后续发现单个 session 污染面过大，可通过配置切换为按 `principalId`（即直播间 ID）隔离存储。
- 使用 Redis 存储 cookie 状态，而非本地文件系统。原因是：已有 Redis 基础设施、支持 TTL 自动过期、多实例部署时无文件冲突。
- 对 cookie 持久化功能做开关控制，可独立于 `KUAISHOU_CHECKER_ENABLED` 开关。

### Review 补充结论

- 默认开启类配置应使用 `isEnabled()` 语义，而不是 `isExplicitTrue()`；否则环境变量未设置时会和表格里的默认值相反。
- `KUAISHOU_CHECKER_SIMULATE_SCROLL_COUNT=0` 应被视为合法值，用于关闭滚动；不能复用只接受正整数的 `parsePositiveInt()`。
- 行为模拟的随机函数需要可注入随机源，便于单元测试稳定断言。
- `RemoteBrowserClient` 保存 storage state 必须发生在 `context.close()` 前，并且保存失败不能覆盖原始 task 错误。

### Redis 存储设计

Key 格式：

```
kuaishou:checker:session:platform
```

如果 `KUAISHOU_CHECKER_SESSION_SCOPE=room`，则 key 切换为：

```
kuaishou:checker:session:room:{principalId}
```

Value 为 JSON 序列化的 Playwright `storageState` 中的 cookies 部分：

```json
{
  "cookies": [
    {
      "name": "did",
      "value": "web_xxxxx",
      "domain": ".kuaishou.com",
      "path": "/",
      "expires": 1720000000,
      "httpOnly": false,
      "secure": true,
      "sameSite": "Lax"
    }
  ]
}
```

TTL：7 天（604800 秒），与快手 cookie 的自然过期时间对齐。每次成功轮询后刷新 TTL。

### 环境变量

| 变量                                   | 默认值     | 说明                                   |
| -------------------------------------- | ---------- | -------------------------------------- |
| `KUAISHOU_CHECKER_PERSIST_SESSION`     | `true`     | 是否启用 cookie 持久化                 |
| `KUAISHOU_CHECKER_SESSION_TTL_SECONDS` | `604800`   | Redis 中 session 数据的 TTL            |
| `KUAISHOU_CHECKER_SESSION_SCOPE`       | `platform` | session 共享范围：`platform` 或 `room` |

### RemoteBrowserClient 改动

在 `withPage` 的 options 中新增两个可选字段：

```js
async withPage(task, options = {}) {
  // ...
  const storageState = options.storageState || undefined;  // 传入：加载 cookie
  const saveStorageState = options.saveStorageState;       // 传出：保存 cookie 的回调

  context = await browser.newContext({
    userAgent: options.userAgent || DEFAULT_USER_AGENT,
    viewport: options.viewport || DEFAULT_VIEWPORT,
    locale: options.locale || 'zh-CN',
    timezoneId: options.timezoneId || 'Asia/Shanghai',
    storageState,  // 如果提供，加载 cookie 到 context
  });

  // ... 其余逻辑不变 ...

  // 在 finally 中，关闭 context 之前提取 cookie
  if (saveStorageState) {
    try {
      const state = await context.storageState();
      await saveStorageState({ cookies: state.cookies });
    } catch (_) {}
  }
}
```

关键设计点：

- `storageState` 只传入 cookies 部分，Playwright 的 `newContext({ storageState })` 支持只包含 cookies 的对象。
- `saveStorageState` 是一个异步回调函数，由调用方（KuaishouChecker）决定如何持久化。这种设计让 `RemoteBrowserClient` 不依赖 Redis，保持通用性。
- cookie 提取在 `finally` 块中、`context.close()` 之前执行，确保即使 task 抛错也能保存当前 cookie。

### KuaishouChecker 改动

新增 session 管理方法：

```js
getSessionKey(principalId) {
  const scope = process.env.KUAISHOU_CHECKER_SESSION_SCOPE === 'room' ? 'room' : 'platform';
  return scope === 'room'
    ? `kuaishou:checker:session:room:${principalId}`
    : 'kuaishou:checker:session:platform';
}

async _loadSession(principalId) {
  if (!isEnabled(process.env.KUAISHOU_CHECKER_PERSIST_SESSION)) {
    return undefined;
  }
  const raw = await this.redis.get(this.getSessionKey(principalId)).catch(() => null);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return undefined;
  }
}

async _saveSession(principalId, state) {
  if (!isEnabled(process.env.KUAISHOU_CHECKER_PERSIST_SESSION)) {
    return;
  }
  const ttl = parsePositiveInt(
    process.env.KUAISHOU_CHECKER_SESSION_TTL_SECONDS,
    604800
  );
  // 过滤：只保留 kuaishou.com 域名的 cookie
  const filtered = {
    cookies: (state.cookies || []).filter(
      (c) => c.domain && c.domain.includes('kuaishou.com')
    ),
  };
  await this.redis
    .setEx(this.getSessionKey(principalId), ttl, JSON.stringify(filtered))
    .catch(() => {});
}
```

在 `checkStatus()` 的 `withPage` 调用中集成：

```js
const principalId = this.getRoomKey();
const storageState = await this._loadSession(principalId);

const snapshot = await this.browserClient.withPage(
  async (page) => {
    // ... 现有页面交互逻辑不变 ...
  },
  {
    timeoutMs,
    userAgent: this.getUserAgent(),
    stealth: isExplicitTrue(process.env.KUAISHOU_CHECKER_STEALTH),
    allowFirstScreenResources: isExplicitTrue(process.env.KUAISHOU_CHECKER_ALLOW_FIRST_SCREEN_RESOURCES),
    storageState,
    saveStorageState: (state) => this._saveSession(principalId, state),
  }
);
```

### 过滤策略说明

`_saveSession` 中只保留 `kuaishou.com` 域名的 cookie，原因：

- 页面加载过程中可能产生第三方 cookie（如 CDN、广告平台），这些不需要持久化。
- 减少 Redis 存储体积。
- 避免第三方 cookie 过期或变化导致 context 创建异常。

### 首次访问 vs 后续访问的行为差异

| 场景                     | storageState         | 行为                                                            |
| ------------------------ | -------------------- | --------------------------------------------------------------- |
| 首次访问（Redis 无记录） | `undefined`          | 等同于当前行为，创建全新 context                                |
| 后续访问（Redis 有记录） | `{ cookies: [...] }` | context 携带 cookie，快手页面能看到"回头用户"                   |
| cookie 过期（TTL 到期）  | `undefined`          | 自动回退到首次访问行为                                          |
| 触发反爬后               | 保留 cookie          | 不清除 cookie，backoff 机制负责冷却；冷却结束后携带 cookie 重试 |

### 注意事项

- 反爬触发时**不清除** cookie。快手的反爬标记大概率绑定在 IP 或设备指纹层面，清除 cookie 反而会丢失 `did`（设备 ID）等标识，使下一次访问看起来更像新设备。
- 如果连续多轮（如 3 轮以上）携带 cookie 仍然触发反爬，可以考虑清除 cookie 重建 session，但这个逻辑属于更高级的自适应策略，本阶段不实现。

## 改进方向二：人类行为模拟

### 目标

在页面加载完成后、数据提取之前，插入随机的人类交互行为，使页面访问模式更接近真人浏览。

### 设计原则

- 行为模拟只在页面加载后、`evaluate` 提取之前执行，不影响数据提取逻辑。
- 所有行为参数（延迟范围、滚动次数等）通过环境变量控制，可调优。
- 行为模拟的随机性应使用合理的分布，而非简单的 `Math.random()` 均匀分布。
- 模拟行为不应显著增加单次轮询的耗时，总增加时间控制在 3-8 秒内。

### 环境变量

| 变量                                     | 默认值 | 说明                           |
| ---------------------------------------- | ------ | ------------------------------ |
| `KUAISHOU_CHECKER_SIMULATE_HUMAN`        | `true` | 是否启用人类行为模拟           |
| `KUAISHOU_CHECKER_SIMULATE_MIN_DELAY_MS` | `1500` | 页面加载后最小等待时间（毫秒） |
| `KUAISHOU_CHECKER_SIMULATE_MAX_DELAY_MS` | `4000` | 页面加载后最大等待时间（毫秒） |
| `KUAISHOU_CHECKER_SIMULATE_SCROLL_COUNT` | `2`    | 模拟滚动次数（0 表示不滚动）   |

### 行为模拟模块

新增 `lib/core/browser/humanBehavior.js`：

```js
/**
 * 人类行为模拟器
 * 在页面加载后注入随机化的交互行为，降低自动化检测概率
 */

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * 模拟页面加载后的初始等待
 * 真人打开页面后不会立刻操作，会有一个短暂的"阅读/定位"停顿
 */
async function simulateInitialDelay(page, options = {}) {
  const minMs = options.minDelayMs ?? 1500;
  const maxMs = options.maxDelayMs ?? 4000;
  const delay = randomBetween(minMs, maxMs);
  await page.waitForTimeout(delay);
}

/**
 * 模拟随机滚动
 * 真人浏览直播页面时通常会滚动查看内容
 * 使用 page.evaluate 在页面内执行 window.scrollBy，
 * 避免 Playwright 的 mouse.wheel 被部分反爬检测
 */
async function simulateScrolling(page, options = {}) {
  const count = options.scrollCount ?? 2;
  if (count <= 0) return;

  for (let i = 0; i < count; i++) {
    const distance = randomBetween(100, 400);
    await page.evaluate((d) => {
      window.scrollBy({ top: d, behavior: 'smooth' });
    }, distance);
    await page.waitForTimeout(randomBetween(500, 1500));
  }

  // 滚回顶部，因为后续 evaluate 需要从正常视口读取状态
  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  await page.waitForTimeout(randomBetween(300, 800));
}

/**
 * 执行完整的人类行为模拟序列
 */
async function simulateHumanBehavior(page, options = {}) {
  await simulateInitialDelay(page, options);
  await simulateScrolling(page, options);
}

module.exports = {
  simulateHumanBehavior,
  simulateInitialDelay,
  simulateScrolling,
  randomBetween,
};
```

### KuaishouChecker 集成

在 `checkStatus()` 的 `withPage` 回调中，`waitForFunction` 之后、`evaluate` 之前插入行为模拟：

```js
const { simulateHumanBehavior } = require('../browser/humanBehavior');

// 在 withPage 的 task 回调中：
await page.goto(this.getNormalizedUrl(), {
  waitUntil: 'domcontentloaded',
  timeout: timeoutMs,
});

await page.waitForFunction(/* ... */).catch(() => {});

// 人类行为模拟
if (isEnabled(process.env.KUAISHOU_CHECKER_SIMULATE_HUMAN)) {
  await simulateHumanBehavior(page, {
    minDelayMs: parsePositiveInt(process.env.KUAISHOU_CHECKER_SIMULATE_MIN_DELAY_MS, 1500),
    maxDelayMs: parsePositiveInt(process.env.KUAISHOU_CHECKER_SIMULATE_MAX_DELAY_MS, 4000),
    scrollCount: parseNonNegativeInt(process.env.KUAISHOU_CHECKER_SIMULATE_SCROLL_COUNT, 2),
  });
}

return page.evaluate(() => ({
  title: document.title || '',
  bodyText: document.body?.innerText?.slice(0, 5000) || '',
  state: window.__INITIAL_STATE__ || null,
}));
```

### 超时预算

行为模拟会增加单次轮询耗时。当前 `KUAISHOU_CHECKER_WAIT_MS` 默认 12000ms，行为模拟默认最多增加约 `4000 + 2 * (1500 + 800) = 8600ms`。需要确保总耗时不超过 `KUAISHOU_CHECKER_TIMEOUT_MS`（默认 45000ms）。

当前默认值下：12000（wait）+ 8600（模拟）+ 页面加载时间（通常 5-10s）≈ 25-30s，在 45s 超时内有余量。

如果同时启用行为模拟，建议将 `KUAISHOU_CHECKER_TIMEOUT_MS` 保持 45000 或适当调高。

### 注意事项

- `page.waitForTimeout` 在 Playwright 中已被标记为不推荐（推荐用 `page.waitForSelector` 等确定性等待），但在行为模拟场景下它是合理的选择，因为这里的目的就是"无意义地等待一段时间"。
- 滚动使用 `page.evaluate(() => window.scrollBy(...))` 而非 Playwright 的 `mouse.wheel()`，因为前者在页面内执行，更像真实的用户行为，且不容易被 CDP 层面的监听捕获。
- 滚动结束后滚回顶部，避免影响后续 `evaluate` 中对 `document.body.innerText` 的读取（某些页面在滚动后会触发懒加载，改变 DOM 结构）。

## 测试计划

### 单元测试新增

在 `test/polling-kuaishou.test.js` 中追加：

1. **Cookie 持久化 — 首次访问无 storageState**：mock Redis 返回 `null`，验证 `withPage` 被调用时 `options.storageState` 为 `undefined`。
2. **Cookie 持久化 — 后续访问加载 storageState**：mock Redis 返回已存储的 cookie JSON，验证 `withPage` 被调用时 `options.storageState` 包含正确的 cookies。
3. **Cookie 持久化 — 成功轮询后保存 cookie**：验证 `saveStorageState` 回调被调用，且 Redis `setEx` 被写入正确的 key 和过滤后的 cookie。
4. **Cookie 持久化 — 过滤非快手域名 cookie**：构造包含 `.kuaishou.com` 和 `.example.com` 的混合 cookie 列表，验证只有 `.kuaishou.com` 的 cookie 被保存。
5. **Cookie 持久化 — 功能关闭时不读写 Redis**：设置 `KUAISHOU_CHECKER_PERSIST_SESSION=false`，验证不读取也不写入 session key。
6. **Cookie 持久化 — 损坏的 JSON 不崩溃**：mock Redis 返回非法 JSON，验证 `_loadSession` 返回 `undefined` 而非抛错。
7. **Cookie 持久化 — session scope**：验证默认 key 为 `kuaishou:checker:session:platform`，`KUAISHOU_CHECKER_SESSION_SCOPE=room` 时 key 包含 principalId。
8. **人类行为模拟 — 默认启用时调用 simulateHumanBehavior**：mock `simulateHumanBehavior`，验证未设置 `KUAISHOU_CHECKER_SIMULATE_HUMAN` 时被调用。
9. **人类行为模拟 — 关闭时不调用**：验证 `KUAISHOU_CHECKER_SIMULATE_HUMAN=false` 时不调用模拟函数。

新增 `test/human-behavior.test.js`：

1. **simulateInitialDelay**：验证等待时间在 `[minMs, maxMs]` 范围内。
2. **simulateScrolling**：验证 `page.evaluate` 被调用的次数等于 `scrollCount + 1`（N 次滚动 + 1 次回顶部）。
3. **simulateScrolling count=0**：验证不执行任何滚动。
4. **randomBetween**：验证返回值在 `[min, max]` 闭区间内。

### 冒烟测试调整

在 `scripts/smoke-kuaishou-checker.js` 中：

- 增加 session 状态日志：每轮检查后输出当前 principalId 是否有已存储的 session cookie。
- 增加行为模拟耗时日志：记录模拟行为实际花费的时间。
- 建议将冒烟轮次增加到 3 轮：第 1 轮为首次访问（无 cookie），第 2 轮应携带第 1 轮保存的 cookie，第 3 轮验证 cookie 持续性。

## 开发步骤

1. 新增 `lib/core/browser/humanBehavior.js`，实现 `simulateHumanBehavior`、`simulateInitialDelay`、`simulateScrolling`、`randomBetween`。
2. 修改 `RemoteBrowserClient.withPage`，支持 `storageState` 和 `saveStorageState` 参数。
3. 修改 `KuaishouChecker`，新增 `_loadSession` / `_saveSession` 方法。
4. 修改 `KuaishouChecker.checkStatus`，在 `withPage` 调用中集成 cookie 加载/保存和行为模拟。
5. 新增环境变量到 `.env.example` 和 `.env.docker.example`。
6. 在 `test/polling-kuaishou.test.js` 中追加 cookie 持久化测试用例。
7. 新增 `test/human-behavior.test.js`，覆盖行为模拟模块。
8. 修改 `scripts/smoke-kuaishou-checker.js`，增加 session 和行为模拟的日志输出。
9. 执行 `npm test` 确认所有测试通过。

## 风险与回滚

### 风险

- Cookie 持久化可能反而让风控标记持续跟随同一 session，导致该 principalId 被"记住"并持续拦截。缓解：可通过 `KUAISHOU_CHECKER_PERSIST_SESSION=false` 快速关闭，回退到当前行为。
- 行为模拟增加单次轮询耗时，在直播间数量较多时可能导致轮询周期拉长。缓解：行为模拟总耗时上限约 8.6s，相对于 60-90s 的轮询间隔占比可控。
- `page.waitForTimeout` 在高并发场景下会占用 Playwright 的事件循环。缓解：快手平台级并发已限制为 1，不存在高并发问题。
- 滚动行为可能触发页面懒加载，改变 `__INITIAL_STATE__` 之外的 DOM 状态。缓解：`extractStatus` 只读取 `__INITIAL_STATE__`，不依赖 DOM 结构。

### 回滚

1. 设置 `KUAISHOU_CHECKER_PERSIST_SESSION=false` 关闭 cookie 持久化。
2. 设置 `KUAISHOU_CHECKER_SIMULATE_HUMAN=false` 关闭行为模拟。
3. 两个开关可以独立控制，也可以同时关闭回退到当前行为。
4. 如需清除已存储的 session：`redis-cli DEL kuaishou:checker:session:*`（或在应用启动时清除）。
