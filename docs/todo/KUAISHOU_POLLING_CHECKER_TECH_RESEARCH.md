# 快手轮询 Checker 技术调研

创建日期：2026-06-09

## 背景

`live-recorder-server` 当前轮询体系已经支持虎牙、B 站、斗鱼、抖音，快手仍依赖 Chrome 扩展触发录制。新的目标是在后端轮询体系中新增 `kuaishou` 平台 Checker，利用 infra 中已有的远程 browserless/chrome 服务，稳定抓取快手直播间页面的主播名和开播状态。

本次调研验证的目标直播间：

| 主播 | URL | 预期状态 |
| --- | --- | --- |
| KSG句号 | `https://live.kuaishou.com/u/KSGJuHao` | 未开播 |
| KPL王者荣耀职业联赛 | `https://live.kuaishou.com/u/KPL704668133` | 直播中 |

## 远程浏览器配置

已有 infra 配置可直接复用：

| 项目 | 值 |
| --- | --- |
| Browserless HTTP | `http://192.168.0.247:11300` |
| Playwright CDP | `ws://192.168.0.247:11300/chromium/playwright` |
| Browserless WebSocket | `ws://192.168.0.247:11300` |
| 当前服务版本 | `HeadlessChrome/121.0.6167.85`, `Puppeteer/21.9.0` |

调研使用 `chromium.connectOverCDP('ws://192.168.0.247:11300/chromium/playwright')` 连接成功。`live-recorder-server` 当前没有 Playwright/Puppeteer 依赖，正式开发建议引入 `playwright-core`，只连接远程浏览器，不下载本地 Chromium。

## 页面数据源

快手 PC 直播页会在页面中注入 `window.__INITIAL_STATE__`，关键路径：

```text
window.__INITIAL_STATE__.liveroom.playList[activeIndex]
```

该对象包含：

- `isLiving`：当前房间是否开播。
- `author`：主播信息，含 `userName` / `user_name` / `name` 等字段。
- `liveStream`：直播流信息。
- `liveStream.id`：直播流 ID。
- `liveStream.playUrls.h264.adaptationSet.representation[]`：候选 FLV 地址。
- `gameInfo`：游戏分类信息。
- `errorType`：页面级错误，例如“请求过快，请稍后重试”。

直播中页面还会加载 FLV 地址，例如：

```text
https://tx-origin.pull.yximgs.com/gifshow/...GameAvcSdL0.flv?...&srcStrm=aVsqPZTR4Ko...
```

未开播页面在正常访问时可见文本包含：

```text
KSG句号
主播尚未开播，可以观看其他直播
```

## 直接 API 可行性

前端 JS 中存在以下接口：

```text
/live_api/liveroom/livedetail
/live_api/liveroom/websocketinfo
/live_api/liveroom/status
```

其中 `livedetail` 会在前端被改写并签名到真实接口，签名参数包含 `__NS_hxfalcon` 和 `caver`：

```text
/rest/k/live/... ?__NS_hxfalcon=<sign>&caver=<version>
```

签名由快手前端运行时生成，纯 HTTP 复刻成本高，并且不稳定。`websocketinfo` 在直播中页面经常返回：

```json
{ "data": { "result": 400002, "url": "https://captcha.zt.kuaishou.com/iframe/..." } }
```

结论：本阶段不要直接实现签名 API。后端 Checker 应使用远程浏览器加载页面并读取 `__INITIAL_STATE__`，避免逆向 `__NS_hxfalcon`。

## 调研结果

### 第一轮远程浏览器探测

| URL | 页面标题 | 抽取结果 |
| --- | --- | --- |
| `KSGJuHao` | `KSG句号-快手直播` | 可见文本包含 `KSG句号` 和 `主播尚未开播，可以观看其他直播` |
| `KPL704668133` | `KPL王者荣耀职业联赛-快手直播` | `playList[0].isLiving=true`，主播名为 `KPL王者荣耀职业联赛`，可抽取 FLV 地址 |

### 70 秒间隔轮询探测

调研脚本执行两轮，轮间等待 70 秒。

| URL | 第 1 轮 | 第 2 轮 | 结论 |
| --- | --- | --- | --- |
| `KPL704668133` | `isLiving=true`，主播名稳定，FLV 地址可取 | `isLiving=true`，主播名稳定，FLV 地址可取 | 直播中状态稳定 |
| `KSGJuHao` | 出现 `请求过快，请稍后重试` | 仍出现 `请求过快，请稍后重试` | 调研期间短时间访问过密，触发风控；该状态不能当作下播 |

