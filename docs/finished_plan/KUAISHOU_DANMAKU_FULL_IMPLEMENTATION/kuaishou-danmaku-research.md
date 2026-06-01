# 快手直播弹幕数据源调研

> 调研时间: 2026-06-01
> 目标直播间: https://live.kuaishou.com/u/3xnz9vdnb22iw9e (liveStreamId: `NB7zMdDR8sY`)
> 调研方式: Playwright headless Chromium + 网络请求拦截 + JS Bundle 逆向分析

Ps. 由于该目标直播间没有一直在播，后续测试直播间改为：https://live.kuaishou.com/u/KPL704668133

## 结论

快手直播弹幕使用 **WebSocket + Protobuf** 协议，结构清晰，可对接。主要技术障碍是 `websocketinfo` 接口的反爬保护（`__NS_hxfalcon` 参数 + 验证码挑战）。

---

## 1. 通信架构

```
┌─────────────┐       HTTP GET        ┌──────────────────┐
│   Client    │ ────────────────────→  │  live.kuaishou.com │
│             │  websocketinfo API     │  /live_api/liveroom/ │
│             │ ←────────────────────  │  websocketinfo     │
│             │  返回 WebSocket URL[]  └──────────────────┘
│             │
│             │       WebSocket        ┌──────────────────┐
│             │ ←──────────────────→   │  WebSocket Server  │
│             │  Protobuf 编码消息     │  (wss://...)       │
└─────────────┘                        └──────────────────┘
```

## 2. 连接流程

### Step 1: 获取 WebSocket 连接信息

```
GET /live_api/liveroom/websocketinfo?liveStreamId=NB7zMdDR8sY&__NS_hxfalcon=...&caver=2
```

返回 JSON，包含 WebSocket URL 列表。客户端依次尝试连接，10 秒超时。

**注意**: 该接口有反爬保护，headless 浏览器访问会返回验证码：

```json
{ "data": { "result": 400002, "url": "https://captcha.zt.kuaishou.com/iframe/index.html?..." } }
```

### Step 2: 建立 WebSocket 连接

```javascript
new WebSocket(url); // url 来自 websocketinfo 响应
```

### Step 3: 进入直播间

客户端发送：

```json
{
  "type": "CS_ENTER_ROOM",
  "payload": {
    "liveStreamId": "NB7zMdDR8sY",
    "token": "<从 websocketinfo 获取>",
    "pageId": "<sessionStorage kslive.log.page_id>"
  }
}
```

### Step 4: 服务端确认

```json
{
  "type": "SC_ENTER_ROOM_ACK",
  "payload": {
    "heartbeatIntervalMs": 20000
  }
}
```

### Step 5: 心跳保活

每 20 秒发送一次：

```json
{
  "type": "CS_HEARTBEAT",
  "timestamp": 1717200000000
}
```

### Step 6: 接收弹幕推送

服务端持续推送 `SC_FEED_PUSH` 消息，包含弹幕、礼物、点赞等。

---

## 3. 消息类型完整列表

### 客户端 → 服务端 (CS\_)

| 消息类型                      | PayloadType ID | 用途         |
| ----------------------------- | -------------- | ------------ |
| `CS_HEARTBEAT`                | 1              | 心跳保活     |
| `CS_ERROR`                    | 3              | 错误上报     |
| `CS_PING`                     | 4              | Ping         |
| `CS_ENTER_ROOM`               | 200            | 进入直播间   |
| `CS_USER_PAUSE`               | 201            | 用户暂停     |
| `CS_USER_EXIT`                | 202            | 用户退出     |
| `CS_AUTHOR_PUSH_TRAFFIC_ZERO` | 203            | 主播推流中断 |
| `CS_HORSE_RACING`             | 204            | 赛马活动     |
| `CS_RACE_LOSE`                | 205            | 比赛失败     |
| `CS_VOIP_SIGNAL`              | 206            | 语音通话信号 |

### 服务端 → 客户端 (SC\_)

