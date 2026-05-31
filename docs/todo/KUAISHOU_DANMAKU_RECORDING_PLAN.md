# 快手直播弹幕录制与视频弹幕压制开发计划

创建日期：2026-05-31

## 目标

评估并实现快手直播弹幕录制，将弹幕数据与录制会话绑定，并提供自动/手动弹幕压制能力。弹幕压制流程参考当前自动转码架构，使用 Redis 队列控制，最多并发 1 个任务，适配飞牛 NAS Docker 部署环境（8GB 内存、Intel N100）。

## 结论摘要

整体技术难度：中高。

主要难点不在 FFmpeg 压制本身，而在快手弹幕数据源。快手公开开放资料未提供面向普通直播间观众侧弹幕抓取的稳定 API，因此第一阶段必须做可行性验证：确认弹幕 WebSocket/HTTP 接口、鉴权、签名、心跳、消息格式和封禁风险。若只能依赖 Web 端逆向接口，维护成本和失效概率较高。

弹幕压制是重编码任务，不能沿用当前 TS/FLV → MP4 的 `-c copy` 快速转封装模式。FFmpeg 的 `subtitles/ass` 滤镜会把字幕渲染进视频画面，视频流必须重新编码；在 N100 上应默认并发 1，并优先验证 Intel Quick Sync/VAAPI/QSV 是否可用。没有硬件编码时也可用 `libx264`，但会明显占用 CPU，可能影响同时录制。

推荐路线：

1. 先实现“弹幕录制 + 原始 JSONL 保存 + ASS 生成”。
2. 再实现“手动压制”。
3. 最后开启“录制/转码完成后自动压制”。

## 依据与约束

- FFmpeg `subtitles` 滤镜用于把字幕绘制到视频上，依赖 libass；部署镜像需要验证 `ffmpeg -filters` 中存在 `subtitles` 或 `ass`。参考：<https://www.ffmpeg.org/ffmpeg-filters.html>
- Intel N100 支持 Intel Quick Sync Video，但 Docker 中是否可用取决于飞牛 NAS 主机驱动、容器 `/dev/dri` 透传、FFmpeg 编译参数和运行用户权限。参考：<https://www.intel.com/content/www/us/en/products/sku/231803/intel-processor-n100-6m-cache-up-to-3-40-ghz/specifications.html>
- 当前系统已有 Redis 队列和 PostgreSQL 状态表，可复用 `TranscodeQueue` 的设计思路，但弹幕压制应独立成队列，避免重编码任务阻塞普通转码。
- 当前录制输出目录结构为 `VIDEO_DOWNLOAD_DIR/[roomId]/[sessionId]/`，弹幕产物应放入同一会话目录，便于备份、清理、投稿和排查。

## 范围定义

### 第一版包含

- 快手弹幕可行性验证脚本。
- 录制会话内保存弹幕原始文件：`danmaku.jsonl`。
- 生成会话级 ASS 弹幕字幕：`danmaku.ass`。
- 支持分段录制场景，为每个视频分段生成独立 ASS：`danmaku_segments/[recording_file_id].ass`。
- 新增弹幕压制队列，默认并发 1，输出 `*_danmaku.mp4`。
- 手动触发压制 API 和页面入口。
- 可选自动压制：录制完成并完成必要转码后入队。
- 压制记录查询和失败日志查看。

### 第一版不包含

- 多平台弹幕统一协议的完整实现。
- 实时把弹幕压到正在录制的视频流。
- 花字、礼物动画、进场特效等复杂渲染。
- 依赖浏览器常驻实例抓包或播放页面渲染。
- 弹幕内容审核、敏感词过滤和复杂账号体系。

## 技术方案

### 1. 弹幕数据采集

新增模块：

- `lib/core/danmaku/KuaishouDanmakuClient.js`
- `lib/core/danmaku/DanmakuRecorder.js`
- `lib/core/danmaku/DanmakuAssGenerator.js`

采集流程：

```text
录制会话开始
  ↓
判断 room.platform / room_url 是否为快手
  ↓
启动 DanmakuRecorder
  ↓
连接快手弹幕数据源
  ↓
按会话时间写入 danmaku.jsonl
  ↓
录制结束时停止采集并生成 danmaku.ass
```

`danmaku.jsonl` 建议每行一条标准化事件：

```json
{ "ts_ms": 12345, "type": "comment", "user": "用户名", "text": "弹幕内容", "raw": {} }
```

时间戳规则：

