# 开发踩坑记录

## 开发环境怎么杀死进程

```bash
lsof -ti :3001 | xargs kill -9 2>/dev/null; sleep 1; echo "已停止旧进程"
```

## docker 镜像中，含有中文的文件名似乎不被biliup能识别，从而导致无法上传【已解决】

已解决，在 Dockerfile 中添加：

```dockerfile
# 设置环境变量，强制系统使用 UTF-8
ENV LANG C.UTF-8
ENV LC_ALL C.UTF-8
```

已部署的 docker-compose.yml 中添加环境变量:

```yml
services:
  your-service-name:
    image: your-image-name
    # 添加以下环境变量配置
    environment:
      - LANG=C.UTF-8
      - LC_ALL=C.UTF-8
    # 其他配置...
    volumes:
      - /path/on/host:/data/video_downloads
```

## 集中式转码的延迟问题与边下边转码方案

### 背景

4小时直播可能产生240个分片，早期方案是录制结束后集中转码，需要8-20分钟，用户体验差，CPU资源利用不均。

### 问题链

```
录制结束 → 240个FLV分片 → 集中转码（8-20分钟）
  → 用户无法立即操作文件
  → CPU前期闲置，最后集中峰值
  → 一个分片失败导致整体失败
```

### 方案一：流式转码架构（TranscodeQueue）- 第一阶段

- 每个分段完成时自动入队 Redis
- 后台异步处理（控制并发数 = 固定值，默认3）
- 转码与录制并行，压力分散

**收益**:

- 用户体验从 ⭐⭐ 升至 ⭐⭐⭐
- 长直播完成后立即可操作（不必等全部转码完）
- 磁盘/CPU 压力均衡分散
- 单个分片失败不影响其他

### 方案二：完全依赖看门狗处理 - 第二阶段

**核心问题**:

- 早期方案虽然在录制结束时主动扫描并入队转码
- 但代码复杂，交互频率高
- 每个文件都需要等待和多次数据库操作

**简化方案**:

- 录制结束时**不做任何转码处理**
- 所有转码完全由看门狗统一处理
- 降低刚结束会话的稳定性要求（30秒而不是2分钟）

**实现要点**:

1. **看门狗稳定性检查优化**

   ```javascript
   // 判断会话是否刚结束（5分钟内）
   const isRecentlyEnded = room.ended_at && Date.now() - new Date(room.ended_at).getTime() < 300000;

   // 刚结束的会话使用30秒稳定性检查
   const stabilityMs = isRecentlyEnded ? RECENTLY_ENDED_MS : STABILITY_MS;
   ```

2. **录制结束时的职责简化**
   - 只更新会话状态和统计信息
   - 只处理碎片文件清理
   - **不涉及任何转码逻辑**

**完整流程**:

```
录制结束
  ↓
_handleSegmentFinish()
  ├─ 更新会话状态为 completed
  ├─ 统计文件数量和大小
  └─ 清理碎片文件（< 10MB）
  ↓
看门狗扫描（每30秒）
  ├─ 查询刚结束的会话（5分钟内）
  ├─ 稳定性检查：30秒（而不是2分钟）
  └─ 发现稳定文件 → 加入转码队列
  ↓
转码队列并行处理
```

**方案优势**:

| 特性           | 说明                            |
| -------------- | ------------------------------- |
| **代码极简**   | 录制结束时不涉及任何转码逻辑    |
| **零额外等待** | 不需要在录制结束时等待文件稳定  |
| **统一时机**   | 所有转码由看门狗统一触发        |
| **合理延迟**   | 最后一个分片约30-60秒后开始转码 |
| **低交互**     | 避免频繁的数据库操作和文件扫描  |

**延迟分析**:

最后一个分片的转码延迟 = 看门狗扫描间隔（30秒）+ 稳定性检查（30秒）= **最多60秒**

这个延迟对于用户体验来说是可以接受的，相比代码复杂度的降低，完全值得。

**与之前方案对比**:

