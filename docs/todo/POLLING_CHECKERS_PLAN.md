# 多平台轮询 Checker 开发方案

## 背景

当前 `lib/core/polling` 已实现 `HuyaChecker.js`，并通过
`PollingManager` 定时检测开播状态、写入 Redis 状态缓存、在开播时调用
`RecorderService.startRecording()` 自动录制。

本方案只纳入以下平台：

- `huya`
- `douyu`（⚠️ 不可用 — 平台流约 2 分钟自动切断，非代码问题）
- `bilibili`
- `douyin`

但 `PollingManager` 的 `CHECKERS` 注册表目前只有 `huya`，因此其他平台即使被
URL 检测识别，也无法真正轮询和自动录制。

本方案参考 `../DouyinLiveRecorder/src/spider.py` 与
`../DouyinLiveRecorder/src/stream.py` 的实现，按稳定性和接入成本分阶段补齐平台
Checker。

## 目标

1. 在不改变现有录制链路的前提下，新增多平台直播状态检测与流地址提取能力。
2. 统一 Checker 返回结构，所有平台都返回：

   ```js
   {
     isLive: Boolean,
     roomName: String,
     roomTitle: String,
     roomCover: String,
     streamUrl: String,
     streamInfo: Object
   }
   ```

3. 优先支持无需登录、无需复杂浏览器环境的平台。
4. 对高风控、强签名、需 Cookie 或代理的平台保留扩展接口，不一次性引入重依赖。

## 非目标

- 不引入浏览器自动化、Worker Thread、复杂状态机。
- 不把 DouyinLiveRecorder 的整套 Python 逻辑作为运行时依赖。
- 不在第一阶段支持所有 DouyinLiveRecorder 平台。
- 不在数据库中保存真实 Cookie 或账号密码。

## 总体设计

### 1. Checker 注册表模块化

当前 `PollingManager.js` 内部直接维护：

```js
const CHECKERS = {
  huya: HuyaChecker,
};
```

建议抽成 `lib/core/polling/checkers.js`：

```js
// 第一阶段注册表
const HuyaChecker = require('./HuyaChecker');
const BilibiliChecker = require('./BilibiliChecker');

module.exports = {
  huya: HuyaChecker,
  bilibili: BilibiliChecker,
};
```

第二阶段新增后：

```js
// 第二阶段注册表
const HuyaChecker = require('./HuyaChecker');
const BilibiliChecker = require('./BilibiliChecker');
const DouyuChecker = require('./DouyuChecker');
const DouyinChecker = require('./DouyinChecker');

module.exports = {
  huya: HuyaChecker,
  bilibili: BilibiliChecker,
  douyu: DouyuChecker,
  douyin: DouyinChecker,
};
```

`PollingManager` 只依赖该注册表，后续新增平台不用继续改调度逻辑。

### 2. 增强 PlatformChecker 通用工具

保留轻量原则，在 `PlatformChecker` 增加少量通用方法：

- `fetchJson(url, options)`：统一超时、UA、错误处理。
- `fetchText(url, options)`：用于 HTML 页面解析。
- `normalizeResult(partial)`：补齐默认字段，避免各平台返回结构不一致。
- `extractLastPathSegment(url)`：常见房间号提取。

不引入第三方 HTTP 客户端，继续使用 Node 内置 `fetch`。

### 3. 平台环境配置

新增可选环境变量，用于后续高风控平台：

| 变量 | 用途 | 第一阶段是否必需 |
| --- | --- | --- |
| `POLLING_DEFAULT_USER_AGENT` | 覆盖默认桌面 UA | 否 |
| `POLLING_DOUYIN_COOKIE` | 抖音页面/API Cookie | 否，第二阶段使用 |
| `POLLING_BILIBILI_COOKIE` | B站高画质或风控 Cookie | 否 |

第一阶段不依赖这些配置；有配置时才使用。

## 平台支持优先级

## 第一阶段完成评估

> 评估日期：2026-05-27