- `ts_ms` 以当前录制会话开始时间为 0 点。
- 连接断开重连后继续使用会话时间，避免弹幕整体偏移。
- 录制恢复场景需要记录 `started_at` 和本地单调时间，防止系统时间跳变。
- 不按视频分段拆分原始弹幕。原始弹幕只按会话保存一份，后续压制阶段再按视频分段裁剪，避免重连、续播、分段边界变化导致原始数据碎片化。

### 2. ASS 生成

弹幕压制不直接使用 JSONL，而是先生成 ASS：

```text
danmaku.jsonl
  ↓
过滤、转义、限流、分轨
  ↓
danmaku.ass
  ↓
FFmpeg subtitles/ass 滤镜压制
```

ASS 生成规则：

- 默认只处理普通文本弹幕。
- 对 `{`、`}`、`\`、换行等 ASS 特殊字符做转义。
- 限制单条弹幕最长字符数，防止异常内容撑满画面。
- 支持顶部固定、底部固定、滚动弹幕的内部模型，但第一版可只实现滚动弹幕。
- 按视频宽度和字体大小计算轨道数，避免同轨重叠。
- 支持密度限制，例如每秒最多渲染 20 条，超出部分丢弃或延迟。

默认样式建议：

```text
字体：Noto Sans CJK SC 或系统可用中文字体
字号：1080p 默认 32，720p 默认 24
描边：2
阴影：0
透明度：20%-30%
滚动时长：8-12 秒
屏幕占用：上方 60%-70%
```

### 3. 分段录制适配

当前系统几乎默认按 1 小时分段录制，弹幕方案必须把“会话弹幕时间轴”和“视频分段时间轴”拆开处理。

核心原则：

- `danmaku.jsonl` 是会话级文件，覆盖整个录制会话。
- `danmaku.ass` 是会话级完整 ASS，主要用于预览、排查和重新裁剪。
- 实际压制时不直接把完整 ASS 套到每个分段视频上，而是为每个 `recording_files` 记录生成一个分段 ASS。
- 每个视频分段独立入队、独立压制、独立失败重试，队列全局并发仍然固定为 1。

建议目录结构：

```text
VIDEO_DOWNLOAD_DIR/[roomId]/[sessionId]/
├── 20260531_200000.ts
├── 20260531_210000.ts
├── danmaku.jsonl
├── danmaku.ass
└── danmaku_segments/
    ├── 101.ass                 # recording_files.id = 101
    └── 102.ass
```

分段 ASS 生成流程：

```text
recording_files 按 segment_index / file_name 排序
  ↓
为每个视频分段计算 segment_start_ms / segment_end_ms
  ↓
从 danmaku.jsonl 筛选该时间窗口内的弹幕
  ↓
将弹幕时间减去 segment_start_ms，归一化到当前分段 0 点
  ↓
生成 danmaku_segments/[recording_file_id].ass
  ↓
按 recording_file_id 入 danmaku_burn_queue
```

分段时间计算优先级：

1. 优先使用录制时记录的真实分段打开时间：`segment_start_ms` / `segment_end_ms`。
2. 如果暂时没有真实时间，使用 `segment_index * segment_duration` 估算。1 小时分段时，第 0 段是 `0-3600000ms`，第 1 段是 `3600000-7200000ms`。
3. 如果文件名由 FFmpeg `-strftime 1` 生成，且模板包含精确时间，可解析文件名时间并与会话 `started_at` 比较得到偏移。
4. 最后兜底才按文件排序和 `ffprobe` 时长累加估算。

注意：现有 `recording_files.started_at` / `ended_at` 不应直接作为分段真实起止时间。当前看门狗写入这些字段时，记录的是发现/入库时间，不一定等于 FFmpeg 开始写该分段的时间。

建议为 `recording_files` 补充分段时间字段：

```sql
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS segment_start_ms INTEGER DEFAULT 0;
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS segment_end_ms INTEGER DEFAULT 0;
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS danmaku_ass_path VARCHAR(1024) DEFAULT '';
```

分段压制输出规则：

- 输入：每个原始分段或转码后的分段 MP4。
- ASS：该分段对应的 `danmaku_segments/[recording_file_id].ass`。
- 输出：同目录下 `原文件名_danmaku.mp4`。
- 投稿：如果 `prefer_danmaku_burned_video=true`，投稿文件列表使用所有压制成功的 `*_danmaku.mp4`，并按 `segment_index` 排序；缺失压制产物时不自动混用原视频，除非用户明确允许。
- HLS：弹幕压制成功后可为压制版单独生成 HLS；不要把 HLS 分片计入录制文件数。

非分段录制是上述流程的特例：只有一个 `recording_files`，`segment_start_ms=0`，`segment_end_ms=视频时长`。

### 4. 弹幕压制队列

新增模块：

- `lib/core/DanmakuBurnQueue.js`
- `lib/core/danmaku-burner.js`

Redis Key：

- `danmaku_burn_queue`
- `danmaku_burn_processing_count`

并发策略：

- 默认并发固定为 1。
- settings 中可以保留 `danmaku_burn_concurrency`，但迁移时默认 `1`，后端读取后仍做上限保护：`Math.min(value, 1)`。
- 应独立于 `transcode_queue`，防止一个长时间压制任务堵住普通转码。

入队时机：

```text
录制结束
  ↓