重要观察：

- KPL 直播中页即使触发 `websocketinfo=400002` 验证码，`__INITIAL_STATE__.liveroom.playList[0]` 仍可拿到主播名、`isLiving=true` 和 FLV 地址。
- KSG 未开播页在首次正常访问时能稳定展示未开播文案；但密集访问后 SSR 初始状态会变成 `errorType.title=请求过快，请稍后重试`。
- “请求过快”页面仍可能包含“在线观众”等通用文案，不能用这些通用文案判断直播中。

## 推荐抽取策略

优先级：

1. 等待 `window.__INITIAL_STATE__.liveroom.playList.length > 0`。
2. 读取 `playList[activeIndex || 0]` 作为目标直播间。
3. 若该对象存在 `errorType.title`，并包含 `请求过快`、`验证码`、`风控`，判定为 `UNKNOWN`，不要更新直播状态。
4. 若 `isLiving === true` 或存在可用 FLV URL，判定为直播中。
5. 若 `isLiving === false` 且页面文本包含 `主播尚未开播`，判定为未开播。
6. 主播名优先从 `author.userName`、`author.user_name`、`author.name`、`author.nickname` 获取；失败时从 `<title>` 去掉 `-快手直播` 获取。
7. 直播流地址优先从 `liveStream.playUrls.h264.adaptationSet.representation[]` 选择未隐藏且 bitrate 最高的 FLV；失败时从 `liveStream.playUrls[]` 兼容旧结构。

伪代码：

```js
const state = await page.evaluate(() => window.__INITIAL_STATE__);
const item = state?.liveroom?.playList?.[state.liveroom.activeIndex || 0];

if (!item) throw new Error('KUAISHOU_NO_LIVEROOM_STATE');
if (/请求过快|验证码|风控/.test(item.errorType?.title || '')) {
  throw new Error(`KUAISHOU_ANTICRAWL: ${item.errorType.title}`);
}

const authorName =
  item.author?.userName ||
  item.author?.user_name ||
  item.author?.name ||
  item.author?.nickname ||
  title.replace(/-快手直播$/, '');

const streamUrl = pickBestFlv(item.liveStream);
const isLive = item.isLiving === true || Boolean(streamUrl);
const offline = item.isLiving === false && /主播尚未开播/.test(document.body.innerText);
```

## 风控结论

快手风控比现有 API 型 Checker 更严格，正式实现必须避免以下行为：

- 不要在一个房间上低于 60 秒重复加载页面。
- 不要并发检查同一快手房间。
- 不要在一次检查中触发 `loadMore`、`websocketinfo` 或登录二维码之外的额外交互。
- 不要把 `请求过快` 解析成 `isLive=false`，否则会误发下播通知或覆盖 Redis 状态。
- 不要在日志里输出完整 FLV URL，签名参数有时效性，也不适合长期留存。

## 推荐工程方案

短期方案：

- 新增 `KuaishouChecker`，使用远程浏览器读取页面初始状态。
- 风控/验证码/请求过快时抛出异常，让 `PollingManager` 保持上一轮状态。
- 每房间强制最小轮询间隔 60 秒；建议默认 90 秒。
- 阻断图片、字体、日志上报、Sentry、验证码 iframe 等非必要资源，降低请求量。

中期方案：

- 抽象 `RemoteBrowserClient`，让快手 Checker 独占复用。
- Redis 记录 `kuaishou:checker:last_poll:{roomKey}` 和 `kuaishou:checker:anticrawl:{roomKey}`，命中风控后指数退避。
- 将 `result.error` 的状态处理从 Checker 层统一到 `PollingManager`，避免未来平台误把未知状态写成下播。

## 验收标准

- 对 `KSGJuHao`：正常窗口下返回 `roomName=KSG句号`，`isLive=false`，`streamUrl=null`。
- 对 `KPL704668133`：返回 `roomName=KPL王者荣耀职业联赛`，`isLive=true`，`streamUrl` 为可用 FLV。
- 连续轮询间隔大于等于 60 秒时，KPL 至少连续两轮稳定返回直播中。
- 出现 `请求过快` 或 `400002` 时，不触发下播通知，不覆盖 Redis 中上一轮直播状态。