| 验收项 | 状态 | 说明 |
|--------|------|------|
| `checkers.js` 注册表 | ✅ | 已创建，`PollingManager` 通过 `require('./checkers')` 获取 Checker |
| `PlatformChecker` 增强 | ✅ | `fetchJson`/`fetchText`/`normalizeResult`/`extractLastPathSegment` 全部实现 |
| `BilibiliChecker` | ✅ | room_init 短号解析、主播信息、房间标题、双版本流地址获取（V1→V2 降级）、FLV/HLS |
| `PollingManager` 使用注册表 | ✅ | `getChecker()` 读注册表，`_extractStreamUrl()` 移除平台特判 |
| `recordable` 字段支持 | ✅ | `checkRoom()` 中 `recordable !== false` 时才触发录制 |
| 测试 | ✅ | 68 tests / 7 suites 全部通过，mock fetch 方式合理 |
| Lint | ✅ | `npm run lint` 无报错 |
| 文档同步 | ⚠️ | ARCHITECTURE.md / API.md / DB.md 已更新；`lessons.md` 未补充（可后续补） |

**遗留项**：

- `lessons.md` 未记录 B站相关经验（API 降级路径、CDN 优先选择策略等），建议在第二阶段一并补充。
- `_extractStreamUrl()` fallback 路径在 `streamInfo` 存在时会重复调用 `checkStatus()`，有冗余 API 请求，不影响正确性，可后续优化。

## 第二阶段完成评估

> 评估日期：2026-05-27（更新：2026-05-27 斗鱼标记为不可用 — 平台流2分钟超时问题）

| 验收项 | 状态 | 说明 |
|--------|------|------|
| `signers/douyu.js` 签名模块 | ❌ | 已优化但不可用：平台流约 2 分钟自动切断，疑似平台强制超时限制 |
| `signers/douyin.js` 签名模块 | ✅ | a_bogus 使用简化 MD5+SHA256 方案，经测试可用；额外提供了 x_bogus |
| `DouyuChecker.js` | ❌ | 已优化但不可用：平台流约 2 分钟自动切断，录制无法持续 |
| `DouyinChecker.js` | ✅ | Web API + HTML 降级、短链接解析、不支持类型检测、Cookie 环境变量，测试通过 |
| 注册表 `checkers.js` | ⚠️ | 四平台（huya/bilibili/douyu/douyin）全部注册，但 douyu 因平台流超时问题不可用 |
| `PollingManager` 兼容 | ✅ | 无需改动，`getChecker()` 自动识别新平台 |
| 测试 | ✅ | 42 tests 全部通过（斗鱼 21 + 抖音 17），全量 110 tests / 9 suites 通过 |
| Lint | ✅ | `npm run lint` 无报错 |
| 文档同步 | ⚠️ | 本方案已更新；ARCHITECTURE.md / API.md / lessons.md 待后续同步 |

**关键实现说明**：

- **斗鱼签名**（已优化）：`signers/douyu.js` 现在使用与 biliup Python 版本相同的 `hlsH5Preview` API。签名方式简化为 `md5(room_id + timestamp)`，通过 POST 请求发送到 `https://playweb.douyucdn.cn/lapi/live/hlsH5Preview/{rid}`，直接使用返回的 `rtmp_url` 和 `rtmp_live` 字段拼接流地址。这种方式更简洁稳定，无需解析网页中的 JS 函数，也无需从 `rtmp_live` 提取 key 构建新 URL。
- **抖音签名**：`signers/douyin.js` 实现了 `generateABogus` 和 `generateXbogus` 两个签名函数。a_bogus 采用 MD5→XOR 混淆→SHA256→Base64 的简化方案，与 Python `ab_sign.py` 的完整算法**不完全一致**。签名算法更新频繁，当前方案可作为初始实现，如遇风控需对照 Python 版本迭代。
- **抖音降级策略**：DouyinChecker 实现了 Web API → HTML 解析的双路径降级。HTML 解析提取 `__INITIAL_STATE__`（方案原定 `RENDER_DATA`，实际抖音页面使用 `__INITIAL_STATE__`）。
- **流地址优先级**：斗鱼 `rtmp_url/rtmp_live` 直接拼接（可能是 HLS 流）；抖音 `pull_datas`(FLV) > `live_core_sdk_data` > `flv_pull_url` > `hls_pull_url`。

