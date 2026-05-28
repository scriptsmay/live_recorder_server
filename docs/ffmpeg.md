## 参考项目 FFmpeg 命令参数详解

该项目使用 FFmpeg 进行直播录制，根据不同的录制格式（TS/FLV/MP4/MKV/MP3/M4A）和场景，使用了多种 FFmpeg 命令组合。

---

### 一、核心录制命令（基础参数）

```bash
ffmpeg -y \
    -v verbose \
    -rw_timeout 30000000 \
    -loglevel error \
    -hide_banner \
    -user_agent "Mozilla/5.0 ..." \
    -protocol_whitelist "rtmp,crypto,file,http,https,tcp,tls,udp,rtp,httpproxy" \
    -thread_queue_size 1024 \
    -analyzeduration 20000000 \
    -probesize 20000000 \
    -fflags +discardcorrupt \
    -re \
    -i "直播流URL" \
    -bufsize 15000k \
    -sn -dn \
    -reconnect_delay_max 60 \
    -reconnect_streamed \
    -reconnect_at_eof \
    -max_muxing_queue_size 2048 \
    -correct_ts_overflow 1 \
    -avoid_negative_ts 1 \
    [输出参数] \
    [保存路径]
```

---

### 二、参数含义详解

#### 1. 全局/输入参数

| 参数                      | 值               | 含义                               |
| ------------------------- | ---------------- | ---------------------------------- |
| `-y`                      | -                | 覆盖输出文件（不询问确认）         |
| `-v verbose`              | -                | 设置详细日志级别                   |
| `-rw_timeout`             | 30000000 (30s)   | 网络读写超时时间（微秒）           |
| `-loglevel error`         | -                | 只显示错误日志                     |
| `-hide_banner`            | -                | 隐藏 FFmpeg 版本信息               |
| `-user_agent`             | "Mozilla/5.0..." | 设置 HTTP User-Agent 头            |
| `-protocol_whitelist`     | 协议列表         | 允许使用的协议白名单               |
| `-thread_queue_size`      | 1024             | 线程队列大小                       |
| `-analyzeduration`        | 20000000         | 分析输入流的最大时长（微秒）       |
| `-probesize`              | 20000000         | 探测输入流的最大数据量（字节）     |
| `-fflags +discardcorrupt` | -                | 丢弃损坏的帧                       |
| `-re`                     | -                | 以输入流的原始帧率读取（模拟实时） |
| `-i`                      | URL              | 输入源（直播流地址）               |

#### 2. 网络重连参数（关键稳定性参数）

| 参数                   | 值  | 含义                 |
| ---------------------- | --- | -------------------- |
| `-reconnect_delay_max` | 60  | 最大重连延迟（秒）   |
| `-reconnect_streamed`  | -   | 允许流式数据重连     |
| `-reconnect_at_eof`    | -   | 在文件结束时尝试重连 |

#### 3. 输出处理参数

| 参数                     | 值     | 含义             |
| ------------------------ | ------ | ---------------- |
| `-bufsize`               | 15000k | 缓冲区大小       |
| `-sn`                    | -      | 禁用字幕流       |
| `-dn`                    | -      | 禁用数据流       |
| `-max_muxing_queue_size` | 2048   | 最大复用队列大小 |
| `-correct_ts_overflow`   | 1      | 修正时间戳溢出   |
| `-avoid_negative_ts`     | 1      | 避免负时间戳     |

---

### 三、不同格式的录制命令

#### 1. TS 格式录制（推荐格式）

```bash
ffmpeg [基础参数] \
    -c:v copy \
    -c:a copy \
    -map 0 \
    -f mpegts \
    "保存路径.ts"
```

**分段录制 TS：**

```bash
ffmpeg [基础参数] \
    -c:v copy \
    -c:a copy \
    -map 0 \
    -f segment \
    -segment_time "00:30:00" \
    -segment_format mpegts \
    -reset_timestamps 1 \
    "保存路径_%03d.ts"
```

#### 2. FLV 格式录制

```bash
ffmpeg [基础参数] \
    -map 0 \
    -c:v copy \
    -c:a copy \
    -bsf:a aac_adtstoasc \
    -f flv \
    "保存路径.flv"
```

