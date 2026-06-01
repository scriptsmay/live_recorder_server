# 快手直播弹幕录制项目 — 技术可行性评估

评估日期：2026-06-01
评估依据：`KUAISHOU_DANMAKU_RECORDING_PLAN.md`、`kuaishou-danmaku-research.md`、现有代码库结构

---

## 总体结论：技术可行，风险可控

计划文档的分析质量很高，技术路线选择合理。核心判断是 **Chrome Extension 拦截方案** 绕过了快手反爬保护，这是正确的方向。以下是逐项评估。

---

## 一、弹幕数据源（Chrome Extension 拦截）

### 可行性：高

现有 `chrome_live_listener` 扩展已具备以下基础架构：

- Manifest V3 结构，含 `content.js` + `background.js` 双进程模式
- 已有 `content.js` 通过 `chrome.runtime.sendMessage` 与 `background.js` 通信的链路
- `background.js` 已有通过 `fetch` POST 到后端 API 的能力（`sendToEnvironments` 方法）
- `host_permissions` 已包含 `*://*.kuaishou.com/*` 和后端地址

需要新增的部分：

1. **inject.js（World ISOLATED → MAIN）**：monkey-patch `WebSocket` 构造函数。这在 Chrome Extension 中是成熟技术，通过 `<script>` 标签注入到 `document.head` 即可在页面 MAIN world 中执行。没有技术障碍。

2. **postMessage 跨 world 通信**：inject.js（MAIN world）通过 `window.postMessage` 发消息，content.js（ISOLATED world）监听 `window.addEventListener('message')` 转发给 background.js。这也是标准做法。

3. **payload 格式待验证**（文档风险 #7）：这是**最大的不确定性**。调研文档提到消息格式为 "JSON envelope 包裹 protobuf payload"，但前端代码中直接访问 `payload.commentFeeds`（第 73 行），说明在 JS 层 payload 可能已经被解码为 JSON 对象。这有两种可能：
   - 页面 JS bundle 内部已经用 protobuf.js 解码了，inject.js 拦截到的是解码后的 JSON
   - 或者拦截点在解码之前，拿到的是二进制 ArrayBuffer

**建议**：Phase 1 第一步就是部署 inject.js 做 `console.log` 验证，这一步不超过半天。如果是 JSON，解析零依赖；如果是 protobuf binary，需要从页面 bundle 中提取 proto definition 文件。两种方案都不构成阻塞。

> **2026-06-01 实机验证结果**：所有 WebSocket 消息均为 ArrayBuffer（纯 protobuf binary），不存在 JSON envelope。inject.js 通过 prototype-level hook（`EventTarget.prototype.addEventListener` + `WebSocket.prototype.onmessage`）在页面 JS 解码器之前拦截原始二进制数据。最终方案为 inject.js 内置零依赖 protobuf wire format 解码器（~150 行），无需 protobufjs，也无需提取 proto 定义文件。

### 潜在问题

- **Manifest V3 Service Worker 休眠**：`background.js` 是 service worker，可能被浏览器休眠。但现有代码已有心跳保活机制（content.js 每 3 秒发消息），弹幕数据推送本身也会唤醒 service worker。5 秒批量推送的频率足以维持活跃。
- **WebSocket 拦截时机**：monkey-patch 必须在 WebSocket 连接建立之前完成。快手页面的 WebSocket 连接通常在页面加载早期建立，inject.js 使用 `"run_at": "document_start"` 可确保在页面脚本之前执行。

---

## 二、后端接收与弹幕录制

### 可行性：高

计划中新增的 `POST /api/danmaku/batch` 接口与现有架构完全兼容：

- 现有系统已有 Express router 结构（`router/index.js` 做路由挂载）
- PostgreSQL 连接池（`db/index.js`）和 Redis（`db/redis.js`）已就位
- `recording_sessions` 表已存在，可关联弹幕录制记录
- 会话目录结构 `VIDEO_DOWNLOAD_DIR/[roomId]/[sessionId]/` 已确立

`DanmakuRecorder.js` 的核心职责（接收批量数据 → 写入 JSONL → 写入数据库）是简单的 IO 操作，没有技术难点。

### 需要注意的点

