# Live Recorder Server 开发计划文档 - FFmpeg兼容性与DouyuChecker修复

## 概述

本文档基于对 biliup 项目斗鱼录制流程的深入分析，针对当前 live-recorder-server 项目提出两项核心开发任务：

1. **增强 FFmpeg 下载器的兼容性**，支持 m3u8 流和 HLS 流两种格式的下载
2. **评估并修复 DouyuChecker 的代码问题**

---

## 第一部分：FFmpeg 下载器兼容性增强

### 1.1 现状分析

#### 当前 FFmpegDownloader 实现

当前 `lib/core/downloaders/FFmpegDownloader.js` 仅支持标准的 TS 格式录制，主要特点：

- **输出格式**: 固定为 `.ts` (MPEG-TS)
- **录制模式**: 支持分段录制（segment）和单文件录制
- **流类型检测**: 无自动流类型检测机制
- **参数构建**: 使用固定参数模板，未针对 m3u8/HLS 优化

#### 参考：biliup 的流类型处理策略

根据 biliup 项目文档，其 stream-gears 下载器采用以下策略：

```rust
// 读取前 9 字节判断流类型
let bytes = connection.read_frame(9).await?;

match header(&bytes) {
    Ok((_i, header)) => {
        // FLV流下载
        let file = LifecycleFile::with_hook(&file_name, "flv", hook);
        httpflv::download(connection, file, segment.clone()).await;
    }
    Err(_) => {
        // HLS流下载
        let file = LifecycleFile::with_hook(&file_name, "ts", hook);
        hls::download(&url, &client, file, segment.clone()).await?;
    }
}
```

**关键洞察**：biliup 通过检测流的前几个字节来判断流类型（FLV vs HLS），然后选择对应的下载策略。

### 1.2 m3u8/HLS 流的特点

| 特性     | 传统 FLV 流   | m3u8/HLS 流                     |
| -------- | ------------- | ------------------------------- |
| 协议类型 | HTTP 长连接   | HTTP 分段请求                   |
| 数据结构 | 连续二进制流  | 播放列表 + 多个 TS 片段         |
| URL 特征 | `.flv` 结尾   | `.m3u8` 结尾                    |
| 内容类型 | `video/x-flv` | `application/vnd.apple.mpegurl` |
| 重连策略 | 简单重连      | 需重新获取播放列表              |
| 时间戳   | 连续          | 每个片段独立                    |

### 1.3 开发方案

#### 1.3.1 流类型自动检测

**方案 A：URL 后缀检测（推荐作为第一层检测）**

```javascript
static detectStreamType(url) {
  const url_lower = url.toLowerCase();

  // HLS/m3u8 特征
  if (url_lower.includes('.m3u8') ||
      url_lower.includes('/hls/') ||
      url_lower.includes('/playlist.')) {
    return 'hls';
  }

  // FLV 特征
  if (url_lower.includes('.flv') ||
      url_lower.includes('/flv/')) {
    return 'flv';
  }

  // 默认类型
  return 'unknown';
}
```

**方案 B：HTTP 头检测（更可靠）**

```javascript
async detectStreamTypeByHeaders(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    const contentType = response.headers.get('content-type');

    if (contentType?.includes('mpegurl') || contentType?.includes('m3u8')) {
      return 'hls';
    }

    // 检查响应体前几个字节（需要实际请求）
    const probeResponse = await fetch(url, {
      method: 'GET',
      headers: { 'Range': 'bytes=0-100' }
    });
    const buffer = await probeResponse.arrayBuffer();
    const text = new TextDecoder().decode(buffer);

    if (text.includes('#EXTM3U')) {
      return 'hls';
    }

    return 'flv';
  } catch (err) {
    console.error('[StreamTypeDetection] 检测失败:', err.message);
    return 'unknown';
  }
}
```

#### 1.3.2 FFmpeg 参数优化

**针对 m3u8/HLS 流的专用参数：**

```javascript
buildHLSArgs(url, outputPath, options = {}) {
  const { segmentDuration } = options;

  const args = [
    '-y',

    // HLS 专用：播放列表加载超时
    '-rw_timeout', '60000000',  // 60秒，HLS需要更长的超时

    // HLS 专用：重连参数
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '30',

    // HLS 专用：播放列表刷新间隔
    '-live_start_index', '-1',  // 从直播点开始

    '-user_agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',

    // HLS 支持更多协议
    '-protocol_whitelist', 'rtmp,crypto,file,http,https,tcp,tls,udp,rtp,httpproxy,hls',

    '-analyzeduration', '20000000',
    '-probesize', '20000000',

    '-thread_queue_size', '1024',

    '-i', url,

    '-c', 'copy',
    '-map', '0',

    '-fflags', '+genpts+igndts+discardcorrupt',
    '-correct_ts_overflow', '1',
    '-avoid_negative_ts', 'make_zero',  // HLS 推荐
    '-max_muxing_queue_size', '2048',

    '-sn', '-dn',
    '-bufsize', '15000k',
  ];

  if (segmentDuration > 0) {
    args.push(
      '-f', 'segment',
      '-segment_time', String(segmentDuration),
      '-segment_format', 'mpegts',
      '-reset_timestamps', '1',
      '-strftime', '1'
    );
  } else {
    args.push('-f', 'mpegts');
  }

  args.push(outputPath);
  return args;
}
```

#### 1.3.3 修改后的 FFmpegDownloader 类