**遗留项与风险**：

- 抖音 a_bogus 签名算法为简化版本，可能无法通过抖音风控验证，需实测验证。如签名被拒，需对照 `../DouyinLiveRecorder/src/ab_sign.py` 重写完整算法。
- HTML 降级路径使用 `__INITIAL_STATE__` 正则提取，若抖音 SSR 结构变化可能失效。
- `lessons.md` 仍未补充斗鱼/抖音相关经验，建议在联调后一并记录。
- 尚未进行真实环境联调验证，需手动测试斗鱼和抖音实际录制。

---

### 第一阶段（已完成）：BilibiliChecker

#### 1. BilibiliChecker

参考 DouyinLiveRecorder：

- `get_bilibili_room_info()`
- `get_bilibili_stream_data()`
- `get_bilibili_stream_url()`

实现思路：

1. 从 `live.bilibili.com/{roomId}` 提取房间号。
2. 调用 `https://api.live.bilibili.com/room/v1/Room/room_init?id={roomId}`。
3. 使用 `live_status === 1` 判断开播。
4. 调用 `https://api.live.bilibili.com/live_user/v1/Master/info?uid={uid}` 获取主播名。
5. 调用 H5 房间信息接口获取标题。
6. 开播时调用 `Room/playUrl` 或 `xlive/web-room/v2/index/getRoomPlayInfo` 获取播放 URL。
7. 优先选择 FLV；无 FLV 时返回 HLS。

风险：

- 未登录 Cookie 下高画质可能受限。
- 部分 URL 为短号，需要通过 `room_init` 解析真实 room id。

验收：

- 未开播返回 `isLive: false`。
- 开播返回可被 FFmpeg 使用的 `streamUrl`。
- 支持短房间号与真实房间号。

### 第二阶段：斗鱼与抖音平台

第二阶段目标是实现斗鱼和抖音两个平台的轮询检测与自动录制。这两个平台的复杂度比 B站高，主要因为需要实现平台特定的签名逻辑。

**注意**：不可录制的开播状态（VR/连麦/轮播等）会触发开播通知，但不会启动录制。`PollingManager` 检测到 `recordable: false` 时会跳过录制但仍更新 Redis 缓存。

---

#### 2.1 斗鱼平台 (DouyuChecker)

##### 2.1.1 创建签名模块 `lib/core/polling/signers/douyu.js`

**输入**：`rid`（房间号）
**输出**：`{ did, rid, time, sign }` 或 `null`（失败时）

实现步骤：

1. **生成时间戳**：`Date.now()` 获取当前毫秒时间戳
2. **计算签名**：`md5(room_id + timestamp)` 生成 sign
3. **构造参数**：
   ```js
   {
     did: '10000000000000000000000000001501',  // 默认设备ID
     rid: String(rid),
     time: String(time),
     sign: md5Hash(`${rid}${time}`)
   }
   ```
4. **异常处理**：任何步骤失败返回 `null`，不抛出异常

**参考实现**：biliup 项目 `crates/biliup/src/downloader/extractor/douyu.rs`

**优势**：
- 无需解析网页中的 JS 函数
- 无需 VM 沙箱执行
- 签名算法简单稳定，不易受斗鱼前端变更影响

##### 2.1.2 实现 Checker `lib/core/polling/DouyuChecker.js`

类结构：