- **时间同步**：Extension 侧使用浏览器时间戳，后端使用服务器时间。弹幕的 `ts_ms` 应基于"录制会话开始时间"的相对偏移，而不是绝对时间。文档已经考虑到这一点（第 117-120 行），方案正确。
- **去重与乱序**：WebSocket 重连可能导致弹幕重复推送。建议在 `DanmakuRecorder` 中做简单的去重（基于 `mergeKey` 或 content+user+timestamp 的 hash）。

---

## 三、ASS 生成

### 可行性：高

ASS 是纯文本格式，生成器是确定性的字符串模板操作。没有外部依赖。

计划中提到的规则（字符转义、密度限制、轨道分配、时间偏移）都是可实现的算法问题，不涉及不可控的外部因素。

需要注意：

- **中文字体渲染**：ASS 文件本身不包含字体，只是指定字体名称。最终渲染依赖 FFmpeg 的 libass 和系统 fontconfig。文档在 Docker 部分已经考虑到安装 `fonts-noto-cjk`，方案完整。
- **ASS 特效代码**：滚动弹幕用 `\move()` 标签，固定位置用 `\pos()` 标签。这些是 ASS 标准语法，libass 完全支持。

---

## 四、分段录制适配

### 可行性：中高

这是文档中**设计最复杂**的部分，但方案合理。

核心挑战是分段时间轴的精确对齐。文档给出了优先级排序（第 197-204 行）：

1. 真实分段打开时间（需要补充记录）
2. segment_index \* segment_duration 估算
3. 文件名时间解析
4. ffprobe 时长累加

这个优先级排序是务实的。第一优先级需要修改录制流程来记录 `segment_start_ms` / `segment_end_ms`，这是**唯一需要修改现有录制核心逻辑**的地方。

**风险点**：当前 `recording_files.started_at` / `ended_at` 是看门狗写入的发现/入库时间，不等于 FFmpeg 开始写分段的时间。文档已经识别了这个问题（第 204 行），并建议补充字段。这是正确的做法。

**建议补充**：如果是 FFmpeg `-strftime 1` 生成文件名（如 `20260531_200000.ts`），解析文件名时间是最可靠的方案，应该提升到优先级 1.5（仅次于真实记录时间）。

---

## 五、弹幕压制队列

### 可行性：高

`DanmakuBurnQueue.js` 可以复用 `TranscodeQueue.js` 的设计模式：

- Redis LIST 作为队列（`danmaku_burn_queue`）
- Redis 计数器控制并发（`danmaku_burn_processing_count`）
- PostgreSQL 记录表（`danmaku_burn_records`）跟踪状态

现有 `TranscodeQueue.js` 有 355 行成熟代码，包括并发控制、失败处理、记录更新等完整逻辑。`DanmakuBurnQueue` 可以直接参考其架构，开发量主要是差异化逻辑（FFmpeg 命令不同、输入输出路径不同）。

### FFmpeg 压制

CPU 编码命令（`libx264`）是确定可行的。QSV/VAAPI 需要 Docker 容器透传 `/dev/dri`，这取决于飞牛 NAS 的配置，不是代码层面的问题。

文档中提到的注意事项（第 289-293 行）都是正确的：

- `subtitles` 滤镜不能与 `-c:v copy` 同时使用
- 字幕渲染本身可能走 CPU
- Docker 镜像需要包含中文字体、fontconfig、libass

**性能预估**：N100（4 核 4 线程，最高 3.4GHz）用 `libx264 -preset veryfast` 压制 1080p 视频，预计速度在 0.3x-0.8x 实时之间，取决于视频复杂度和弹幕密度。文档的验收标准（不低于 0.5x）是合理的，但可能需要 QSV 才能稳定达到。

---

## 六、数据库设计

### 可行性：高

两张新表（`danmaku_capture_records`、`danmaku_burn_records`）和 `recording_files` 的扩展字段都是常规的 DDL 操作。

建议：

- `danmaku_capture_records.session_id` 应该加外键约束 `REFERENCES recording_sessions(id) ON DELETE CASCADE`，保持与现有表的一致性
- `event_count` 字段建议使用 `BIGINT` 而非 `INTEGER`，长时间直播可能超过 20 亿条弹幕事件（虽然不太可能，但防御性设计）

---

## 七、开发工作量评估