| 特性             | 方案一（主动扫描）     | 方案二（看门狗）   |
| ---------------- | ---------------------- | ------------------ |
| 代码复杂度       | 高                     | **极简**           |
| 交互频率         | 高（每文件多次DB操作） | **低**（统一扫描） |
| 最后一个分片延迟 | 约5秒                  | **约60秒**         |
| 碎片文件处理     | 录制结束时处理         | 看门狗处理         |
| 可维护性         | 复杂                   | **简单**           |

## 架构设计原则：磁盘文件全权交给看门狗

### 核心思想

**系统的业务逻辑中只处理数据库、Redis 等元数据，而对磁盘文件的处理（增删改）全权交给看门狗定期扫描。**

### 设计背景

视频文件具有以下特性：

- **大文件**：通常几百MB到几GB
- **实时性要求低**：录制完等几秒不影响用户体验
- **相对稳定**：一旦写入，很少修改

这些特性决定了视频文件适合**批量、定期处理**，而不是实时响应。

### 权责分离矩阵

| 操作           | 业务逻辑层 | 看门狗 |
| -------------- | ---------- | ------ |
| 创建会话       | ✅         | ❌     |
| 更新会话状态   | ✅         | ❌     |
| Redis 缓存管理 | ✅         | ❌     |
| 触发转码队列   | ✅         | ❌     |
| 扫描磁盘文件   | ❌         | ✅     |
| 文件入库       | ❌         | ✅     |
| 清理碎片文件   | ❌         | ✅     |
| 标记文件完成   | ❌         | ✅     |
| 同步文件状态   | ❌         | ✅     |

### 设计优势

| 优势           | 说明                                       |
| -------------- | ------------------------------------------ |
| **关注点分离** | 业务层只关心"有没有文件"，不关心文件在哪里 |
| **解耦**       | 文件操作和业务逻辑完全分离                 |
| **性能优化**   | 批量处理文件，减少磁盘I/O和数据库连接      |
| **一致性**     | 统一的地方处理文件，避免遗漏或重复         |
| **错误隔离**   | 磁盘I/O失败不会影响业务逻辑执行            |
| **可维护性**   | 文件处理逻辑集中，便于理解和调试           |

### 架构图示

```
┌─────────────────────────────────────────────────┐
│         业务逻辑层（RecorderService）            │
│  ┌─────────────────────────────────────────┐   │
│  │  职责：只关心"业务状态"                  │   │
│  │  ├─ 会话生命周期管理                      │   │
│  │  ├─ 数据库元数据操作                      │   │
│  │  ├─ Redis 缓存管理                       │   │
│  │  └─ 触发转码队列（但不入库文件）          │   │
│  │                                          │   │
│  │  ❌ 不直接操作磁盘文件                    │   │
│  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
                        ↓ 触发
                        ↓ 观察
┌─────────────────────────────────────────────────┐
│           看门狗层（Watchdog）                   │
│  ┌─────────────────────────────────────────┐   │
│  │  职责：全权负责磁盘文件                   │   │
│  │  ├─ 定期扫描目录                          │   │
│  │  ├─ 发现文件 → 入库                       │   │
│  │  ├─ 标记文件完成                          │   │
│  │  ├─ 清理碎片文件                          │   │
│  │  └─ 同步文件状态                          │   │
│  │                                          │   │
│  │  ✅ 业务层不知道文件在哪里                │   │
│  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

### 设计原则总结

1. **业务层不管文件，只管状态**
2. **看门狗统一处理所有文件操作**
3. **视频文件适合批量、定期处理**
4. **性能问题用异步队列解决，不是用实时处理**

### 经验教训

❌ **避免**：在业务逻辑中直接操作磁盘文件

```javascript
// 错误示例
downloader.on('segment', async (filePath) => {
  await fs.stat(filePath);      // 直接操作磁盘
  await pool.query(...);       // 立即入库
  await transcodeQueue.enqueue(...);
});
```

✅ **推荐**：业务层触发，看门狗统一处理

```javascript
// 业务层：只管会话状态，文件入库全权交给看门狗
// downloader.on('segment', async (filePath) => {
//   console.log(`[RecorderService] 监测到文件切片: ${filePath}`);
// });