```javascript
const { spawn } = require('child_process');
const readline = require('readline');
const DownloaderInterface = require('./DownloaderInterface');

class FFmpegDownloader extends DownloaderInterface {
  constructor() {
    super();
    this.streamType = 'auto'; // 'auto' | 'flv' | 'hls'
  }

  get name() {
    return 'ffmpeg';
  }

  getExtension() {
    return '.ts';
  }

  isSegment() {
    return true;
  }

  /**
   * 检测流类型
   * @param {string} url - 流地址
   * @returns {Promise<string>} 'flv' | 'hls' | 'unknown'
   */
  async detectStreamType(url) {
    // 第一层：URL 特征检测
    const urlType = this._detectStreamTypeByUrl(url);
    if (urlType !== 'unknown') {
      return urlType;
    }

    // 第二层：HTTP 头检测
    return await this._detectStreamTypeByHeaders(url);
  }

  _detectStreamTypeByUrl(url) {
    const url_lower = url.toLowerCase();

    if (url_lower.includes('.m3u8') || url_lower.includes('/hls/') || url_lower.includes('playlist')) {
      return 'hls';
    }

    if (url_lower.includes('.flv')) {
      return 'flv';
    }

    return 'unknown';
  }

  async _detectStreamTypeByHeaders(url) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timeout);

      // 检查 Content-Type
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('mpegurl') || contentType?.includes('m3u8')) {
        return 'hls';
      }

      // 检查响应体内容
      const buffer = await response.arrayBuffer();
      const text = new TextDecoder().decode(buffer.slice(0, 100));

      if (text.includes('#EXTM3U')) {
        return 'hls';
      }

      return 'flv';
    } catch (err) {
      console.warn('[FFmpegDownloader] 流类型检测失败，默认使用 FLV 参数:', err.message);
      return 'flv';
    }
  }

  buildArgs(url, outputPath, options = {}) {
    const { segmentDuration, streamType = 'auto', platform, isStreamUrl } = options;

    // 根据流类型选择参数构建策略
    const detectedType = streamType === 'auto' ? this._detectStreamTypeByUrl(url) : streamType;

    if (detectedType === 'hls') {
      return this._buildHLSArgs(url, outputPath, { segmentDuration });
    }

    return this._buildStandardArgs(url, outputPath, { segmentDuration });
  }

  _buildStandardArgs(url, outputPath, options) {
    const { segmentDuration } = options;

    const args = [
      '-y',
      '-rw_timeout',
      '30000000',
      '-reconnect',
      '1',
      '-reconnect_at_eof',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '60',
      '-user_agent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      '-protocol_whitelist',
      'rtmp,crypto,file,http,https,tcp,tls,udp,rtp,httpproxy',
      '-analyzeduration',
      '20000000',
      '-probesize',
      '20000000',
      '-thread_queue_size',
      '1024',
      '-i',
      url,
      '-c',
      'copy',
      '-map',
      '0',
      '-fflags',
      '+genpts+igndts+discardcorrupt',
      '-correct_ts_overflow',
      '1',
      '-avoid_negative_ts',
      '1',
      '-max_muxing_queue_size',
      '2048',
      '-sn',
      '-dn',
      '-bufsize',
      '15000k',
    ];

    if (segmentDuration > 0) {
      args.push(
        '-f',
        'segment',
        '-segment_time',
        String(segmentDuration),
        '-segment_format',
        'mpegts',
        '-reset_timestamps',
        '1',
        '-strftime',
        '1'
      );
    } else {
      args.push('-f', 'mpegts');
    }

    args.push(outputPath);
    return args;
  }

  _buildHLSArgs(url, outputPath, options) {
    const { segmentDuration } = options;

    const args = [
      '-y',
      // HLS 专用：更长的超时
      '-rw_timeout',
      '60000000',
      '-reconnect',
      '1',
      '-reconnect_at_eof',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '30',
      // HLS 专用：从直播点开始
      '-live_start_index',
      '-1',
      '-user_agent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      // HLS 支持更多协议
      '-protocol_whitelist',
      'rtmp,crypto,file,http,https,tcp,tls,udp,rtp,httpproxy,hls',
      '-analyzeduration',
      '20000000',
      '-probesize',
      '20000000',
      '-thread_queue_size',
      '1024',
      '-i',
      url,
      '-c',
      'copy',
      '-map',
      '0',
      '-fflags',
      '+genpts+igndts+discardcorrupt',
      '-correct_ts_overflow',
      '1',
      // HLS 推荐：make_zero 模式
      '-avoid_negative_ts',
      'make_zero',
      '-max_muxing_queue_size',
      '2048',
      '-sn',
      '-dn',
      '-bufsize',
      '15000k',
    ];

    if (segmentDuration > 0) {
      args.push(
        '-f',
        'segment',
        '-segment_time',
        String(segmentDuration),
        '-segment_format',
        'mpegts',
        '-reset_timestamps',
        '1',
        '-strftime',
        '1'
      );
    } else {
      args.push('-f', 'mpegts');
    }

    args.push(outputPath);
    return args;
  }

  spawn(args) {
    const process = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    const rl = readline.createInterface({ input: process.stderr, terminal: false });
    rl.on('line', (line) => {
      const segmentMatch = line.match(/\[segment @ .*\] Opening '(.*)' for writing/);
      if (segmentMatch) {
        this.emitSegment(segmentMatch[1]);
      }

      const outputMatch = line.match(/Output #0, .*, to '(.*)':/);
      if (outputMatch) {
        this.emit('file_created', outputMatch[1]);
      }

      const progress = this.parseProgress(line);
      if (progress) {
        this.emit('progress', progress);
      }
    });

    return process;
  }

  parseProgress(stderrLine) {
    const progress = {};

    const timeMatch = stderrLine.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
    if (timeMatch) {
      const hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const seconds = parseInt(timeMatch[3], 10);
      const centiseconds = parseInt(timeMatch[4], 10);
      progress.timeSeconds = hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
    }

    const sizeMatch = stderrLine.match(/size=\s*(\d+)(kB|MB|GB)?/);
    if (sizeMatch) {
      let sizeBytes = parseInt(sizeMatch[1], 10);
      const unit = sizeMatch[2];
      if (unit === 'kB') sizeBytes *= 1024;
      if (unit === 'MB') sizeBytes *= 1024 * 1024;
      if (unit === 'GB') sizeBytes *= 1024 * 1024 * 1024;
      progress.sizeBytes = sizeBytes;
    }

    const speedMatch = stderrLine.match(/speed=\s*([\d.]+)x/);
    if (speedMatch) {
      progress.speed = parseFloat(speedMatch[1]);
    }

    const frameMatch = stderrLine.match(/frame=\s*(\d+)/);
    if (frameMatch) {
      progress.frames = parseInt(frameMatch[1], 10);
    }

    if (Object.keys(progress).length > 0) {
      return progress;
    }
    return null;
  }

  getRetryStrategy(errorCode) {
    const retryableErrors = [1, 131, 137, 255];
    if (retryableErrors.includes(errorCode)) {
      return {
        shouldRetry: true,
        delayMs: 5000,
        maxRetries: 3,
      };
    }
    return {
      shouldRetry: false,
      delayMs: 0,
      maxRetries: 0,
    };
  }

  getDefaultOptions() {
    return {
      segmentDuration: 0,
      reconnect: true,
      reconnectDelayMax: 120,
      timeout: 30,
      streamType: 'auto', // 新增：自动检测流类型
    };
  }
}

module.exports = FFmpegDownloader;
```

