# 多平台轮询 Checker 开发方案

## 背景

当前 `lib/core/polling` 已实现 `HuyaChecker.js`，并通过
`PollingManager` 定时检测开播状态、写入 Redis 状态缓存、在开播时调用
`RecorderService.startRecording()` 自动录制。

本方案只纳入以下平台：

- `huya`
- `douyu`
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

### 第一阶段：建议立即实现

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

#### 斗鱼平台 (DouyuChecker)

##### 签名模块设计

斗鱼 H5 流地址需要签名参数，参考 `DouyinLiveRecorder/src/spider.py` 的 `get_token_js` 函数：

```javascript
// lib/core/polling/signers/douyu.js 架构
async function getSignParams(rid, did = '10000000000000000000000000003306') {
  // 1. 请求房间页面 https://www.douyu.com/{rid}
  // 2. 提取页面中的 JS 代码块（vdwdae325w_64we...ub98484234...）
  // 3. 使用 Node vm 模块执行 JS 获取 sign 参数
  // 4. 解析返回值获取 v, did, tt, sign
  // 5. 返回 { v, did, tt, sign }
}
```

**实现方案**：使用 Node.js 内置 `vm` 模块执行斗鱼页面中的 JS 函数 `ub98484234`，避免引入 `execjs` 等外部依赖。

**vm 执行安全约束**（必须遵守）：

1. **仅执行最小函数片段**：提取 `ub98484234` 函数后，移除 `eval` 调用和外层 `eval(...)` 包装，只执行签名核心逻辑
2. **设置超时**：vm script 执行超时上限 5 秒，超时则降级为 `error`
3. **禁用外部上下文**：使用 `vm.createContext()` 创建空上下文，阻止访问 `process`、`require`、`global` 等
4. **失败降级**：任何 vm 执行异常都返回 `error`，不影响其他房间轮询
5. **不信任远端代码**：页面 JS 仅用于签名参数计算，不应被用于任何写操作或网络请求

##### 关键 API

| 用途 | API | 认证 |
|------|-----|------|
| 房间状态检测 | `GET https://www.douyu.com/betard/{rid}` | 无需签名 |
| 流地址获取 | `POST https://www.douyu.com/lapi/live/getH5Play/{rid}` | 需要 sign |
| 流地址拼接 | `streamUrl = rtmp_url + '/' + rtmp_live` | - |

##### 流地址获取参数

```javascript
{
  v: '签名结果',
  did: '设备ID（固定值）',
  tt: '时间戳（秒）',
  sign: 'MD5签名',
  ver: '22011191',
  rid: '房间ID',
  rate: '0'  // 0蓝光、3超清、2高清、-1默认
}
```

##### 斗鱼风险处理

| 风险 | 处理方式 |
|------|----------|
| 签名 JS 更新 | Checker 返回 `error`，日志记录，不崩溃 |
| 签名有效期 10 分钟 | 每次请求前重新生成签名 |
| 短房间号解析 | 先请求 `https://m.douyu.com/{shortId}` 解析真实 rid |
| videoLoop=1（轮播） | 视为未开播 |

#### 抖音平台 (DouyinChecker)

##### 签名模块设计

抖音 Web 接口需要 `a_bogus` Anti-Bot 签名，参考 `DouyinLiveRecorder/src/spider.py` 和 `src/ab_sign.py`：

```javascript
// lib/core/polling/signers/douyin.js 架构
function generateABogus(queryString, userAgent) {
  // 1. 字符串处理和哈希计算
  // 2. Base64 编码
  // 3. 混淆处理
  // 4. 返回 a_bogus 签名字符串
}
```

**实现方案**：将 Python 的 `ab_sign.py` 移植为纯 Node.js 实现，不引入 headless browser。

##### 关键 API

| 用途 | API | 认证 |
|------|-----|------|
| Web Enter API | `GET https://live.douyin.com/webcast/room/web/enter/` | 需要 a_bogus |
| 状态判断 | `status === 2` 表示开播 | - |
| 流地址 | `stream_url.pull_datas` 或 `live_core_sdk_data` | - |

##### Web Enter API 请求参数

```javascript
{
  aid: "6383",
  app_name: "douyin_web",
  live_id: "1",
  device_platform: "web",
  language: "zh-CN",
  browser_language: "zh-CN",
  browser_platform: "Win32",
  browser_name: "Chrome",
  browser_version: "116.0.0.0",
  web_rid: "房间ID",
  msToken: "",
  a_bogus: "签名结果"
}
```

##### 抖音风险处理

| 风险 | 处理方式 |
|------|----------|
| a_bogus 签名失效 | 返回 `error`，日志记录，不崩溃 |
| VR/连麦/强风控房间 | 返回 `isLive: true, recordable: false, error: "不支持的直播类型"` |
| Cookie 缺失 | 支持但不强制配置（无 Cookie 可能受限） |
| 短链/分享链接 | 先解析为 `live.douyin.com/{web_rid}` 直链 |
| 页面解析备用 | Web Enter API 失败后尝试解析 HTML 内嵌状态 |