// 看门狗：统一处理文件
async function scanActiveSegments() {
  // 批量扫描目录
  // 发现文件后入库
  // 触发转码队列
}
```

### 最终代码架构

#### 业务逻辑层（RecorderService）职责

- ✅ 管理会话生命周期（创建、更新状态）
- ✅ 操作数据库（recording_sessions、rooms 等）
- ✅ 管理 Redis 缓存
- ✅ 触发转码队列
- ❌ **不**监听 segment 事件
- ❌ **不**插入文件记录

#### 看门狗层（Watchdog）职责

- ✅ 定期扫描磁盘目录
- ✅ 发现文件并入库（recordings、recording_files）
- ✅ 标记文件完成
- ✅ 清理碎片文件
- ✅ 触发自动投稿

### 经验总结

| 教训                     | 说明                                                 |
| ------------------------ | ---------------------------------------------------- |
| **异步队列解耦耗时操作** | 使用 Redis 队列将转码从主流程中解耦，提升响应速度    |
| **并发控制要可配置**     | 通过 `transcode_concurrency` 设置适配不同服务器配置  |
| **监听子进程输出**       | 解析 FFmpeg 等外部进程的 stderr 可以获取关键状态变更 |
| **双重保障机制**         | 主流程 + 兜底流程配合，确保无遗漏                    |
| **错误隔离提升稳定性**   | 单个分片转码失败不影响其他分片，避免级联失败         |
| **避免处理正在写入文件** | 通过状态跟踪，等新分段打开时再处理上一个完成的分段   |
| **接口入参先归一化类型** | HTTP 入参常为字符串，和数据库数字 ID 比较前应先转换  |

## 录制中断处理的设计理念

### 核心原则

**文件永远应该是从录制开始那一刻新生成的，即使遇到网络抖动等因素的直播中断，也应该被准确处理，而不是简单粗暴的合并文件。**

### 设计背景

FFmpeg 不支持直播流的文件续传功能：

- 直播流是实时的，服务器不会保留之前的流数据
- 重新连接只能从当前时间点获取流，无法"记住"之前写入到哪里
- 因此，即使技术上能续写同一个文件，中间缺失的部分也无法找回

### 正确的设计实现

#### 1. 文件名包含精确到秒的时间戳

```javascript
// tool.js
const vars = {
  room_name: sanitizeFilename(roomName || 'unknown'),
  datetime: dateObj.format('YYYYMMDD_HHmmss'), // 20240520_143052
  // ...
};
```

#### 2. 每次录制都是全新的文件

```javascript
// RecorderService.js - startRecording()
const sessionStart = new Date();  // 每次录制都是新的时间点
const outputFilePattern = this.generateOutputPath(downloader, template, ..., sessionStart, ...);
```

#### 3. 会话复用只是数据库层面的概念

```javascript
// finishSession() 中的处理逻辑
if (reuseSession) {
  // 累加到现有会话的统计（只是数据库统计）
  ((total_segments = total_segments + $2), (total_size = total_size + $3));
} else {
  // 创建新的会话记录
  ((total_segments = $2), (total_size = $3));
}
```

### 实际效果示例

```
14:30:52 - 网络抖动，第一次录制结束 → 生成 room_20240520_143052.flv
14:31:05 - 恢复录制，第二次录制开始 → 生成 room_20240520_143105.flv
14:32:30 - 再次抖动，第三次录制结束 → 生成 room_20240520_143230.flv
```

- 三个文件**物理独立**，保留原始录制数据
- 数据库层面归到同一个"会话"，方便管理
- **绝不合并文件**，保证数据完整性

### 设计优势

| 优势           | 说明                                         |
| -------------- | -------------------------------------------- |
| **数据完整性** | 保留每个时间点的完整原始数据，不伪造缺失部分 |
| **清晰可追溯** | 用户可以清晰看到录制的时间线和中断点         |
| **无副作用**   | 不做有损的文件合并，避免引入伪数据           |
| **简单可靠**   | 避免复杂的文件追加逻辑，降低出错概率         |
| **便于修复**   | 如果某个分段损坏，其他分段不受影响           |

### 错误的设计方式

❌ **不要**尝试续传同一个小文件

- 中间缺失的数据无法找回，续写的内容会与原文件时间不连续
- FFmpeg 无法合并两个时间不连续的视频流
- 强行合并会产生播放时的时间跳跃或音画不同步

❌ **不要**合并多个分段为一个文件

- 网络抖动期间的数据丢失会"被消失"
- 用户误以为获得了完整内容，实际上中间可能有几分钟的空白
- 不利于后期修复和定位问题

## 自动投稿触发机制

### 设计决策

**录制结束时不应立即尝试自动投稿，应该完全依赖看门狗定期扫描。**

### 原因

1. **避免竞态条件**
   - 录制结束时，FFmpeg 进程刚关闭
   - 但转码队列可能还在处理其他分段
   - 边下边转码的最后一个分段可能还在队列中

2. **第一次调用几乎总是失败**

   ```javascript
   // 录制结束时调用 findAndAutoUpload()
   if (!(await isSessionTranscodeComplete(session.id))) {
     // 转码未完成 → 立即 return
     return;
   }
   ```

   - 几乎总是因为"转码未完成"而立即返回
   - 产生无意义的日志噪音

3. **看门狗已经足够**
   - 每30秒扫描一次，时间窗口合理
   - 能够覆盖所有场景
   - 简单可靠，无竞态风险

### 实际实现

**唯一触发点：看门狗定期扫描**

```javascript
// watchdog.runWatchdog() - 每30秒执行
async function runWatchdog() {
  await scanActiveSegments(); // 扫描并标记完成文件
  await cleanupFragmentFiles(); // 清理碎片文件
  await syncMissingFiles(); // 同步缺失文件
  await UploadService.scanPendingAutoUpload(); // 自动投稿
}
```

**扫描条件（7天内的会话）**：

1. ✅ `status = 'completed'`
2. ✅ `upload_template_id IS NOT NULL`
3. ✅ 无 `uploading`/`success` 的记录（避免重复）
4. ✅ 转码全部完成（无待转 FLV、无队列任务）

### 设计优势

| 优势         | 说明                                     |
| ------------ | ---------------------------------------- |
| **无竞态**   | 转码队列和投稿完全解耦，不会出现竞态条件 |
| **简单可靠** | 单一触发点，易于理解和维护               |
| **及时响应** | 看门狗30秒扫描，能及时发现可投稿的会话   |
| **避免重复** | 统一检查机制，防止重复投稿               |

## 斗鱼直播流录制

> **✅ 状态：可用**（2026-05-28 修复）

### 历史演进

| 阶段   | 方案                                | 状态              |
| ------ | ----------------------------------- | ----------------- |
| v1     | `ub98484234.js` + VM 沙箱执行       | ❌ 前端 JS 已 404 |
| v2     | `hlsH5Preview` API + 简化 MD5 签名  | ❌ API 已废弃     |
| v3     | `getEncryption` + `hlsH5Preview`    | ❌ 鉴权失败       |
| **v4** | **`getEncryption` + `getH5PlayV1`** | **✅ 当前方案**   |

### 问题排查过程（2026-05-28）

**现象**：直播间 `https://www.douyu.com/1863767` 无法录制，不走 VIP 签名 2 分钟切断，走 VIP 签名直接报错。