| 消息类型                                       | PayloadType ID | Protobuf 类型                | 用途                    |
| ---------------------------------------------- | -------------- | ---------------------------- | ----------------------- |
| `SC_HEARTBEAT_ACK`                             | 101            | —                            | 心跳响应                |
| `SC_ECHO`                                      | 102            | —                            | 回声                    |
| `SC_ERROR`                                     | 103            | —                            | 错误                    |
| `SC_PING_ACK`                                  | 104            | —                            | Ping 响应               |
| `SC_INFO`                                      | 105            | —                            | 信息                    |
| `SC_ENTER_ROOM_ACK`                            | 300            | —                            | 进入房间确认            |
| `SC_AUTHOR_PAUSE`                              | 301            | —                            | 主播暂停                |
| `SC_AUTHOR_RESUME`                             | 302            | —                            | 主播恢复                |
| `SC_AUTHOR_PUSH_TRAFFIC_ZERO`                  | 303            | —                            | 主播推流中断            |
| `SC_AUTHOR_HEARTBEAT_MISS`                     | 304            | —                            | 主播心跳丢失            |
| `SC_PIP_STARTED`                               | 305            | —                            | 画中画开始              |
| `SC_PIP_ENDED`                                 | 306            | —                            | 画中画结束              |
| `SC_HORSE_RACING_ACK`                          | 307            | —                            | 赛马响应                |
| `SC_VOIP_SIGNAL`                               | 308            | —                            | 语音通话信号            |
| **`SC_FEED_PUSH`**                             | **310**        | —                            | **弹幕/礼物/点赞 推送** |
| `SC_ASSISTANT_STATUS`                          | 311            | —                            | 助理状态                |
| `SC_REFRESH_WALLET`                            | 312            | —                            | 刷新钱包                |
| `SC_LIVE_CHAT_CALL`                            | 320            | —                            | 连麦呼叫                |
| `SC_LIVE_CHAT_CALL_ACCEPTED`                   | 321            | —                            | 连麦接受                |
| `SC_LIVE_CHAT_CALL_REJECTED`                   | 322            | —                            | 连麦拒绝                |
| `SC_LIVE_CHAT_READY`                           | 323            | —                            | 连麦就绪                |
| `SC_LIVE_CHAT_GUEST_END`                       | 324            | —                            | 连麦嘉宾结束            |
| `SC_LIVE_CHAT_ENDED`                           | 325            | —                            | 连麦结束                |
| `SC_RENDERING_MAGIC_FACE_DISABLE`              | 326            | —                            | 关闭魔法表情            |
| `SC_RENDERING_MAGIC_FACE_ENABLE`               | 327            | —                            | 开启魔法表情            |
| `SC_RED_PACK_FEED`                             | 330            | —                            | 红包推送                |
| `SC_LIVE_WATCHING_LIST`                        | 340            | —                            | 观看列表                |
| `SC_LIVE_QUIZ_QUESTION_ASKED`                  | 350            | —                            | 答题提问                |
| `SC_LIVE_QUIZ_QUESTION_REVIEWED`               | 351            | —                            | 答题审核                |
| `SC_LIVE_QUIZ_SYNC`                            | 352            | —                            | 答题同步                |
| `SC_LIVE_QUIZ_ENDED`                           | 353            | —                            | 答题结束                |
| `SC_LIVE_QUIZ_WINNERS`                         | 354            | —                            | 答题赢家                |
| `SC_SUSPECTED_VIOLATION`                       | 355            | —                            | 疑似违规                |
| `SC_SHOP_OPENED`                               | 360            | —                            | 商店开启                |
| `SC_SHOP_CLOSED`                               | 361            | —                            | 商店关闭                |
| `SC_GUESS_OPENED`                              | 370            | —                            | 竞猜开启                |
| `SC_GUESS_CLOSED`                              | 371            | —                            | 竞猜关闭                |
| `SC_PK_INVITATION`                             | 380            | —                            | PK 邀请                 |
| `SC_PK_STATISTIC`                              | 381            | —                            | PK 统计                 |
| `SC_RIDDLE_OPENED`                             | 390            | —                            | 猜谜开启                |
| `SC_RIDDLE_CLOESED`                            | 391            | —                            | 猜谜关闭                |
| `SC_RIDE_CHANGED`                              | 412            | —                            | 连击变化                |
| `SC_BET_CHANGED`                               | 441            | —                            | 投注变化                |
| `SC_BET_CLOSED`                                | 442            | —                            | 投注关闭                |
| `SC_LIVE_SPECIAL_ACCOUNT_CONFIG_STATE`         | 645            | —                            | 特殊账号配置            |
| `SC_LIVE_WARNING_MASK_STATUS_CHANGED_AUDIENCE` | 758            | —                            | 警告蒙版状态变化        |
| **`SC_COMMENT_ZONE_RICH_TEXT`**                | **829**        | `SCCommentZoneRichText`      | **富文本弹幕**          |
| `SC_INTERACTIVE_CHAT_CLOSED`                   | 776            | —                            | 互动聊天关闭            |
| `SC_INTERACTIVE_CHAT_SWITCH_BIZ`               | —              | `SCInteractiveChatSwitchBiz` | 互动聊天切换            |

### 弹幕相关的 Protobuf 消息类型

| Protobuf 类型            | 用途            |
| ------------------------ | --------------- |
| `WebCommentFeed`         | Web 端弹幕 Feed |
| `CommentRichTextMessage` | 富文本弹幕消息  |
| `SCCommentZoneRichText`  | 弹幕区域富文本  |
| `CSHeartbeat`            | 心跳消息        |

---

## 4. SC_FEED_PUSH 数据结构

`SC_FEED_PUSH` 是核心消息，payload 包含：