**注意**：不可录制的开播状态会触发开播通知，但不会启动录制。`PollingManager` 检测到 `recordable: false` 时会跳过录制但仍更新 Redis 缓存。

#### 第二阶段实施步骤

##### 第一步：实现斗鱼 Checker

1. 创建 `lib/core/polling/signers/douyu.js` 签名模块
2. 实现 `DouyuChecker.js`：
   - `canHandleUrl()` 支持 `douyu.com`
   - `checkStatus()` 实现房间状态和流地址获取
3. 注册到 `checkers.js`
4. 测试签名模块和 Checker

##### 第二步：实现抖音 Checker

1. 创建 `lib/core/polling/signers/douyin.js` 签名模块（移植 `ab_sign.py`）
2. 实现 `DouyinChecker.js`：
   - `canHandleUrl()` 支持 `live.douyin.com`
   - `checkStatus()` 实现 Web Enter API + HTML 备用解析
3. 注册到 `checkers.js`
4. 测试签名模块和 Checker

## 暂缓平台

DouyinLiveRecorder 还支持 TikTok、快手、小红书、YY、网易 CC、YouTube、
Shopee、淘宝、京东等大量平台。当前项目的 `platform-detector` 未声明这些平台，
且部分平台需要代理、登录、签名或地区环境。建议暂缓，等第一、二阶段稳定后再按需
扩展。

如后续要加，先扩展 `SUPPORTED_PLATFORMS`，再按同一 Checker 契约接入。

## 文件改动清单

第一阶段预计改动：

```text
lib/core/polling/
├── BilibiliChecker.js
├── checkers.js
├── PlatformChecker.js          # 增加通用 fetch/normalize 工具
└── PollingManager.js           # 使用 checkers.js 注册表

lib/utils/platform-detector.js  # 如需补充域名别名

test/
└── polling-bilibili.test.js

docs/
├── ARCHITECTURE.md             # 更新轮询架构支持平台
├── API.md                      # 更新 polling_platform 说明
└── DB.md                       # 更新 polling_platform 枚举说明
```

第二阶段预计新增：

```text
lib/core/polling/
├── DouyuChecker.js
├── DouyinChecker.js
└── signers/
    ├── douyu.js
    └── douyin.js

test/
├── polling-douyu.test.js
└── polling-douyin.test.js
```

## 实施步骤

### 第一步：整理 Checker 基础设施

1. 新增 `checkers.js` 注册表。
2. `PollingManager.getChecker()` 改为读取注册表。
3. `_extractStreamUrl()` 移除虎牙特判，改成按平台重新调用对应 Checker。
4. `PlatformChecker` 增加通用工具方法。

### 第二步：实现第一阶段平台

1. 实现 `BilibiliChecker`。
2. 保持单文件、低依赖、CommonJS。

### 第三步：补测试

测试不直接依赖真实平台网络，优先 mock `fetch`：

- URL 识别测试。
- 离线响应解析测试。
- 在线响应解析测试。
- API 异常/字段缺失测试。
- `PollingManager` 能从注册表找到对应 Checker。

可选增加手动联调脚本，但不作为 Jest 必跑项。

### 第四步：文档同步

更新：

- `docs/ARCHITECTURE.md`：轮询架构与支持平台。
- `docs/API.md`：`polling_platform` 支持值。
- `docs/DB.md`：`rooms.polling_platform` 说明。
- `docs/lessons.md`：记录平台风控、Cookie、签名相关踩坑。

### 实施优先级

斗鱼和抖音在第一阶段完成后再进入实施，优先级取决于实际使用需求：

1. 如果更需要国内平台覆盖，先做斗鱼。
2. 如果更需要抖音，先准备 Cookie/签名和真实样本房间。

#### 推荐排期

| 阶段 | 平台 | 原因 |
|------|------|------|
| 第一阶段 | B站 | 无需登录，实现简单 |
| 第二阶段第一批 | 斗鱼 | 实现复杂度适中，签名逻辑相对稳定 |
| 第二阶段第二批 | 抖音 | a_bogus 签名更新频繁，维护成本较高 |
| 后续 | 快手、TikTok、小红书 | 按实际房间需求扩展 |

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

### 第一阶段验收标准

- `PollingManager` 注册并识别 `huya`、`bilibili`。
- 这些平台的 URL 开启轮询后，不再出现"不支持的平台"。
- 开播状态转换能触发 `RecorderService.startRecording()`。
- 离线、接口异常、字段缺失不会中断轮询管理器。
- `npm run lint` 和 `npm run test` 通过。
- 文档同步更新并提交代码。

### 第二阶段验收标准

- `PollingManager` 注册并识别 `douyu`、`douyin`。
- 斗鱼房间支持签名获取流地址，未签名时返回 `error`。
- 抖音房间支持 a_bogus 获取流地址，签名失败时优雅降级。
- VR/连麦/强风控房间返回 `isLive: false` + `error` 提示。
- `npm run lint` 和 `npm run test` 通过。
- 文档同步更新并提交代码。