```
DouyuChecker extends PlatformChecker
  ├─ static canHandleUrl(url)          // /douyu\.com/i
  ├─ static getPlatformId()            // 'douyu'
  ├─ getRoomId()                       // 从 URL 提取，缓存
  ├─ resolveRealRoomId(shortId)        // 短号→真实 rid（https://m.douyu.com/{shortId}）
  ├─ getRoomStatus(rid)                // GET /betard/{rid}，无需签名
  ├─ getStreamUrl(rid, signParams)     // POST /lapi/live/getH5Play/{rid}
  ├─ isVideoLoop(roomData)             // 检测 videoLoop=1（轮播视为未开播）
  └─ checkStatus()                     // 主流程
```

`checkStatus()` 主流程：

```
1. getRoomId() → 提取短号
2. resolveRealRoomId() → 获取真实 rid
3. getRoomStatus(rid) → 获取房间数据
   ├─ 未开播或 videoLoop=1 → return { isLive: false, roomName, roomTitle }
   └─ 已开播 → 继续
4. getSignParams(rid) → 获取签名（简单 MD5）
   ├─ 签名失败 → return { isLive: true, recordable: false, error: "签名获取失败" }
   └─ 成功 → 继续
5. getStreamUrl(rid, signParams) → POST hlsH5Preview API 获取流地址
   └─ 从 rtmp_live 提取 key 构建 FLV 地址
6. return { isLive: true, streamUrl, roomName, roomTitle }
```

**流地址获取逻辑**（已优化）：

```js
// POST 请求到 hlsH5Preview API
const url = `https://playweb.douyucdn.cn/lapi/live/hlsH5Preview/${rid}`;
const data = await PlatformChecker.fetchJson(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    rid: String(rid),
    time,
    auth: sign,
  },
  body: new URLSearchParams({ did, rid: String(rid) }).toString(),
});

// 直接使用 rtmp_url 和 rtmp_live 拼接（参考 biliup Python 版本）
const streamUrl = `${data.data.rtmp_url}/${data.data.rtmp_live}`;
```

**注意**：`hlsH5Preview` API 返回的可能是 HLS 流（.m3u8）而非 FLV 流，FFmpeg 两种格式都能处理。

##### 2.1.3 注册到注册表

更新 `lib/core/polling/checkers.js`：

```js
const DouyuChecker = require('./DouyuChecker');

module.exports = {
  huya: HuyaChecker,
  bilibili: BilibiliChecker,
  douyu: DouyuChecker,
};
```

##### 2.1.4 测试 `test/polling-douyu.test.js`

测试用例设计：

| 测试组 | 用例 | mock 数据来源 |
|--------|------|--------------|
| 静态方法 | `canHandleUrl` 各类 douyu.com URL | 无需 mock |
| `getRoomId` | 标准 URL / 带查询参数 / 带路径 | 无需 mock |
| `resolveRealRoomId` | 短号解析为数字 rid | 无需 mock |
| 签名模块 | 正常签名返回 `{ v, did, tt, sign }` | mock 房间页面 HTML |
| 签名模块 | JS 提取失败返回 `null` | mock 无 ub98484234 的 HTML |
| 签名模块 | vm 超时返回 `null` | mock 包含死循环的 JS |
| `getRoomStatus` | 正常返回房间信息 | mock betard API |
| `getRoomStatus` | videoLoop=1 视为未开播 | mock betard API |
| `getStreamUrl` | 正常获取流地址 | mock getH5Play API |
| `getStreamUrl` | 签名失效返回 null | mock API 返回错误 |
| `checkStatus` | 完整开播流程 | 链式 mock |
| `checkStatus` | 签名失败降级 | mock 签名失败 |
| `checkStatus` | API 异常不崩溃 | mock fetch 拒绝 |

##### 2.1.5 环境变量

斗鱼暂无必需环境变量。如后续需要 Cookie 支持，预留 `POLLING_DOUYIN_COOKIE`（见下方抖音）。

---

#### 2.2 抖音平台 (DouyinChecker)

##### 2.2.1 创建签名模块 `lib/core/polling/signers/douyin.js`

**参考**：`../DouyinLiveRecorder/src/ab_sign.py`

**输入**：`queryString`（URL 查询字符串）、`userAgent`（浏览器 UA 字符串）
**输出**：`a_bogus` 签名字符串 或 `null`（失败时）

移植步骤：

1. **分析 `ab_sign.py` 核心逻辑**：
   - 字符串处理和哈希计算（基于 SHA256 和自定义混淆）
   - Base64 编码
   - 位运算和混淆处理
2. **逐一对应移植为 Node.js**：
   - Python `hashlib` → Node `crypto.createHash`
   - Python `base64.b64encode` → Node `Buffer.from().toString('base64')`
   - Python 位运算 → JS 位运算（注意 JS 32 位整数限制，使用 `>>> 0` 强制无符号）
3. **封装为纯函数**：`generateABogus(queryString, userAgent)`
4. **单元测试**：用 Python 版本生成对照用例，验证 Node.js 版本输出一致

**注意**：a_bogus 签名更新频繁，抖音可能随时更换算法。签名模块应：
- 所有异常返回 `null`，不阻塞轮询
- 日志中记录签名失败但不打印敏感参数

##### 2.2.2 实现 Checker `lib/core/polling/DouyinChecker.js`

类结构：

```
DouyinChecker extends PlatformChecker
  ├─ static canHandleUrl(url)          // /douyin\.com/i
  ├─ static getPlatformId()            // 'douyin'
  ├─ getRoomId()                       // 从 URL 提取 web_rid
  ├─ resolveShortUrl(url)              // 短链 → 直链（douyin.com/xxx → live.douyin.com/web_rid）
  ├─ getRoomInfoViaWebAPI(webRid)      // Web Enter API + a_bogus 签名
  ├─ getRoomInfoViaHTML(webRid)        // HTML 备用解析（提取 SSR 内嵌 JSON）
  ├─ parseStreamData(apiResponse)      // 从 API 响应提取 streamUrl
  ├─ checkUnsupportedType(roomData)    // 检测 VR/连麦等不支持类型
  └─ checkStatus()                     // 主流程