生成 danmaku.ass 和分段 ASS
  ↓
如果 auto_transcode=true
    等待普通转码完成，逐个使用 MP4 分段作为压制输入
  否则
    逐个使用原始 TS/FLV 分段作为压制输入
  ↓
每个 recording_file 入 danmaku_burn_queue
```

失败处理：

- 输入视频不存在：任务失败，记录错误。
- 分段 ASS 不存在或为空：不入队，标记 skipped。
- FFmpeg 不支持 `subtitles/ass`：任务失败，并在日志中提示镜像缺少 libass。
- 输出文件已存在：默认跳过；手动强制压制时允许覆盖。
- 进程超时：按视频时长估算，建议 `max(30 分钟, 视频时长 * 4)`。

### 5. FFmpeg 命令

CPU 编码兜底命令：

```bash
ffmpeg -i input.mp4 \
  -vf "subtitles=danmaku.ass" \
  -c:v libx264 -preset veryfast -crf 23 \
  -c:a copy \
  -movflags +faststart \
  -y output_danmaku.mp4
```

QSV 方向候选命令：

```bash
ffmpeg -i input.mp4 \
  -vf "subtitles=danmaku.ass,format=nv12" \
  -c:v h264_qsv -global_quality 23 \
  -c:a copy \
  -movflags +faststart \
  -y output_danmaku.mp4