### 1.4 实施计划

| 阶段 | 任务                                     | 预计工时 | 优先级 |
| ---- | ---------------------------------------- | -------- | ------ |
| 1    | 实现流类型检测方法（URL + HTTP 头）      | 4h       | 高     |
| 2    | 实现 HLS 专用 FFmpeg 参数构建            | 3h       | 高     |
| 3    | 重构 FFmpegDownloader 类，支持流类型切换 | 4h       | 高     |
| 4    | 编写单元测试（模拟 m3u8/flv URL）        | 3h       | 中     |
| 5    | 集成测试（实际 m3u8 流录制）             | 4h       | 中     |
| 6    | 文档更新                                 | 2h       | 低     |

---

## 第二部分：DouyuChecker 代码问题评估与修复

### 2.1 现状分析

#### 当前 DouyuChecker 实现概览

```javascript
class DouyuChecker extends PlatformChecker {
  // 核心方法：
  - getRoomId()           // 从 URL 提取房间号
  - resolveRealRoomId()   // 短ID转真实ID
  - getRoomStatus()       // 获取房间状态
  - isVideoLoop()         // 判断是否录播
  - getStreamUrl()        // 获取流地址
  - checkStatus()         // 主检测入口
}
```

#### 与 biliup 对比分析

| 功能点       | biliup 实现                | 当前 DouyuChecker        | 差距        |
| ------------ | -------------------------- | ------------------------ | ----------- |
| 房间号解析   | URL提取 + 移动端页面回退   | URL提取 + 移动端页面回退 | ✅ 一致     |
| 开播状态检测 | betard API + show_status   | betard API + show_status | ✅ 一致     |
| 录播检测     | videoLoop 字段             | videoLoop 字段           | ✅ 一致     |
| 互动游戏检测 | 有专门 API 检测            | ❌ 缺失                  | ⚠️ 需添加   |
| 签名算法     | 完整的 MD5 签名 + 密钥更新 | 简化版 MD5               | ⚠️ 可能不够 |
| CDN 选择     | 自动避开 scdn              | ❌ 缺失                  | ⚠️ 需添加   |
| 画质选择     | douyu_rate 参数            | ❌ 缺失                  | ⚠️ 需添加   |
| VIP 房间支持 | 完整的 VIP 签名流程        | ❌ 缺失                  | ⚠️ 需添加   |
| 错误处理     | 详细的错误码映射           | 基础错误处理             | ⚠️ 需增强   |

### 2.2 代码问题清单

#### 问题 1：签名算法过于简化

**当前实现：**

```javascript
async function getSignParams(rid) {
  const time = Date.now();
  const sign = md5Hash(`${rid}${time}`);
  return { did: DEFAULT_DID, rid: String(rid), time: String(time), sign };
}
```

**biliup 的标准实现：**

```python
# 1. 从 getEncryption 接口获取加密密钥
rsp = await client.get(
    f"https://{domain}/wgapi/livenc/liveweb/websec/getEncryption",
    params={"did": did}
)
DouyuUtils.WhiteEncryptKey = data['data']

# 2. 生成 secret: MD5 迭代 enc_time 次
secret = rand_str
for _ in range(enc_time):
    secret = hashlib.md5(f"{secret}{key}".encode('utf-8')).hexdigest()

# 3. 生成 auth
salt = f"{rid}{ts}"
auth = hashlib.md5(f"{secret}{key}{salt}".encode('utf-8')).hexdigest()
```

**影响**：某些房间可能无法获取正确的流地址，特别是需要完整签名的房间。

#### 问题 2：缺少 CDN 自动选择

**biliup 的实现：**

```python
for _ in range(2):
    play_info = await self.aget_web_play_info(self.room_id, self.__req_query)
    if play_info['rtmp_cdn'].startswith('scdn'):
        new_cdn = play_info['cdnsWithName'][-1]['cdn']
        self.__req_query['cdn'] = new_cdn
        continue
    break
```

**当前缺失**：没有检测和替换 scdn 的逻辑，可能导致录制不稳定。

#### 问题 3：缺少互动游戏检测

**biliup 的实现：**

```python
if self.douyu_disable_interactive_game:
    gift_info = (
        await client.get(
            f"https://{DOYU_WEB_DOMAIN}/api/interactive/web/v2/list?rid={self.room_id}",
            headers=self.fake_headers
    )).json().get('data', {})
    if gift_info:
        return False
```

**当前缺失**：没有互动游戏检测，可能录制到非直播内容。

#### 问题 4：缺少画质选择参数

**biliup 的请求参数：**

```python
self.__req_query = {
    'cdn': self.douyu_cdn,      # CDN 选择
    'rate': str(self.douyu_rate),  # 画质等级
    'ver': 'Douyu_new',
    'iar': '0',
    'ive': '0',
    'rid': self.room_id,
    'hevc': '0',
    'fa': '0',
    'sov': '0',
}
```

**当前缺失**：所有参数都是硬编码，用户无法选择画质。

#### 问题 5：错误处理不够详细

**biliup 的错误码处理：**

```python
# error != 0 时返回明确异常
if result["error"] != 0:
    # 处理各种错误码：未开播、时间戳不对、地域版权限制等
    raise Error(result.to_string())
```

**当前实现**：仅简单检查 `error !== 0`，没有详细的错误映射。

### 2.3 修复方案

#### 2.3.1 完整签名算法实现

```javascript
// lib/core/polling/signers/douyu.js

const crypto = require('crypto');
const { getFetch } = require('../../utils/fetch'); // 统一使用封装后的 fetch
const { getOptimalUserAgent } = require('../../config/userAgents'); // 统一使用配置化 UA

const DEFAULT_DID = '10000000000000000000000000001501';
const DOUYU_API_BASE = 'https://www.douyu.com';

// 缓存加密密钥
let encryptKeyCache = null;
let encryptKeyExpiry = 0;
const KEY_CACHE_DURATION = 300000; // 5分钟

function md5Hash(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * 获取加密密钥
 */
async function getEncryptionKey(did) {
  // 检查缓存
  if (encryptKeyCache && Date.now() < encryptKeyExpiry) {
    return encryptKeyCache;
  }

  try {
    const fetch = await getFetch(); // 统一使用封装后的 fetch
    const url = `${DOUYU_API_BASE}/wgapi/livenc/liveweb/websec/getEncryption?did=${did}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': getOptimalUserAgent(), // 统一使用配置化 UA
      },
    });

    const data = await response.json();

    if (data.error !== 0 || !data.data) {
      throw new Error(`获取加密密钥失败: ${data.msg || '未知错误'}`);
    }

    encryptKeyCache = data.data;
    encryptKeyExpiry = Date.now() + KEY_CACHE_DURATION;

    return encryptKeyCache;
  } catch (err) {
    console.error('[DouyuSign] 获取加密密钥失败:', err.message);
    return null;
  }
}