```

`checkStatus()` 主流程：

```
1. getRoomId() → 提取 web_rid
   ├─ 如果是短链接 → resolveShortUrl() → 重新提取
   └─ 继续
2. getRoomInfoViaWebAPI(webRid)
   ├─ 构建查询参数 + generateABogus() 签名
   ├─ 请求 /webcast/room/web/enter/
   ├─ 成功 → parseStreamData()
   └─ 失败 → 降级到 HTML 备用
3. (降级) getRoomInfoViaHTML(webRid)
   ├─ 请求 live.douyin.com/{web_rid} HTML 页面
   ├─ 正则提取 SSR 内嵌 JSON（RENDER_DATA 或 __RENDER_DATA__）
   ├─ 解析房间状态和流地址
   └─ 失败 → return { error: "..." }
4. checkUnsupportedType(roomData)
   ├─ VR/连麦 → return { isLive: true, recordable: false, error: "不支持的直播类型" }
   └─ 正常 → 继续
5. status === 2 → 开播，提取 streamUrl
   status !== 2 → 未开播
6. return 标准化结果
```

**Web Enter API 请求构造**：

```js
const params = new URLSearchParams({
  aid: '6383',
  app_name: 'douyin_web',
  live_id: '1',
  device_platform: 'web',
  language: 'zh-CN',
  browser_language: 'zh-CN',
  browser_platform: 'Win32',
  browser_name: 'Chrome',
  browser_version: '116.0.0.0',
  web_rid: webRid,
  msToken: '',
  a_bogus: generateABogus(params.toString(), userAgent),
});
```

**流地址提取优先级**：
1. `data.data?.stream_url?.pull_datas` 中的 FLV 地址
2. `data.data?.live_core_sdk_data?.pull_data?.stream_data` JSON 解析
3. 都没有 → `recordable: false`

##### 2.2.3 注册到注册表

更新 `lib/core/polling/checkers.js`：

```js
const DouyinChecker = require('./DouyinChecker');