**排查步骤**：

1. **VIP 签名失效**：`https://www.douyu.com/ub98484234.js` 返回 404，斗鱼已全面迁移到 Next.js 架构，旧签名 JS 不复存在
2. **旧 API 废弃**：`hlsH5Preview` 返回 `{"error":2005,"msg":"鉴权失败"}`
3. **逆向新版加密 JS**：分析 `web-encrypt-*.js`（18KB minified），发现新 API 端点为 `getH5PlayV1`
4. **UA 不匹配**：`getSignParams` 用 `getOptimalUserAgent()`（Mac Chrome）生成 `enc_data`，但 `_fetchStreamUrl` 硬编码 Windows UA。**斗鱼服务端现在校验 `enc_data` 中的 UA 与请求头 UA 是否一致**，不一致返回 403

### 当前签名方案

签名算法不变（`getEncryption` → MD5 迭代），但 API 端点和请求格式有变化：

```js
// 1. 获取加密密钥（不变）
const { key, rand_str, enc_time, enc_data } = await fetch(
  'https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption?did=xxx'
);

// 2. MD5 签名（不变）
let secret = rand_str;
for (let i = 0; i < enc_time; i++) secret = md5(secret + key);
const auth = md5(secret + key + rid + ts);

// 3. 请求流地址（端点和格式变了！）
//    旧: POST /lapi/live/hlsH5Preview/{rid}
//    新: POST /lapi/live/getH5PlayV1/{rid}
const body = [
  `enc_data=${enc_data}`, // 签名参数在前
  `tt=${ts}`,
  `did=${did}`,
  `auth=${auth}`,
  'cdn=hw-h5', // 其他参数在后
  'ver=Douyu_new',
  'rate=0',
  // ... 不再传 rid（在 URL 中）
].join('&');

// 4. UA 必须与 getEncryption 请求时一致！
const streamUrl = `${rtmp_url}/${rtmp_live}`;
```