/**
 * 生成完整签名（参考 biliup 实现）
 */
async function getSignParams(rid, options = {}) {
  try {
    const { did = DEFAULT_DID } = options;
    const ts = Math.floor(Date.now() / 1000);

    // 获取加密密钥
    const keyData = await getEncryptionKey(did);
    if (!keyData) {
      // 降级到简化签名
      console.warn('[DouyuSign] 使用简化签名');
      const time = Date.now();
      return {
        did,
        rid: String(rid),
        time: String(time),
        sign: md5Hash(`${rid}${time}`),
        _fallback: true,
      };
    }

    const { rand_str, enc_time, key } = keyData;

    // 生成 secret: MD5 迭代 enc_time 次
    let secret = rand_str;
    for (let i = 0; i < enc_time; i++) {
      secret = md5Hash(`${secret}${key}`);
    }

    // 生成 auth
    const salt = `${rid}${ts}`;
    const auth = md5Hash(`${secret}${key}${salt}`);

    return {
      did,
      rid: String(rid),
      time: String(ts),
      sign: auth,
      enc_data: keyData.enc_data || '',
      key_ver: keyData.key_ver || '1',
      _fallback: false,
    };
  } catch (err) {
    console.error('[DouyuSign] 获取签名失败:', err.message);
    return null;
  }
}

module.exports = {
  getSignParams,
  getEncryptionKey,
  md5Hash,
};
```

#### 2.3.2 增强的 DouyuChecker 类

```javascript
const PlatformChecker = require('./PlatformChecker');
const { getSignParams } = require('./signers/douyu');

const DOYU_API_BASE = 'https://www.douyu.com';
const DOYU_MOBILE_API = 'https://m.douyu.com';
const DOYU_PLAY_API = 'https://playweb.douyucdn.cn';

class DouyuChecker extends PlatformChecker {
  constructor(roomUrl, options = {}) {
    super(roomUrl);
    this._roomId = null;
    this.options = {
      cdn: options.cdn || 'hw-h5', // CDN 选择
      rate: options.rate || 0, // 画质等级 (0=最高)
      disableInteractiveGame: options.disableInteractiveGame ?? false,
      ...options,
    };
  }

  static getPlatformId() {
    return 'douyu';
  }

  static canHandleUrl(url) {
    return /douyu\.com/i.test(url);
  }

  getRoomId() {
    if (this._roomId) return this._roomId;
    const roomId = PlatformChecker.extractLastPathSegment(this.roomUrl);
    if (roomId) {
      this._roomId = roomId.split('?')[0].split('#')[0];
    }
    return this._roomId;
  }