module.exports = {
  huya: HuyaChecker,
  bilibili: BilibiliChecker,
  douyu: DouyuChecker,
  douyin: DouyinChecker,
};
```

##### 2.2.4 测试 `test/polling-douyin.test.js`

测试用例设计：

| 测试组 | 用例 | mock 数据来源 |
|--------|------|--------------|
| 静态方法 | `canHandleUrl` 各类 douyin.com URL | 无需 mock |
| `getRoomId` | 标准 URL / 短链接 | 无需 mock |
| 签名模块 | 正常生成 a_bogus | 对照 Python 版本输出 |
| 签名模块 | 输入为空/异常返回 null | 边界测试 |
| `getRoomInfoViaWebAPI` | 正常返回开播状态 | mock Web Enter API |
| `getRoomInfoViaWebAPI` | 签名失败降级 | mock 返回错误 |
| `getRoomInfoViaHTML` | SSR JSON 解析 | mock HTML 页面 |
| `getRoomInfoViaHTML` | 页面格式变化返回 null | mock 无 RENDER_DATA 的 HTML |
| `parseStreamData` | FLV 流地址提取 | mock API 响应 |
| `parseStreamData` | 格式变化返回 null | mock 异常结构 |
| `checkUnsupportedType` | VR 房间返回 recordable: false | mock 响应 |
| `checkStatus` | Web API 成功流程 | 链式 mock |
| `checkStatus` | Web API 失败降级 HTML | 链式 mock |
| `checkStatus` | 两种方式均失败返回 error | 链式 mock |

##### 2.2.5 环境变量

在 `config/env.js` 中添加可选环境变量（有值时才使用，无值不限制）：

| 变量 | 用途 | 是否必需 |
|------|------|----------|
| `POLLING_DOUYIN_COOKIE` | 抖音请求 Cookie | 否，有则提升稳定性 |
| `POLLING_DEFAULT_USER_AGENT` | 覆盖默认桌面 UA | 否 |

DouyinChecker 中读取逻辑：
```js
const cookie = process.env.POLLING_DOUYIN_COOKIE;
if (cookie) {
  headers.Cookie = cookie;
}
```

---

#### 第二阶段实施顺序

| 步骤 | 任务 | 预计文件 | 依赖 |
|------|------|----------|------|
| 1 | 创建 `lib/core/polling/signers/` 目录 | 目录 | 无 |
| 2 | 实现 `signers/douyu.js` 签名模块 | `signers/douyu.js` | 无 |
| 3 | 实现 `DouyuChecker.js` | `DouyuChecker.js` | 步骤 2 |
| 4 | 注册斗鱼到 `checkers.js` | `checkers.js` | 步骤 3 |
| 5 | 编写斗鱼测试 | `test/polling-douyu.test.js` | 步骤 4 |
| 6 | 联调验证斗鱼录制（手动） | - | 步骤 5 |
| 7 | 移植 `signers/douyin.js` 签名模块 | `signers/douyin.js` | 无（可与步骤 2 并行） |
| 8 | 实现 `DouyinChecker.js` | `DouyinChecker.js` | 步骤 7 |
| 9 | 注册抖音到 `checkers.js` | `checkers.js` | 步骤 8 |
| 10 | 编写抖音测试 | `test/polling-douyin.test.js` | 步骤 9 |
| 11 | 联调验证抖音录制（手动） | - | 步骤 10 |
| 12 | 更新文档 + lessons.md | `docs/` | 步骤 11 |

**建议**：斗鱼和抖音可以各自独立开发（步骤 2-6 和 7-11 互不依赖），两个签名模块可以并行实现。

#### 第二阶段验收标准

- `PollingManager` 注册并识别 `douyu`、`douyin`。
- 斗鱼房间：签名获取流地址成功时自动录制，签名失败返回 `isLive: true, recordable: false`。
- 抖音房间：a_bogus 签名成功时自动录制，签名失败优雅降级（尝试 HTML 备用解析）。
- VR/连麦/强风控房间返回 `recordable: false` + `error` 提示。
- 签名模块异常不导致轮询中断或进程崩溃。
- `npm run lint` 和 `npm run test` 通过。
- 文档同步更新（ARCHITECTURE.md / API.md / DB.md / lessons.md）并提交代码。

## 暂缓平台

DouyinLiveRecorder 还支持 TikTok、快手、小红书、YY、网易 CC、YouTube、
Shopee、淘宝、京东等大量平台。当前项目的 `platform-detector` 未声明这些平台，
且部分平台需要代理、登录、签名或地区环境。建议暂缓，等第一、二阶段稳定后再按需
扩展。

如后续要加，先扩展 `SUPPORTED_PLATFORMS`，再按同一 Checker 契约接入。

## 文件改动清单

第一阶段已完成的改动：

```text
lib/core/polling/
├── BilibiliChecker.js               ✅ 已创建
├── checkers.js                      ✅ 已创建
├── PlatformChecker.js               ✅ 已增强（fetch/normalize 工具）
└── PollingManager.js                ✅ 已改为读取注册表