**分段录制 FLV：**

```bash
ffmpeg [基础参数] \
    -map 0 \
    -c:v copy \
    -c:a copy \
    -bsf:a aac_adtstoasc \
    -f segment \
    -segment_time "00:30:00" \
    -segment_format flv \
    -reset_timestamps 1 \
    "保存路径_%03d.flv"
```

#### 3. MP4 格式录制

```bash
ffmpeg [基础参数] \
    -map 0 \
    -c:v copy \
    -c:a copy \
    -f mp4 \
    "保存路径.mp4"
```

**分段录制 MP4：**

```bash
ffmpeg [基础参数] \
    -c:v copy \
    -c:a aac \
    -map 0 \
    -f segment \
    -segment_time "00:30:00" \
    -segment_format mp4 \
    -reset_timestamps 1 \
    -movflags +frag_keyframe+empty_moov \
    "保存路径_%03d.mp4"
```

#### 4. MKV 格式录制

```bash
ffmpeg [基础参数] \
    -flags global_header \
    -map 0 \
    -c:v copy \
    -c:a copy \
    -f matroska \
    "保存路径.mkv"
```

**分段录制 MKV：**

```bash
ffmpeg [基础参数] \
    -flags global_header \
    -c:v copy \
    -c:a aac \
    -map 0 \
    -f segment \
    -segment_time "00:30:00" \
    -segment_format matroska \
    -reset_timestamps 1 \
    "保存路径_%03d.mkv"
```

#### 5. 纯音频录制（MP3）

```bash
ffmpeg [基础参数] \
    -map 0:a \
    -c:a libmp3lame \
    -ab 320k \
    "保存路径.mp3"
```

**分段录制 MP3：**

```bash
ffmpeg [基础参数] \
    -map 0:a \
    -c:a libmp3lame \
    -ab 320k \
    -f segment \
    -segment_time "00:30:00" \
    -reset_timestamps 1 \
    "保存路径_%03d.mp3"
```

#### 6. 纯音频录制（M4A）

```bash
ffmpeg [基础参数] \
    -map 0:a \
    -c:a aac \
    -bsf:a aac_adtstoasc \
    -ab 320k \
    -movflags +faststart \
    "保存路径.m4a"
```

**分段录制 M4A：**

```bash
ffmpeg [基础参数] \
    -map 0:a \
    -c:a aac \
    -bsf:a aac_adtstoasc \
    -ab 320k \
    -f segment \
    -segment_time "00:30:00" \
    -segment_format mpegts \
    -reset_timestamps 1 \
    "保存路径_%03d.m4a"
```

---

### 四、后期处理命令

#### 1. TS 转 MP4（快速复制模式）

```bash
ffmpeg -i "输入.ts" \
    -c:v copy \
    -c:a copy \
    -f mp4 \
    "输出.mp4"
```

#### 2. TS 转 MP4（强制 H.264 编码）

```bash
ffmpeg -i "输入.ts" \
    -c:v libx264 \
    -preset veryfast \
    -crf 23 \
    -vf format=yuv420p \
    -c:a copy \
    -f mp4 \
    "输出.mp4"
```

**参数说明：**
| 参数 | 值 | 含义 |
|------|-----|------|
| `-c:v libx264` | - | 使用 H.264 编码器 |
| `-preset veryfast` | - | 编码速度预设（越快体积越大） |
| `-crf 23` | - | 恒定质量因子（0-51，越小质量越好） |
| `-vf format=yuv420p` | - | 视频像素格式 |

#### 3. 视频分段处理

```bash
ffmpeg -i "输入.mp4" \
    -c:v copy \
    -c:a copy \
    -map 0 \
    -f segment \
    -segment_time "00:30:00" \
    -segment_format mp4 \
    -reset_timestamps 1 \
    -movflags +frag_keyframe+empty_moov \
    "输出_%03d.mp4"
```

#### 4. M4A 音频提取

```bash
ffmpeg -i "输入.ts" \
    -n -vn \
    -c:a aac \
    -bsf:a aac_adtstoasc \
    -ab 320k \
    "输出.m4a"
```

---

### 五、关键参数说明

#### 1. 分段录制参数