  async resolveRealRoomId(shortId) {
    if (!shortId) return null;

    if (/^\d+$/.test(shortId)) {
      return shortId;
    }

    try {
      const url = `${DOYU_MOBILE_API}/${shortId}`;
      const html = await PlatformChecker.fetchText(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
      });

      const match = html.match(/room_id\s*:\s*(\d+)/);
      if (match) {
        return match[1];
      }

      return null;
    } catch (err) {
      console.error(`[DouyuChecker] 解析真实房间ID失败 (${shortId}):`, err.message);
      return null;
    }
  }

  async getRoomStatus(rid) {
    try {
      const url = `${DOYU_API_BASE}/betard/${rid}`;
      const data = await PlatformChecker.fetchJson(url, {
        headers: {
          Referer: `${DOYU_API_BASE}/${rid}`,
        },
      });

      if (!data) return null;

      const room = data.data || data.room;
      if (!room) return null;

      return {
        roomName: room.owner_name || '',
        roomTitle: room.room_name || '',
        roomCover: room.room_pic || '',
        status: room.show_status,
        videoLoop: room.videoLoop || 0,
        isVip: room.isVip === 1,
      };
    } catch (err) {
      console.error(`[DouyuChecker] 获取房间状态失败 (${rid}):`, err.message);
      return null;
    }
  }

  isVideoLoop(roomData) {
    return roomData?.videoLoop === 1;
  }

  /**
   * 检测是否为互动游戏（非直播内容）
   */
  async isInteractiveGame(rid) {
    if (!this.options.disableInteractiveGame) {
      return false;
    }

    try {
      const url = `${DOYU_API_BASE}/api/interactive/web/v2/list?rid=${rid}`;
      const data = await PlatformChecker.fetchJson(url, {
        headers: {
          Referer: `${DOYU_API_BASE}/${rid}`,
        },
      });

      const giftInfo = data?.data;
      return giftInfo && Object.keys(giftInfo).length > 0;
    } catch (err) {
      console.warn(`[DouyuChecker] 互动游戏检测失败 (${rid}):`, err.message);
      return false;
    }
  }

  /**
   * 构建播放信息请求参数
   */
  buildPlayQuery(rid) {
    return {
      cdn: this.options.cdn,
      rate: String(this.options.rate),
      ver: 'Douyu_new',
      iar: '0',
      ive: '0',
      rid: String(rid),
      hevc: '0',
      fa: '0',
      sov: '0',
    };
  }

  async getStreamUrl(rid, signParams) {
    if (!signParams) {
      return null;
    }

    const query = this.buildPlayQuery(rid);

    // 尝试获取流地址，自动避开 scdn
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const streamData = await this._fetchStreamUrl(rid, signParams, query);

        if (!streamData) {
          return null;
        }

        // 检测是否为 scdn，如果是则切换 CDN 重试
        if (streamData.rtmp_cdn?.startsWith('scdn') && attempt === 0) {
          const availableCdns = streamData.cdnsWithName || [];
          if (availableCdns.length > 0) {
            // 选择最后一个 CDN（通常是非 scdn）
            const newCdn = availableCdns[availableCdns.length - 1]?.cdn;
            if (newCdn && newCdn !== query.cdn) {
              console.log(`[DouyuChecker] 检测到 scdn，切换 CDN: ${query.cdn} -> ${newCdn}`);
              query.cdn = newCdn;
              continue;
            }
          }
        }

        const rtmpUrl = streamData.rtmp_url;
        const rtmpLive = streamData.rtmp_live;

        if (!rtmpUrl || !rtmpLive) {
          console.error('[DouyuChecker] 流地址参数不完整');
          return null;
        }

        // 判断流类型
        const streamUrl = `${rtmpUrl}/${rtmpLive}`;
        const format = streamUrl.includes('.m3u8') || rtmpLive.includes('.m3u8') ? 'hls' : 'flv';

        return {
          streamUrl,
          format,
          cdn: streamData.rtmp_cdn,
          rate: streamData.rate,
        };
      } catch (err) {
        console.error(`[DouyuChecker] 获取流地址异常 (${rid}):`, err.message);
        return null;
      }
    }

    return null;
  }

  async _fetchStreamUrl(rid, signParams, query) {
    const { did, time, sign, enc_data, key_ver } = signParams;

    // 构建请求体
    const bodyParams = new URLSearchParams({
      did,
      rid: String(rid),
      ...query,
    });

    // 如果有完整签名参数，添加到请求
    if (enc_data) {
      bodyParams.append('enc_data', enc_data);
      bodyParams.append('tt', time);
      bodyParams.append('auth', sign);
    }

    const url = `${DOYU_PLAY_API}/lapi/live/hlsH5Preview/${rid}`;

    const data = await PlatformChecker.fetchJson(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        rid: String(rid),
        time,
        auth: sign,
      },
      body: bodyParams.toString(),
    });

    if (!data || data.error !== 0 || !data.data) {
      console.error(`[DouyuChecker] 获取流地址失败: ${data?.msg || '未知错误'}`);
      return null;
    }

    return data.data;
  }

  async checkStatus() {
    const roomId = this.getRoomId();

    if (!roomId) {
      return PlatformChecker.normalizeResult({ error: '无法解析房间号' });
    }

    try {
      const realRoomId = await this.resolveRealRoomId(roomId);

      if (!realRoomId) {
        return PlatformChecker.normalizeResult({ error: '无法解析真实房间ID' });
      }

      const roomStatus = await this.getRoomStatus(realRoomId);

      if (!roomStatus) {
        return PlatformChecker.normalizeResult({ error: '无法获取房间状态' });
      }

      // 检查是否开播
      if (roomStatus.status !== 1) {
        return PlatformChecker.normalizeResult({
          isLive: false,
          roomName: roomStatus.roomName,
          roomTitle: roomStatus.roomTitle,
          roomCover: roomStatus.roomCover,
        });
      }

      // 检查是否录播
      if (this.isVideoLoop(roomStatus)) {
        return PlatformChecker.normalizeResult({
          isLive: false,
          roomName: roomStatus.roomName,
          roomTitle: roomStatus.roomTitle,
          roomCover: roomStatus.roomCover,
          error: '当前为录播回放',
        });
      }

      // 检查是否为互动游戏
      const isGame = await this.isInteractiveGame(realRoomId);
      if (isGame) {
        return PlatformChecker.normalizeResult({
          isLive: false,
          roomName: roomStatus.roomName,
          roomTitle: roomStatus.roomTitle,
          roomCover: roomStatus.roomCover,
          error: '当前为互动游戏',
        });
      }

      const signParams = await getSignParams(realRoomId);

      if (!signParams) {
        return PlatformChecker.normalizeResult({
          isLive: true,
          recordable: false,
          roomName: roomStatus.roomName,
          roomTitle: roomStatus.roomTitle,
          roomCover: roomStatus.roomCover,
          error: '签名获取失败',
        });
      }

      const streamData = await this.getStreamUrl(realRoomId, signParams);

      if (!streamData) {
        return PlatformChecker.normalizeResult({
          isLive: true,
          recordable: false,
          roomName: roomStatus.roomName,
          roomTitle: roomStatus.roomTitle,
          roomCover: roomStatus.roomCover,
          error: '无法获取流地址',
        });
      }

      return PlatformChecker.normalizeResult({
        isLive: true,
        roomName: roomStatus.roomName,
        roomTitle: roomStatus.roomTitle,
        roomCover: roomStatus.roomCover,
        streamUrl: streamData.streamUrl,
        streamInfo: {
          format: streamData.format,
          cdn: streamData.cdn,
          rate: streamData.rate,
          isFallback: signParams._fallback,
        },
      });
    } catch (err) {
      console.error(`[DouyuChecker] 检查失败 (${this.roomUrl}):`, err.message);
      return PlatformChecker.normalizeResult({ error: err.message });
    }
  }
}

module.exports = DouyuChecker;
```

### 2.4 实施计划

| 阶段 | 任务                           | 预计工时 | 优先级 |
| ---- | ------------------------------ | -------- | ------ |
| 1    | 实现完整签名算法（含密钥缓存） | 4h       | 高     |
| 2    | 添加 CDN 自动选择逻辑          | 2h       | 高     |
| 3    | 添加互动游戏检测               | 2h       | 中     |
| 4    | 添加画质选择参数               | 2h       | 中     |
| 5    | 增强错误处理和日志             | 2h       | 中     |
| 6    | 更新单元测试                   | 3h       | 中     |
| 7    | 集成测试（真实斗鱼房间）       | 4h       | 高     |

---

## 第三部分：架构设计隐患与修复方案（补充）

> 以下内容补充了代码审查中发现的架构设计问题及对应的修复方案。

### 3.1 `buildArgs` 同步与异步冲突问题

#### 问题描述

原设计方案中规划了异步方法 `_detectStreamTypeByHeaders(url)` 来通过 HTTP 请求头判断真实的流格式，但 `buildArgs` 方法是同步的，实际只使用了 URL 字符串匹配 `_detectStreamTypeByUrl`，没有用到 HTTP 头检测逻辑。

#### 修复方案：在 Downloader 层完成异步检测

**架构调整**：将流类型检测提前到 `RecorderService.startRecording` 中执行，`buildArgs` 保持同步。

**修改后的调用链：**

```
RecorderService.startRecording()
    │
    ├─> 1. 创建 Downloader 实例
    │
    ├─> 2. 调用 downloader.detectStreamType(streamUrl)  ← 异步预检
    │       │
    │       └─> 返回 { type: 'hls' | 'flv', metadata }
    │
    └─> 3. 调用 downloader.buildArgs(streamUrl, outputPath, { streamType })
            │
            └─> 使用预检测结果，同步构建参数