文档的阶段拆分和时间估算是合理的：

| 阶段   | 内容             | 预估   | 评估                                |
| ------ | ---------------- | ------ | ----------------------------------- |
| 阶段 0 | 可行性验证       | 已完成 | 已完成，质量良好                    |
| 阶段 1 | 弹幕录制基础链路 | 2-4 天 | 合理，inject.js 验证可能额外 0.5 天 |
| 阶段 2 | ASS 生成         | 1-2 天 | 合理                                |
| 阶段 3 | 弹幕压制队列     | 2-4 天 | 合理，含性能测试                    |
| 阶段 4 | 自动化与集成     | 1-3 天 | 合理                                |

**总工作量**：6.5-13.5 天。考虑调试和验证时间，建议预留 **2-3 周**。

---

## 八、风险汇总与应对

| 风险                            | 等级 | 评估                                                           |
| ------------------------------- | ---- | -------------------------------------------------------------- |
| SC_FEED_PUSH payload 格式待验证 | ~~中~~ ✅ 已解决 | 确认 protobuf binary，inject.js 自实现解码器已解决 |
| 快手协议变更                    | 中   | Extension 被动监听，协议变更影响与页面同步，用户反馈后即可感知 |
| N100 性能不足                   | 中   | 并发固定 1 + 自动压制默认关闭 + 夜间窗口，可缓解               |
| 存储膨胀                        | 低   | 已有应对策略（保留开关、清理策略）                             |
| FFmpeg 字幕滤镜兼容性           | 低   | Docker 镜像可控，启动时能力检查                                |
| 时间同步偏移                    | 低   | 方案已有完整应对（相对时间、手动偏移调整）                     |

---

## 九、与现有代码的集成度评估

现有代码库为弹幕功能提供了良好的集成基础：

- **TranscodeQueue.js**：弹幕压制队列可以复用其 Redis 队列模式、并发控制、数据库记录模式
- **RecorderService.js**：`finishSession` 方法是弹幕压制自动入队的自然触发点
- **RecordingManager.js**：`addTranscodeQueue` 方法的模式可以直接复制到 `addDanmakuBurnQueue`
- **db/migrate.js**：迁移脚本模式成熟，新增表和字段可直接追加
- **chrome_live_listener**：现有扩展的 content.js → background.js 通信链路、fetch POST 到后端的能力、service worker 心跳保活机制，都可以直接复用

需要新增的核心模块不多，主要是：

1. `inject.js`（约 50-80 行 WebSocket monkey-patch）
2. `danmaku-parser.js`（约 100-200 行消息解析）
3. `DanmakuRecorder.js`（约 150-250 行数据接收和写入）
4. `DanmakuAssGenerator.js`（约 200-400 行 ASS 模板生成）
5. `DanmakuBurnQueue.js`（约 200-300 行，参考 TranscodeQueue.js）
6. `danmaku-burner.js`（约 50-100 行 FFmpeg 命令封装）

总新增代码量约 750-1330 行，加上页面和 API 改动，总体可控。

---

## 十、建议

1. **阶段 1 最先做的事情**：部署 inject.js 到 chrome_live_listener，打开一个快手直播间，验证是否能拦截到弹幕数据并打印到 console。这是整个项目的第一个关键验证点，应该在所有后端开发之前完成。

2. **~~payload 格式确认后~~**（已解决）：~~如果是 protobuf binary，优先从页面 JS bundle 中提取 proto definition，引入 `protobufjs`~~ → 实际方案为 inject.js 内置零依赖 protobuf wire format 解码器，不依赖 protobufjs 或外部 proto 定义文件。

3. **分段时间记录**：建议在阶段 1 同步修改录制流程，记录分段真实打开时间。这样后续 ASS 生成和压制都不需要兜底估算。

4. **Docker 镜像先准备好**：在阶段 3 之前，确保 FFmpeg 镜像包含 `libass`、`fontconfig`、`fonts-noto-cjk`，并验证 `subtitles` 滤镜可用。不要等到压制代码写完才发现镜像缺少依赖。

5. **保持解耦**：文档的开发建议（第 630 行）非常重要——弹幕失败只影响弹幕产物，不影响原始视频、转码、HLS 和投稿。这个原则在整个开发过程中应严格遵循。