```

注意：

- `subtitles` 是视频滤镜，无法与 `-c:v copy` 同时使用。
- 即使使用硬件编码，字幕渲染本身仍可能走 CPU，性能需要实测。
- Docker 镜像必须包含中文字体、fontconfig、libass；否则可能出现中文方块、字体错乱或滤镜不存在。

### 6. 数据库设计

新增表：`danmaku_capture_records`

```sql
CREATE TABLE IF NOT EXISTS danmaku_capture_records (
  id SERIAL PRIMARY KEY,
  session_id INTEGER,
  room_id INTEGER,
  platform VARCHAR(50) DEFAULT 'kuaishou',
  status VARCHAR(20) DEFAULT 'recording',
  raw_path VARCHAR(1024) DEFAULT '',
  ass_path VARCHAR(1024) DEFAULT '',
  event_count INTEGER DEFAULT 0,
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  error TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW()
);
```

新增表：`danmaku_burn_records`

```sql
CREATE TABLE IF NOT EXISTS danmaku_burn_records (
  id SERIAL PRIMARY KEY,
  session_id INTEGER,
  recording_file_id INTEGER,
  segment_index INTEGER DEFAULT 0,
  segment_start_ms INTEGER DEFAULT 0,
  segment_end_ms INTEGER DEFAULT 0,
  input_path VARCHAR(1024) NOT NULL,
  ass_path VARCHAR(1024) NOT NULL,
  output_path VARCHAR(1024) DEFAULT '',
  status VARCHAR(20) DEFAULT 'queued',
  error TEXT DEFAULT '',
  enqueued_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
```

建议为 `recording_files` 增加字段：

```sql
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS danmaku_burn_path VARCHAR(1024) DEFAULT '';
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS is_danmaku_burned BOOLEAN DEFAULT FALSE;
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS danmaku_burned_at TIMESTAMP;
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS danmaku_ass_path VARCHAR(1024) DEFAULT '';
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS segment_start_ms INTEGER DEFAULT 0;
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS segment_end_ms INTEGER DEFAULT 0;
```

新增 settings：

| 键                             | 默认值             | 说明                              |
| ------------------------------ | ------------------ | --------------------------------- |
| `kuaishou_danmaku_enabled`     | `false`            | 是否启用快手弹幕录制              |
| `auto_burn_danmaku`            | `false`            | 是否在录制/转码完成后自动压制弹幕 |
| `danmaku_burn_concurrency`     | `1`                | 弹幕压制并发，后端强制最大 1      |
| `danmaku_preserve_clean_video` | `true`             | 压制成功后是否保留无弹幕版本      |
| `danmaku_density_per_second`   | `20`               | ASS 生成时每秒最大弹幕数          |
| `danmaku_font_family`          | `Noto Sans CJK SC` | 弹幕字体                          |
| `danmaku_font_size`            | `32`               | 1080p 默认字号                    |
| `danmaku_opacity`              | `0.75`             | 弹幕不透明度                      |
| `prefer_danmaku_burned_video`  | `false`            | 投稿/播放是否优先使用压制弹幕版本 |

### 7. API 与页面

新增 API：

- `POST /api/sessions/:id/danmaku/ass`：重新生成 ASS。
- `POST /api/sessions/:id/danmaku/burn`：手动加入压制队列。
- `GET /api/danmaku_capture_records`：查询弹幕录制记录。
- `GET /api/danmaku_burn_records`：查询弹幕压制记录。
- `DELETE /api/danmaku_burn_records/:id`：删除压制记录。

页面改动：

- `sessions` 页面增加“弹幕文件”“生成 ASS”“压制弹幕”操作。
- 会话详情页按分段展示 `danmaku_ass_path`、`is_danmaku_burned` 和 `danmaku_burn_path`。
- 新增或扩展 `transcode` 页面，展示弹幕压制队列和历史记录。
- `settings` 页面增加弹幕录制与压制配置。

## 飞牛 NAS Docker 部署评估

### 资源预估

8GB 内存足够支撑 Node.js、Redis、PostgreSQL 和单路 FFmpeg 压制，但需要避免多个重编码任务同时运行。N100 适合轻量转码和单路后台任务；弹幕压制建议作为低优先级任务，避免与直播录制高峰抢 CPU、磁盘 IO。

建议默认策略：

- 普通录制优先级最高。
- 普通转码次之。
- 弹幕压制最低。
- 弹幕压制并发固定 1。
- 自动压制默认关闭，先提供手动入口。

### Docker 镜像要求

基础检查命令：

```bash
ffmpeg -filters | grep -E "subtitles| ass"
ffmpeg -encoders | grep -E "h264_qsv|h264_vaapi|libx264"
fc-list | grep -i "Noto Sans CJK"
ls -l /dev/dri
```

容器建议：

- 安装 `ffmpeg`、`fontconfig`、`fonts-noto-cjk`。
- 如启用 Intel 硬件编码，透传 `/dev/dri`。
- 确保容器用户属于可访问显卡设备的用户组。
- 将字体目录和 FFmpeg 日志纳入排障文档。

### 性能验证标准

第一轮基准测试使用 3 个样本：

1. 10 分钟 720p。
2. 10 分钟 1080p。
3. 30 分钟 1080p。
4. 2 小时 1080p，按 1 小时分段，验证两段弹幕裁剪和压制顺序。

记录指标：

- 压制耗时 / 视频时长比例。
- 峰值 CPU。
- 峰值内存。
- 磁盘读写吞吐。
- 同时录制 1 路直播时是否丢帧或断流。
- QSV 与 libx264 输出体积和画质差异。

验收建议：

- 1080p 压制速度不低于 0.5x 实时速度。
- 压制期间系统内存占用低于 6GB。
- 压制期间录制进程稳定，无频繁重连。
- 弹幕压制失败不会影响原始录制文件和普通转码结果。

## 风险与问题

### 1. 快手弹幕数据源不稳定

风险：接口签名、Cookie、WebSocket 协议、protobuf schema、心跳参数可能变化。

应对：

- 第一阶段只做 spike，不直接改主链路。
- 把快手采集器做成平台插件，不影响其他平台和录制功能。
- 保存原始包或原始 JSON，方便接口变化后重放解析。
- UI 明确显示弹幕录制失败原因，不阻断视频录制。

### 2. 账号与风控

风险：如果需要 Cookie 或登录态，长期采集可能触发风控或失效。

应对：

- 优先验证匿名游客态是否可读取弹幕。
- 不在数据库保存明文 Cookie；如必须保存，使用 `.env` 或后续引入加密配置。
- 增加连接频率限制和退避重连。

### 3. 时间同步偏移

风险：弹幕连接晚于视频录制启动，或重连期间丢消息，导致压制偏移。

应对：

- 记录弹幕采集启动相对会话的偏移。
- 支持手动设置 ASS 偏移量重新生成。
- 在页面提供“弹幕时间偏移 ms”参数。
- 分段录制时不要依赖看门狗入库时间作为分段起止时间；优先记录 FFmpeg 分段打开时间或从文件名/分段时长推导。

### 4. FFmpeg 和字体兼容

风险：镜像缺少 libass、中文字体、fontconfig，导致压制失败或乱码。

应对：

- 启动时增加能力检查并写入日志。
- 设置页面展示能力检查结果。
- Docker 文档补充依赖安装和 `/dev/dri` 透传。

### 5. 重编码资源占用

风险：压制任务抢占 N100 CPU/IO，影响录制。

应对：

- 并发固定 1。
- 自动压制默认关闭。
- 可增加夜间任务窗口或手动触发。
- FFmpeg 进程使用较低优先级（Linux 可用 `nice`）。

### 6. 存储膨胀

风险：保留原视频、转码视频、弹幕压制视频会让存储翻倍甚至三倍。

应对：

- 默认保留无弹幕版本，避免压制失败后丢源。
- 后续提供“压制成功后删除中间转码文件”的独立设置。
- 在会话页面显示各产物大小。

## 开发阶段拆分

### 阶段 0：可行性验证（1-3 天）

- 抓取快手直播页面网络请求，确认弹幕连接方式。
- 写独立脚本连接一个公开直播间，保存 10 分钟弹幕。
- 验证匿名态、Cookie 态、重连、心跳和消息解析。
- 输出 spike 结论：可稳定实现 / 需要登录态 / 不建议实现。

交付物：

- `scripts/probe-kuaishou-danmaku.js`
- 一份样例 `danmaku.jsonl`
- 快手弹幕协议说明文档

### 阶段 1：弹幕录制基础链路（2-4 天）

- 新增弹幕采集模块。
- 录制会话启动/结束时挂载和停止弹幕采集。
- 新增 `danmaku_capture_records`。
- 保存 `danmaku.jsonl`。
- 页面显示弹幕录制状态。

### 阶段 2：ASS 生成（1-2 天）

- 新增 ASS 生成器。
- 支持手动重新生成 ASS。
- 处理字符转义、密度限制、轨道分配、时间偏移。
- 支持按 `recording_files` 分段裁剪生成独立 ASS。
- 增加单元测试覆盖 ASS 转义和轨道分配。

### 阶段 3：弹幕压制队列（2-4 天）

- 新增 `DanmakuBurnQueue` 和 `danmaku-burner`。
- 新增 `danmaku_burn_records`。
- 实现按分段手动入队、状态更新、日志记录、失败清理。
- 在 NAS Docker 环境跑 720p/1080p 性能基准。

### 阶段 4：自动化与集成（1-3 天）

- 接入转码完成回调：普通转码完成后自动触发弹幕压制。
- 未启用普通转码时，录制完成后使用原视频压制。
- 设置页增加自动压制开关。
- 文档补充 API、DB、Docker 部署要求。

## 需要修改的文件清单

新增：

- `lib/core/danmaku/KuaishouDanmakuClient.js`
- `lib/core/danmaku/DanmakuRecorder.js`
- `lib/core/danmaku/DanmakuAssGenerator.js`
- `lib/core/DanmakuBurnQueue.js`
- `lib/core/danmaku-burner.js`
- `router/danmaku.js`
- `scripts/probe-kuaishou-danmaku.js`
- `test/danmaku-ass-generator.test.js`

修改：

- `db/migrate.js`
- `services/RecorderService.js`
- `lib/core/TranscodeQueue.js`
- `router/index.js`
- `router/html.js`
- `views/sessions.ejs`
- `views/settings.ejs`
- `views/transcode.ejs` 或新增弹幕记录页面
- `docs/API.md`
- `docs/DB.md`
- `docs/DOCKER.md`
- `docs/ARCHITECTURE.md`

## 开发建议

不要一开始就把弹幕压制接入自动任务。先完成快手弹幕采集 spike，确认数据源稳定后，再做主系统集成。主链路实现时保持“视频录制成功”与“弹幕录制/压制成功”解耦：弹幕失败只影响弹幕产物，不影响原始视频、转码、HLS 和投稿。

第一版上线建议默认：

- `kuaishou_danmaku_enabled=false`
- `auto_burn_danmaku=false`
- `danmaku_burn_concurrency=1`
- 保留无弹幕视频

这样可以在飞牛 NAS 上逐步验证性能和稳定性，避免新功能影响现有录制服务。