```javascript
{
  commentFeeds: [     // 弹幕列表
    {
      content: "弹幕内容",
      user: {
        userName: "用户名",
        principalId: "用户ID"
      },
      showType: 1,    // 1=普通弹幕, 2=被过滤
      // ... 其他字段
    }
  ],
  giftFeeds: [        // 礼物列表
    {
      giftName: "礼物名",
      giftId: "礼物ID",
      picUrl: "礼物图片",
      batchSize: 1,
      comboCount: 1,
      mergeKey: "...",
      user: { userName: "送礼用户" },
      // ... 其他字段
    }
  ],
  likeFeeds: [        // 点赞列表
    // ...
  ],
  displayLikeCount: 12345,     // 总点赞数
  displayWatchingCount: 678    // 观看人数
}
```

弹幕过滤逻辑（来自前端代码）：

- 过滤 `showType === 2` 的弹幕
- 过滤主播自己发送的弹幕（`userName === 主播名`）
- 过滤包含屏蔽词的弹幕
- 弹幕列表上限 200 条，超过后截取中间部分

---

## 5. 其他相关 API

| 接口                                             | 用途                                  |
| ------------------------------------------------ | ------------------------------------- |
| `GET /live_api/liveroom/websocketinfo`           | 获取 WebSocket 连接信息（**有反爬**） |
| `GET /live_api/liveroom/livedetail`              | 获取直播间详情                        |
| `GET /live_api/emoji/icon`                       | 表情图标列表                          |
| `GET /live_api/emoji/allgifts`                   | 全部礼物列表                          |
| `GET /live_api/emoji/gift-list?liveStreamId=XXX` | 当前直播间礼物列表                    |
| `GET /live_api/category/simple`                  | 分类列表                              |
| `GET /live_api/category/classify`                | 分类详情                              |
| `POST /live_api/liveroom/reco`                   | 推荐流                                |
| `POST /live_api/liveroom/recall`                 | 召回流                                |

API 路径映射（前端实际请求路径）：

```
/live_api/liveroom/websocketinfo  →  /rest/k/live/websocket/info
/live_api/liveroom/livedetail     →  /rest/k/live/detail
```

---

## 6. 反爬保护分析

### 问题

`websocketinfo` 接口使用了 `__NS_hxfalcon` 参数进行反爬保护。headless 浏览器访问时会被检测并返回验证码页面（result: 400002）。

验证码 URL 格式：

```
https://captcha.zt.kuaishou.com/iframe/index.html?captchaSession=...
```

### 可能的解决方案

1. **Chrome Extension 注入**: 复用用户已登录的浏览器环境，通过 content script 拦截 `websocketinfo` 响应，将 WebSocket 连接信息传递给后端
2. **Cookie 复用**: 使用用户登录态的 cookie 直接请求 `websocketinfo`，绕过 bot 检测
3. **Playwright stealth 模式**: 使用 `playwright-extra` + `stealth` 插件绕过 headless 检测
4. **直接拦截 WebSocket**: 在 Chrome Extension 中直接建立 WebSocket 连接，将弹幕数据转发到后端
5. **逆向 `__NS_hxfalcon`**: 分析反爬 JS 生成逻辑（复杂度高，不推荐）

### 推荐方案

**方案 4（Chrome Extension 拦截）** 最可靠：

- 用户已在浏览器中打开直播间，天然绕过反爬
- Chrome Extension 可直接获取 WebSocket 连接
- 与项目现有的 Chrome Extension 架构一致

---

## 7. 技术笔记

- 页面 JS Bundle 位于 `p2-game.kskwai.com/udata/pkg/KS-GAME-WEB/pc-live-next/js/`
- 核心逻辑在 `app.js`（204KB）和 `liveRoom.js`（88KB）中
- WebSocket 使用 protobuf.js 库进行消息序列化/反序列化
- 弹幕组件使用 CSS class `.danmaku`，有独立的弹幕速度控制和行管理逻辑
- `_SEND_DANMAKU_` 是页面内发送弹幕的全局事件（`window._SEND_DANMAKU_`）
- 消息格式为 JSON envelope 包裹 protobuf payload，`type` 字段为消息类型字符串

---

## 8. 与 Bilibili 弹幕方案对比

| 维度         | Bilibili                     | 快手                                         |
| ------------ | ---------------------------- | -------------------------------------------- |
| 协议         | WebSocket + Protobuf（全量） | WebSocket + JSON envelope + Protobuf payload |
| 认证         | 需要 token（游客可获取）     | 需要 token（有反爬保护）                     |
| 反爬         | 较弱，可直接调用 API         | 较强，`__NS_hxfalcon` + 验证码               |
| 弹幕获取难度 | 低                           | 中高                                         |
| 推荐接入方式 | 直接 WebSocket 连接          | Chrome Extension 转发                        |