### 关键踩坑点

1. **`enc_data` 绑定 UA**：`getEncryption` 返回的 `enc_data` 中包含请求时的 User-Agent，后续 `getH5PlayV1` 请求必须使用相同 UA，否则返回 403
2. **请求体格式**：签名参数（`enc_data`/`tt`/`did`/`auth`）必须放在其他参数前面
3. **`rid` 不在 body 中**：新版 API 只从 URL 路径读取 `rid`，body 中传 `rid` 会导致鉴权失败
4. **VIP 签名已废弃**：`ub98484234.js` 返回 404，`douyu-vip.js` 不再被引用

### 架构说明

```
signers/douyu.js          # 签名算法（getEncryption + MD5）
signers/douyu-vip.js      # [已废弃] ub98484234 VM 沙箱签名
DouyuChecker.js           # 平台检查器（调用签名 + 请求流地址）
```

### 经验总结

1. **平台 API 变更要及时跟进**：斗鱼从传统 SPA 迁移到 Next.js，大量旧 API 和前端 JS 失效
2. **逆向加密 JS 是最后手段**：通过分析 minified JS 中的关键词（API 端点、参数名）定位变更点，比完整逆向高效
3. **UA 一致性是隐性鉴权**：`enc_data` 绑定了 UA，两端必须一致——这类问题在文档中不会说明，只能通过对比实际请求发现
4. **保留旧签名代码**：`douyu-vip.js` 虽然废弃，但保留作为参考，万一斗鱼恢复类似机制

## FFmpeg subtitles 滤镜依赖 libass（Homebrew 踩坑）

### 现象

弹幕压制 FFmpeg 命令执行失败，退出码 234：

```
[AVFilterGraph] No option name near '/path/to/file.ass'
[AVFilterGraph] Error parsing filterchain 'subtitles='/path/to/file.ass'' around:
Error opening output files: Invalid argument
```

报错完全看不出是依赖缺失，误导排查方向到路径转义问题上。

### 根因

Homebrew 官方 bottled FFmpeg **不编译 libass**，`subtitles` 和 `ass` 滤镜根本不存在。FFmpeg 把未知的滤镜名当作 filtergraph 语法来解析，产出 "No option name near" 这种极具误导性的错误。

**Docker 环境不受影响**：Debian bookworm 的 `apt install ffmpeg` 自带 `libass9`，subtitles 滤镜开箱即用。

### 解决方案

macOS 开发环境使用 homebrew-ffmpeg tap（默认含 libass）：

```bash
brew uninstall ffmpeg
brew tap homebrew-ffmpeg/ffmpeg
brew install homebrew-ffmpeg/ffmpeg/ffmpeg
```

### 代码防御

在 `danmaku-burner.js` 的 `burn()` 方法入口增加了 `probeCapabilities()` 缓存检查：

```javascript
const caps = await this._getCapabilities();
if (!caps.subtitlesFilter) {
  return {
    success: false,
    outputPath,
    duration: 0,
    error:
      'FFmpeg 未编译 libass，subtitles 滤镜不可用。请安装带 libass 的 FFmpeg（brew install homebrew-ffmpeg/ffmpeg/ffmpeg）',
    logPath: null,
  };
}
```

`_getCapabilities()` 首次调用后缓存结果，后续压制不再重复 fork FFmpeg。

### 经验总结