```

**修改后的 `RecorderService`：**

```javascript
// services/RecorderService.js

static async startRoomRecording({ roomId, caption, url, resumeSessionId = null }) {
  const room = await DataService.getRoomById(roomId);
  const downloader = getActiveDownloader(room.polling_platform);

  // ========== 新增：异步流类型检测 ==========
  let streamType = 'flv';  // 默认值
  try {
    const detection = await downloader.detectStreamType(url);
    streamType = detection.type;
    console.log(`[流类型检测] ${url} -> ${streamType}`);
  } catch (err) {
    console.warn(`[流类型检测] 失败，使用默认类型 flv:`, err.message);
  }

  const { process: dlProcess, logPath } = recordingManager.startRecordingProcess({
    downloader,
    streamUrl: url,
    outputPath: outputFilePattern,
    options: {
      segmentDuration,
      platform: room.polling_platform,
      isStreamUrl: true,
      streamType,  // ← 传入预检测结果
    },
    sessionId,
  });
}
```

**修改后的 `FFmpegDownloader`：**

```javascript
class FFmpegDownloader extends DownloaderInterface {
  /**
   * 异步流类型检测（供外部调用）
   * @param {string} url - 流地址
   * @returns {Promise<{type: string, metadata: object}>}
   */
  async detectStreamType(url) {
    // 第一层：URL 特征检测（同步，快速失败）
    const urlType = this._detectStreamTypeByUrl(url);
    if (urlType !== 'unknown') {
      return { type: urlType, metadata: { source: 'url' } };
    }

    // 第二层：HTTP 头检测（异步，更可靠）
    const headerType = await this._detectStreamTypeByHeaders(url);
    return { type: headerType, metadata: { source: 'header' } };
  }

  /**
   * buildArgs 保持同步，仅负责参数构建
   */
  buildArgs(url, outputPath, options = {}) {
    const { segmentDuration, streamType = 'flv' } = options;

    if (streamType === 'hls') {
      return this._buildHLSArgs(url, outputPath, { segmentDuration });
    }

    return this._buildStandardArgs(url, outputPath, { segmentDuration });
  }
}
```

---

### 3.2 VIP 房间签名逻辑（使用 `vm` 模块）

#### 问题描述

当前实现只处理普通房间的签名，VIP 房间需要执行 JavaScript 代码进行签名（`homeH5Enc` + `ub98484234()`），这部分逻辑完全缺失。

#### 修复方案：使用 Node.js `vm` 模块执行 JS 代码

```javascript
// lib/core/polling/signers/douyu-vip.js

const vm = require('vm');
const crypto = require('crypto');
const { getFetch } = require('../../utils/fetch'); // 统一使用封装后的 fetch
const { getOptimalUserAgent } = require('../../config/userAgents'); // 统一使用配置化 UA

const DOYU_DEFAULT_DID = '10000000000000000000000000001501';

/**
 * VIP 房间专用签名（需要执行 JS 代码）
 * 参考 biliup: homeH5Enc + ub98484234() 执行
 */
async function getVipSignParams(rid, jsCode) {
  try {
    // 创建安全的沙箱环境
    const sandbox = {
      CryptoJS: {
        MD5: (str) => ({
          toString: () => crypto.createHash('md5').update(str).digest('hex'),
        }),
      },
      window: {},
      document: {},
      ub98484234: null,
    };

    const context = vm.createContext(sandbox);

    // 执行 JS 代码
    const wrappedCode = `
      (function() {
        ${jsCode}
        return ub98484234();
      })()
    `;

    const result = vm.runInContext(wrappedCode, context);

    // 解析返回值
    const [signFun, signV] = Array.isArray(result) ? result : [null, null];

    if (!signFun || !signV) {
      throw new Error('JS 执行未返回有效签名');
    }

    // 生成 rb 参数
    const rb = crypto.createHash('md5').update(`${rid}${DOYU_DEFAULT_DID}${Date.now()}${signV}`).digest('hex');

    // 替换原代码中的 MD5 调用
    const finalSign = signFun.replace('CryptoJS.MD5(cb).toString()', `"${rb}"`);

    return {
      did: DOYU_DEFAULT_DID,
      rid: String(rid),
      time: String(Math.floor(Date.now() / 1000)),
      sign: finalSign,
      isVip: true,
    };
  } catch (err) {
    console.error('[DouyuSign] VIP 签名失败:', err.message);
    return null;
  }
}

/**
 * 获取 VIP 房间的 JS 加密代码
 */
async function fetchVipJsCode(rid) {
  const fetch = await getFetch(); // 统一使用封装后的 fetch
  const url = `https://www.douyu.com/ub98484234.js`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': getOptimalUserAgent(), // 统一使用配置化 UA
      Referer: `https://www.douyu.com/${rid}`,
    },
  });
  return await response.text();
}

module.exports = { getVipSignParams, fetchVipJsCode };
```

---

### 3.3 加密密钥缓存的 Thundering Herd 问题

#### 问题描述

如果同时监控了多个斗鱼房间，且加密密钥缓存同时失效，会向斗鱼发起大量重复请求，极易触发平台限流。

#### 修复方案：单飞机制（Single-flight）

```javascript
// lib/core/polling/signers/douyu.js

const crypto = require('crypto');

const DEFAULT_DID = '10000000000000000000000000001501';
const DOYU_API_BASE = 'https://www.douyu.com';

// 缓存结构
let encryptKeyCache = null;
let encryptKeyExpiry = 0;
let pendingKeyRequest = null; // 正在进行的请求 Promise

const KEY_CACHE_DURATION = 300000; // 5分钟

/**
 * 单飞机制：确保同时只有一个请求在获取密钥
 */
async function getEncryptionKey(did) {
  const now = Date.now();

  // 缓存命中
  if (encryptKeyCache && now < encryptKeyExpiry) {
    return encryptKeyCache;
  }

  // 已有请求在进行中，等待它完成
  if (pendingKeyRequest) {
    console.log('[DouyuSign] 等待正在进行的密钥请求...');
    return await pendingKeyRequest;
  }

  // 发起新请求
  pendingKeyRequest = _fetchEncryptionKey(did, now);

  try {
    const result = await pendingKeyRequest;
    return result;
  } finally {
    pendingKeyRequest = null;
  }
}