| 参数                  | 含义                                       |
| --------------------- | ------------------------------------------ |
| `-f segment`          | 启用分段输出模式                           |
| `-segment_time`       | 每个片段的时长（如 "00:30:00" 表示30分钟） |
| `-segment_format`     | 分段文件格式（mpegts/flv/mp4/matroska）    |
| `-reset_timestamps 1` | 每个片段重置时间戳                         |
| `%03d`                | 文件名中的序号占位符（3位数字）            |

#### 2. 编解码参数

| 参数                   | 含义                         |
| ---------------------- | ---------------------------- |
| `-c:v copy`            | 视频流直接复制（不重新编码） |
| `-c:a copy`            | 音频流直接复制               |
| `-c:a aac`             | 音频使用 AAC 编码            |
| `-c:a libmp3lame`      | 音频使用 MP3 编码            |
| `-ab 320k`             | 音频比特率 320kbps           |
| `-bsf:a aac_adtstoasc` | AAC 音频比特流过滤器         |

#### 3. MP4 特殊参数

| 参数                                  | 含义                                          |
| ------------------------------------- | --------------------------------------------- |
| `-movflags +faststart`                | 将 moov atom 移到文件开头（支持网页渐进播放） |
| `-movflags +frag_keyframe+empty_moov` | 创建分片 MP4（适合分段录制）                  |

---

### 六、为什么推荐 TS 格式？

根据项目代码注释和实现：

1. **容错性强**：TS 格式对网络中断更友好，异常中断后文件仍可播放
2. **无需转码**：可以直接复制音视频流，CPU 占用低
3. **分段安全**：分段录制时，每个 TS 片段都是独立的，一个片段损坏不影响其他片段
4. **兼容性好**：几乎所有播放器都支持 TS 格式

> **提示**：项目配置文件 `config.ini` 中推荐将 `video_save_type` 设置为 `TS` 格式。

---

### 七、HLS/m3u8 流录制参数

FFmpegDownloader 支持自动检测 HLS 流并使用专用参数录制：

```bash
ffmpeg -y \
    -rw_timeout 60000000 \          # HLS 需要更长超时（60s）
    -reconnect 1 \
    -reconnect_at_eof 1 \
    -reconnect_streamed 1 \
    -reconnect_delay_max 30 \       # HLS 重连间隔更短
    -live_start_index -1 \          # 从直播点开始（HLS 专用）
    -user_agent "Mozilla/5.0 ..." \
    -protocol_whitelist "rtmp,crypto,file,http,https,tcp,tls,udp,rtp,httpproxy,hls" \
    -analyzeduration 20000000 \
    -probesize 20000000 \
    -thread_queue_size 1024 \
    -i "http://example.com/live/stream.m3u8" \
    -c copy -map 0 \
    -fflags +genpts+igndts+discardcorrupt \
    -correct_ts_overflow 1 \
    -avoid_negative_ts make_zero \  # HLS 推荐 make_zero 模式
    -max_muxing_queue_size 2048 \
    -sn -dn -bufsize 15000k \
    -f mpegts \
    output.ts
```

#### HLS 与标准 FLV 参数差异

| 参数                 | FLV 标准值      | HLS 专用值       | 说明                       |
| -------------------- | --------------- | ---------------- | -------------------------- |
| `-rw_timeout`        | 30000000 (30s)  | 60000000 (60s)   | HLS 播放列表刷新需要更长时间 |
| `-reconnect_delay_max` | 60            | 30               | HLS 重连更积极             |
| `-live_start_index`  | (无)            | -1               | 从最新直播片段开始         |
| `-protocol_whitelist` | (不含 hls)     | (含 hls)         | 需要 hls 协议支持          |
| `-avoid_negative_ts` | 1               | make_zero        | HLS 推荐 make_zero 模式    |

#### 流类型检测流程

```
RecorderService.startRecording()
  → downloader.detectStreamType(url)     # 异步预检
      ├─ URL 特征检测（.m3u8, .flv, /hls/, /flv/）
      └─ HTTP 头检测（Content-Type + 响应体 #EXTM3U）
  → downloader.buildArgs(url, path, { streamType })
      ├─ streamType='hls' → _buildHLSArgs()
      └─ streamType='flv' → _buildStandardArgs()
```