| 教训                                    | 说明                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| **FFmpeg 报错不等于语法错**             | "Error parsing filter description" 可能是滤镜不存在，不是参数写错了     |
| **先验证工具能力再排查代码**            | `ffmpeg -filters                                                        | grep subtitle` 一行命令就能定位，却浪费了两轮在路径转义上 |
| **Homebrew 和 Debian 的 FFmpeg 差异大** | Homebrew bottled 版砍掉了 libass 等非核心依赖，Debian 包反而更完整      |
| **代码层做能力检查**                    | 不要假设 FFmpeg 一定有某个滤镜，启动时探测 + 友好报错能节省大量排查时间 |

## Docker 容器中 biliup 投稿失败排查【已解决】

### 现象

自动投稿一直失败，biliup 日志无输出或报权限错误。

### 排查过程

1. **biliup 命令找不到**：`uv tool install biliup` 将二进制安装到 `/root/.local/share/uv/tools/biliup/bin/`，但容器以非 root 用户运行时 PATH 中没有此路径。通过 `BILIUP_PATH` 环境变量或创建 `/usr/local/bin/biliup` 软链接解决。

2. **上传锁权限错误**：biliup（Rust 二进制）通过 `dirs::data_local_dir()` 获取锁文件目录，在 Linux 下返回 `$HOME/.local/share/biliup/locks/`。当容器使用 `gosu` 降权时，`HOME` 环境变量仍指向 `/root`，非 root 用户无权写入。

3. **根本原因**：Dockerfile 中 `gosu` 降权方案与 biliup 的 Rust 二进制存在权限冲突——降权改变了进程 uid 但未改变 `HOME` 环境变量。

### 最终方案

去掉 `nodeuser` 和 `gosu`，容器以 root 运行。对于私有部署的录制服务，这是最简单可靠的方案。

### 经验总结

1. **`gosu` 降权不改变环境变量**：`gosu user cmd` 只改变 uid/gid，`HOME` 等环境变量需要手动设置
2. **Rust 的 `dirs` crate 依赖 `HOME`**：不是从 `/etc/passwd` 读取，而是直接读 `HOME` 环境变量
3. **`uv tool install` 安装位置取决于执行用户**：root 执行时装到 `/root/.local/share/uv/`，需要显式链接到全局 PATH
4. **非 root 容器用户增加运维复杂度**：对于私有部署场景，收益不大但问题不少

## JavaScript falsy 陷阱：`ts_ms = 0` 被 `||` 吞掉导致弹幕时间轴全部归零

### 现象

弹幕压制版视频中，243 条弹幕全部在开头 0 秒同时飞出，之后整段视频空空如也。检查 `danmaku.jsonl` 发现所有事件的 `ts_ms` 都是 `0`。

### 根因

`_normalizeEvent` 中用 `||` 做时间戳 fallback：

```javascript
const tsAbs = event.ts_ms || event.ts_abs_ms || Date.now();
```

Chrome Extension 发来的事件 `ts_ms` 是相对时间（可能为 `0`），而 `0` 在 JavaScript 中是 falsy，所以 `0 || ...` 会继续往后跳。更致命的是，Extension 的 `danmaku-parser.js` 输出的 `ts_ms` 是相对偏移（如 5000ms），即使它不为 0，服务端也会把它当绝对时间戳使用，`5000 - sessionStartMs` 得到一个巨大的负数，`Math.max(0, ...)` 后变成 `0`。

同时，`_normalizeEvent` 存储字段名为 `user`，但搜索 API 和前端都用 `username`，导致弹幕按用户名搜索永远无法命中。

### 修复

1. **时间戳优先级链**：`ts_abs_ms`（Extension 绝对时间戳）→ `ts_ms`（仅在 `> 0` 时合法）→ `_receivedAt`（批次到达时间）→ `Date.now()`。用 `typeof x === 'number' && x > 0` 替代 `||`。
2. **批次时间戳分配**：`writeBatch` 为同批次缺少合法时间戳的事件分配递增的 `_receivedAt = batchArrivalBase + i`，避免同批事件挤在同一毫秒。
3. **字段名对齐**：`_normalizeEvent` 输出从 `user` 改为 `username`，新增 `user_id`。搜索 API 兼容新旧字段名。
4. **Extension 端同步修复**：`danmaku-parser.js` 的 `normalizeDanmakuEvent` 同样把 `rawEvent.ts_ms || Date.now()` 改为显式校验。