async function _fetchEncryptionKey(did, requestTime) {
  try {
    const fetch = await getFetch(); // 统一使用封装后的 fetch
    const url = `${DOUYU_API_BASE}/wgapi/livenc/liveweb/websec/getEncryption?did=${did}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': getOptimalUserAgent() },
    });

    const data = await response.json();

    if (data.error !== 0 || !data.data) {
      throw new Error(`获取加密密钥失败: ${data.msg || '未知错误'}`);
    }

    // 更新缓存
    encryptKeyCache = data.data;
    encryptKeyExpiry = requestTime + KEY_CACHE_DURATION;

    console.log('[DouyuSign] 密钥已更新，有效期至:', new Date(encryptKeyExpiry).toISOString());

    return encryptKeyCache;
  } catch (err) {
    console.error('[DouyuSign] 密钥获取异常:', err.message);
    throw err;
  }
}
```

---

### 3.4 User-Agent 固化与环境匹配问题

#### 问题描述

代码中硬编码了 Mac/Windows 的 UA，在 Docker 容器（通常是 Linux）中长期运行可能触发平台风控。

#### 修复方案：配置化 + 环境匹配

```javascript
// lib/core/config/userAgents.js

const PLATFORMS = {
  WINDOWS: 'Windows NT 10.0; Win64; x64',
  MAC: 'Macintosh; Intel Mac OS X 10_15_7',
  LINUX: 'X11; Linux x86_64',
};

// UA 模板
const UA_TEMPLATES = {
  chrome: (platform) =>
    `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`,
  safari: (platform) =>
    `Mozilla/5.0 (${platform}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15`,
  mobile: () =>
    `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1`,
};

/**
 * 根据运行时环境获取最优 UA
 */
function getOptimalUserAgent() {
  const platformMap = {
    win32: PLATFORMS.WINDOWS,
    darwin: PLATFORMS.MAC,
    linux: PLATFORMS.LINUX,
  };
  const platformStr = platformMap[process.platform] || PLATFORMS.LINUX;
  return UA_TEMPLATES.chrome(platformStr);
}

/**
 * 获取随机 UA（用于不同请求间差异化伪装）
 */
function getRandomUserAgent() {
  const uaList = [
    UA_TEMPLATES.chrome(PLATFORMS.WINDOWS),
    UA_TEMPLATES.chrome(PLATFORMS.MAC),
    UA_TEMPLATES.chrome(PLATFORMS.LINUX),
    UA_TEMPLATES.safari(PLATFORMS.MAC),
    UA_TEMPLATES.mobile(),
  ];
  return uaList[Math.floor(Math.random() * uaList.length)];
}

module.exports = {
  getOptimalUserAgent,
  getRandomUserAgent,
  UA_TEMPLATES,
  PLATFORMS,
};
```

---

### 3.5 FFmpeg 进程优雅退出处理

#### 问题描述

HLS 流的特性是如果没有正确捕获信号，FFmpeg 可能无法优雅退出，产生僵尸进程。

#### 修复方案：信号处理 + 优雅关闭

```javascript
// lib/core/RecordingManager.js

class RecordingManager {
  startRecordingProcess({ downloader, streamUrl, outputPath, options = {}, sessionId }) {
    const dlArgs = downloader.buildArgs(streamUrl, outputPath, options);
    const dlProcess = downloader.spawn(dlArgs);

    // ========== 新增：进程信号处理 ==========
    const cleanup = (signal) => {
      console.log(`[RecordingManager] 收到 ${signal} 信号，正在优雅停止 FFmpeg...`);

      // 尝试优雅退出
      dlProcess.kill('SIGTERM');

      // 等待最多 10 秒后强制终止
      const forceKillTimer = setTimeout(() => {
        console.warn('[RecordingManager] FFmpeg 未响应 SIGTERM，强制终止');
        dlProcess.kill('SIGKILL');
      }, 10000);

      dlProcess.once('exit', () => {
        clearTimeout(forceKillTimer);
        console.log('[RecordingManager] FFmpeg 已退出');
      });
    };

    // 注册信号处理器
    process.on('SIGTERM', () => cleanup('SIGTERM'));
    process.on('SIGINT', () => cleanup('SIGINT'));

    // 存储清理函数
    dlProcess._cleanup = () => {
      process.off('SIGTERM', cleanup);
      process.off('SIGINT', cleanup);
    };

    return { process: dlProcess, logStream, logPath, ... };
  }
}
```

#### 容器化部署备忘：PID 1 与僵尸进程回收

> **⚠️ Docker 部署时必须使用 init 进程作为入口。**
>
> 当 Node.js 直接作为容器的 PID 1 进程运行时，它**不会自动回收退出的子进程**（即不会执行 `wait()` 系统调用）。如果 FFmpeg 因异常退出，即使上述代码中有 `kill` 逻辑，其进程描述符仍会残留在系统中成为僵尸进程（Zombie Process），最终可能导致容器内 PID 耗尽。
>
> **解决方案**：在 Dockerfile 中使用 `tini` 作为 init 进程：
>
> ```dockerfile
> # 方案 A：使用 tini（推荐）
> RUN apt-get update && apt-get install -y tini
> ENTRYPOINT ["/sbin/tini", "--"]
> CMD ["node", "src/index.js"]
> ```
>
> ```dockerfile
> # 方案 B：使用 dumb-init
> RUN apt-get update && apt-get install -y dumb-init
> ENTRYPOINT ["/usr/bin/dumb-init", "--"]
> CMD ["node", "src/index.js"]
> ```
>
> `tini` / `dumb-init` 会作为 PID 1 接管信号转发和子进程回收，确保：
>
> 1. Docker `docker stop` 发送的 SIGTERM 能正确传递给 Node.js → FFmpeg
> 2. FFmpeg 异常退出后，其进程资源被正确回收，不会产生僵尸进程
> 3. Node.js 崩溃时，所有子进程（FFmpeg 实例）也会被级联终止

---

### 3.6 Node.js 原生 Fetch 兼容性

#### 问题描述

代码大量使用 `await fetch(url)`，需要确认 Node.js 版本是否 >= v18.0.0。

#### 修复方案：条件引入或升级建议

```javascript
// lib/core/utils/fetch.js

/**
 * 兼容性 fetch 封装
 * Node.js 18+ 使用原生 fetch，否则使用 undici
 */
let fetchInstance;

async function getFetch() {
  if (fetchInstance) return fetchInstance;

  // 检查 Node.js 版本
  const [major] = process.version.slice(1).split('.').map(Number);

  if (major >= 18) {
    // Node.js 18+ 使用原生 fetch
    fetchInstance = globalThis.fetch;
  } else {
    // 老版本引入 undici
    try {
      const { fetch: undiciFetch } = await import('undici');
      fetchInstance = undiciFetch;
    } catch (err) {
      console.error('[Fetch] 无法加载 undici，请升级 Node.js 至 v18+');
      throw new Error('Node.js 版本过低，需要 v18.0.0 或更高版本');
    }
  }

  return fetchInstance;
}

module.exports = { getFetch };
```

#### 统一引用约定

> **项目内所有发起 HTTP 请求的模块，必须统一使用 `getFetch()` 获取 fetch 实例，禁止直接调用全局 `fetch`。** 同时，所有请求的 `User-Agent` 必须通过 `getOptimalUserAgent()` 或 `getRandomUserAgent()` 获取，禁止硬编码 UA 字符串。
>
> 涉及模块清单：
>
> | 模块       | 文件路径                                   | 请求目标          |
> | ---------- | ------------------------------------------ | ----------------- |
> | 斗鱼签名   | `lib/core/polling/signers/douyu.js`        | getEncryption API |
> | VIP 签名   | `lib/core/polling/signers/douyu-vip.js`    | ub98484234.js     |
> | 流类型检测 | `lib/core/downloaders/FFmpegDownloader.js` | 流 URL 探测       |
> | 房间状态   | `lib/core/polling/DouyuChecker.js`         | betard / play API |
> | 互动游戏   | `lib/core/polling/DouyuChecker.js`         | interactive API   |

---

### 3.7 补充后的实施计划

| 阶段                            | 任务                                           | 预计工时 | 优先级 |
| ------------------------------- | ---------------------------------------------- | -------- | ------ |
| **第一部分：FFmpeg 兼容性增强** |                                                |          |        |
| 1.1                             | 实现流类型检测方法（URL + HTTP 头）            | 4h       | 高     |
| 1.2                             | 实现 HLS 专用 FFmpeg 参数构建                  | 3h       | 高     |
| 1.3                             | 重构 FFmpegDownloader 类，支持流类型切换       | 4h       | 高     |
| 1.4                             | **新增**：流类型异步检测前置到 RecorderService | 2h       | 高     |
| 1.5                             | **新增**：FFmpeg 进程优雅退出处理              | 2h       | 中     |
| 1.6                             | **新增**：Docker 容器化部署（tini init 进程）  | 1h       | 高     |
| **第二部分：DouyuChecker 修复** |                                                |          |        |
| 2.1                             | 实现完整签名算法（含密钥缓存）                 | 4h       | 高     |
| 2.2                             | **新增**：单飞机制（避免 Thundering Herd）     | 2h       | 高     |
| 2.3                             | 添加 CDN 自动选择逻辑                          | 2h       | 高     |
| 2.4                             | 添加互动游戏检测                               | 2h       | 中     |
| 2.5                             | 添加画质选择参数                               | 2h       | 中     |
| 2.6                             | **新增**：VIP 房间 JS 签名支持                 | 6h       | 高     |
| 2.7                             | **新增**：User-Agent 配置化                    | 2h       | 中     |
| 2.8                             | **新增**：Node.js Fetch 兼容性处理             | 2h       | 中     |
| 2.9                             | 增强错误处理和日志                             | 2h       | 中     |
| **测试**                        |                                                |          |        |
| 3.1                             | 单元测试更新                                   | 3h       | 中     |
| 3.2                             | 集成测试（真实斗鱼房间）                       | 4h       | 高     |
| **总计**                        |                                                | **~41h** |        |

---

## 第四部分：风险与注意事项

### 4.1 FFmpeg HLS 录制风险

1. **播放列表刷新**：HLS 流依赖定期刷新 m3u8 播放列表，网络不稳定可能导致片段丢失
2. **时间戳问题**：HLS 各片段时间戳独立，直接合并可能出现问题
3. **DRM 保护**：部分 HLS 流可能有 DRM 保护，无法直接录制

### 4.2 斗鱼 API 风险

1. **API 变更**：斗鱼可能随时更改 API 接口或签名算法
2. **频率限制**：频繁请求可能导致 IP 被限制
3. **地域限制**：部分房间可能有地域访问限制

### 4.3 建议的监控指标

| 指标           | 说明                        | 告警阈值   |
| -------------- | --------------------------- | ---------- |
| 签名失败率     | 完整签名 vs 降级签名的比例  | > 20%      |
| CDN 切换频率   | 因 scdn 导致的 CDN 切换次数 | > 5次/小时 |
| 流类型检测失败 | 无法识别的流类型            | > 10%      |
| 录制中断率     | FFmpeg 非正常退出比例       | > 15%      |
| VIP 签名成功率 | VIP 房间 JS 签名成功率      | < 80%      |
| 密钥请求并发   | 同时发起密钥请求的数量      | > 3        |

---

## 附录：参考资源

### biliup 项目关键文件

- `biliup/plugins/douyu.py` - Python 斗鱼插件主实现
- `biliup/Danmaku/douyu.py` - 弹幕协议实现
- `crates/biliup/src/downloader/extractor/douyu.rs` - Rust 提取器
- `crates/biliup-cli/src/server/core/downloader/stream_gears.rs` - 下载器实现

### FFmpeg 文档

- [HLS 协议支持](https://ffmpeg.org/ffmpeg-protocols.html#hls)
- [Segment 复用器](https://ffmpeg.org/ffmpeg-formats.html#segment)

### Node.js 文档

- [vm 模块](https://nodejs.org/api/vm.html)
- [Native Fetch API](https://nodejs.org/api/fetch.html)

---

_文档生成时间: 2026-05-28_
_最后更新时间: 2026-05-28（补充架构设计隐患修复 + 模块统一引用 + 容器化部署备忘）_
_基于 biliup 项目文档分析 + 代码审查反馈_
