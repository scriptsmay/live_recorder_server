# TODO

## ✅ 已完成：优化视频转码功能，增加 HLS 索引，并利用 HLS 实现前端视频播放

### 实现状态

本功能已完整实现，包括：

1. **数据库变更** ([db/migrate.js](file:///Users/virola/code/projects/live_recorder_server/db/migrate.js))
   - `recordings` 表新增 `is_hls_ready`、`hls_playlist_path`、`hls_generated_at` 字段
   - `recording_files` 表新增相同 HLS 相关字段
   - 新增默认配置项：`auto_generate_hls`、`hls_enabled`、`hls_segment_duration`、`hls_cleanup_days`

2. **HLS 生成器** ([lib/core/hls-generator.js](file:///Users/virola/code/projects/live_recorder_server/lib/core/hls-generator.js))
   - 使用 FFmpeg 进行零重编码容器转封装
   - 支持按需生成 HLS 索引
   - 内置过期清理功能

3. **API 接口** ([router/api.js](file:///Users/virola/code/projects/live_recorder_server/router/api.js))
   - `GET /api/recordings/:id/hls` - 查询 HLS 状态
   - `POST /api/recordings/:id/generate-hls` - 触发 HLS 生成
   - `GET /hls/{path}` (RegExp) - HLS 文件服务

4. **前端播放器** ([views/partials/_video_player.ejs](file:///Users/virola/code/projects/live_recorder_server/views/partials/_video_player.ejs))
   - 集成 hls.js 库
   - 支持 HLS 流播放
   - 自动回退到原生播放

5. **播放逻辑** ([views/sessions.ejs](file:///Users/virola/code/projects/live_recorder_server/views/sessions.ejs))
   - 优先使用 HLS 播放
   - 文件列表显示 HLS 就绪状态

6. **配置页面** ([views/settings.ejs](file:///Users/virola/code/projects/live_recorder_server/views/settings.ejs))
   - 新增 HLS 设置分组

---

### 技术要点

- **零重编码**：使用 `ffmpeg -c copy` 直接复制音视频流
- **按需生成**：首次播放时生成 HLS，避免不必要的计算
- **分层存储**：HLS 文件存储在 `原文件目录/hls/` 下

部署服务器配置： **Intel N100** 处理器，这简直是“NAS 视频处理的神器”，因为它自带了非常强悍的 **Intel QuickSync (QSV) 硬件编解码引擎**。

既然你接受 **TS 切片播放** 的形式，且不想对原视频做复杂的重编码，那么最完美的方案是：**生成一个 M3U8 播放列表，直接利用浏览器 HLS 协议播放**。

### 核心思路：极速封装（Zero-Copy Transcoding）

我们不进行重编码（Re-encoding），而是进行 **“容器转封装”**。这个过程只改变视频的“外壳”，不改变内部图像数据，速度极快，CPU 占用率几乎可以忽略不计。

#### 1. 后端逻辑优化 (生成 HLS 索引)

在 Node.js 中，执行以下命令，将 `.ts` 或 `.mkv` 快速生成 `.m3u8` 索引：

```javascript
// 使用 ffmpeg 快速生成 HLS 索引 (无损，极快)
const exec = require('child_process').exec;

function generateHLS(inputPath, outputDir) {
  // -c copy 表示直接拷贝音频和视频流，不进行编码
  // -f hls 自动分片并生成 m3u8 文件
  const cmd = `ffmpeg -i "${inputPath}" -c copy -f hls -hls_time 10 -hls_list_size 0 -hls_segment_filename "${outputDir}/segment_%03d.ts" "${outputDir}/playlist.m3u8"`;

  exec(cmd, (err) => {
    if (err) console.error('索引生成失败', err);
  });
}
```

- **特点**：对于 4GB 的文件，此操作仅耗时几秒钟，CPU 几乎不工作。
- **注意**：`outputDir` 应该是一个专门存放切片的目录。

---

#### 2. 前端实现：引入 hls.js

原生 `<video>` 标签不支持播放 `.m3u8`，需要引入 `hls.js` 插件。

在你的前端页面中加入：

```html
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
```

修改你的 `playBtn` 逻辑：

```javascript
function openVideoPlayer(src, filename, ext) {
  const video = document.getElementById('my-video-element');

  // 如果是 m3u8 格式
  if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(src); // 传入你的 m3u8 地址
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play());
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari 支持
    video.src = src;
    video.addEventListener('loadedmetadata', () => video.play());
  }
}
```

---

### 3. N100 性能极致优化方案 (如果未来必须转码)

虽然封装很棒，但如果未来必须转码（比如压缩大小），请一定要利用 N100 的集成显卡（核显）：

```bash
# 使用 Intel QSV 硬件加速进行转码
ffmpeg -hwaccel qsv -i input.mkv -c:v h264_qsv -preset fast -c:a aac -b:v 2M output.mp4

```

- **`-hwaccel qsv`**: 开启硬件加速。
- **`-c:v h264_qsv`**: 使用显卡的编码引擎，CPU 负载会从 90% 降到 5% 左右。

---

### 给你的执行建议：

1. **分层存储**：

- `hls/` 文件夹：存放生成的 `m3u8` 和切片文件。

2. **避免重复处理**：数据库表里记录 `is_hls_ready` 状态。只有第一次播放时触发 `generateHLS` 命令，之后直接读取 `playlist.m3u8`。
3. **定时清理**：如果 NAS 空间紧张，可以设置一个简单的任务，定期删除 7 天前的 `hls/` 文件夹下的切片文件，但保留原始录像文件。

这样，你的 N100 NAS 可以在几乎零负载的情况下，为前端提供非常流畅的视频播放体验，也不再需要担心大文件导致的卡死问题。

## 涉及到修改文件清单（部分）

- 前端部分： `sessions.ejs` L127-L151
- 后端部分：
  - `api.js`: `router.get('/recordings/:id/stream'` 相关代码
  - `TranscodeQueue.js`，入队转码部分逻辑，需要增加 hls 索引生成逻辑