### 经验总结

1. **`||` 不适用于数值 fallback**：`0`、`NaN` 都是 falsy，数值型字段必须用 `typeof x === 'number'` 显式判断
2. **跨系统字段名要对齐**：Extension 输出 `user`、服务端存 `user`、前端读 `username`——三段各写各的，搜索功能形同虚设
3. **时间戳语义要明确**：同一个字段名 `ts_ms` 在不同模块中含义不同（绝对 vs 相对），是导致误用的根源。改名区分（`ts_abs_ms` vs `ts_ms`）比依赖注释更可靠

## recording_files 追踪盲区：不分段录制、duration_seconds 死字段、segment_index 跳号

### 现象

1. `/api/sessions/52/danmaku-page` 查不到任何文件，但磁盘上 `.ts` 文件完好存在（56MB）
2. `session.total_segments` 与实际文件数不一致（session 51 有 2 个文件但 total_segments = 1）
3. `recording_files.duration_seconds` 始终为 0

### 根因分析

三个独立的问题，根因都在 `recording_files` 记录的插入路径不完整：

**问题一：不分段录制文件丢失**

不分段录制时 ffmpeg 不以 `-f segment` 模式运行，不会触发 `emitSegment()` 事件，`RecordingManager.recordSegment()` 从未被调用。录制结束后 `_handleSessionFinish()` 从 `recording_files` 查出 0 条记录，直接把 `total_segments` 覆写为 0。看门狗的 `scanActiveSegments()` 理论上能补上，但存在时序竞争——`_handleSessionFinish` 先把 session 标记为 completed 且 `total_segments = 0`，看门狗可能已过 5 分钟窗口。

**问题二：scanRecordingFiles 漏更新 total_segments**

`scanRecordingFiles()` 关联孤文件到 session 时只 INSERT 了 `recording_files` 记录，没有同步 `UPDATE recording_sessions SET total_segments = total_segments + 1`。如果文件先被这条路径录入，session 的 `total_segments` 就会少算。

**问题三：segment_index 双递增**

`scanActiveSegments()` 循环体内有两个 `segIndex++`（分别在第 279 行和第 290 行），每个新文件的序号跳 2（0, 2, 4...）。同时 `duration_seconds` 字段在 INSERT 时从未填充，只有迁移脚本写过一次。

### 修复

| 文件 | 改动 |
|---|---|
| `services/RecorderService.js` | `_handleSessionFinish` 在 `recordingFiles.length === 0` 时主动扫描 `output_dir`，将符合条件的视频文件补插入 `recording_files`，并累加 `fileCount` / `fileSize`，确保后续 UPDATE session 时计数正确 |
| `lib/core/watchdog.js` | `scanActiveSegments` 中 INSERT 新文件前调用 `probeSegmentDuration()` 写入 `duration_seconds`；删除多余的 `segIndex++`，每个文件只递增一次 |
| `lib/core/scan-files.js` | `scanRecordingFiles` 关联文件到 session 后，检查 `insertRes.rowCount > 0` 才 `UPDATE total_segments + 1`，避免 `ON CONFLICT DO NOTHING` 命中时重复计数 |

### 经验总结

1. **事件驱动的盲区要有兜底**：分段录制靠 `segment` 事件触发文件记录，但不分段模式不触发该事件——不能假设所有录制模式都走同一条路径，`_handleSessionFinish` 作为最终出口必须做兜底扫描
2. **多入口 INSERT 要保持计数一致**：`recording_files` 有三个 INSERT 入口（`scanActiveSegments`、`scanRecordingFiles`、`_handleSessionFinish`），每个入口都必须同步更新 `recording_sessions.total_segments`，漏一个就会出偏差
3. **循环体内的重复递增要看 diff**：`segIndex++` 写了两遍，肉眼扫代码很容易忽略，review 时关注循环变量变更的重复出现
4. **迁移脚本引入的字段要确认有写入方**：`duration_seconds` 从旧表迁过来后没有任何业务代码写入，属于典型的"迁而不管"，迁移后应逐一确认每个新字段在生产路径中有写入逻辑