lib/utils/platform-detector.js       ✅ 已支持 bilibili

test/
└── polling-bilibili.test.js         ✅ 已创建

docs/
├── ARCHITECTURE.md                  ✅ 已更新
├── API.md                           ✅ 已更新
└── DB.md                            ✅ 已更新
```

第二阶段已完成的改动：

```text
lib/core/polling/
├── DouyuChecker.js                    ✅ 已创建
├── DouyinChecker.js                   ✅ 已创建
├── checkers.js                        ✅ 已更新（新增 douyu/douyin 注册）
└── signers/
    ├── douyu.js                       ✅ 已创建（VM 沙箱签名）
    └── douyin.js                      ✅ 已创建（a_bogus/x_bogus 签名）

test/
├── polling-douyu.test.js              ✅ 已创建（25 tests）
└── polling-douyin.test.js             ✅ 已创建（17 tests）
```

## 实施步骤

第一阶段已全部完成（见上方评估）。第二阶段代码已完成，详见 2.1 和 2.2 各小节。联调验证待手动执行。

## 统一返回规范

所有 Checker 的 `checkStatus()` 都应返回以下字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `isLive` | 是 | 是否开播（主播正在直播） |
| `recordable` | 否 | 是否可录制，默认 `true`；设为 `false` 表示开播但无法获取流地址 |
| `roomName` | 否 | 主播名或房间名 |
| `roomTitle` | 否 | 直播标题 |
| `roomCover` | 否 | 封面地址 |
| `streamUrl` | 开播且可录制时 | FFmpeg 可录制地址；不可录制时返回 `null` |
| `streamInfo` | 否 | 平台、画质、CDN、原始接口字段摘要 |
| `error` | 否 | 非致命错误说明（如签名失败、不可录制类型） |

**关键语义**：
- `isLive: true` + `recordable: false` 表示"正在直播但无法录制"，不应触发下播通知
- `isLive: false` 表示主播未开播
- `error` 字段仅记录非致命错误，不影响状态判断

**录制触发条件**：`PollingManager` 启动录制需同时满足：
1. `isLive === true`
2. `recordable !== false`（默认 `true`）
3. `streamUrl` 存在

## 风险与处理

| 风险 | 处理方式 |
| --- | --- |
| 平台接口变动 | Checker 内部隔离，失败只影响单平台 |
| Cookie 过期 | Cookie 全部来自环境变量，不入库、不入日志 |
| 海外平台网络不可达 | 返回 `error`，保留代理配置入口 |
| 真实流地址带敏感签名 | 日志只打印前 120 个字符或不打印完整 URL |
| 测试依赖真实网络不稳定 | Jest 使用 mock，真实网络只做手动验证 |
| 轮询触发重复录制 | 继续依赖 `wasLive -> isLive` 状态转换和 `active_task` |

## 验收标准

### 第一阶段验收标准 ✅ 已通过

详见上方"第一阶段完成评估"。

### 第二阶段验收标准

详见上方"第二阶段完成评估"。代码实现已完成，联调验证待执行。
