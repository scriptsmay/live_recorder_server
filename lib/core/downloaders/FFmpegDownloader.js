const { spawn } = require('child_process');
const readline = require('readline');
const DownloaderInterface = require('./DownloaderInterface');
const { getOptimalUserAgent } = require('../config/userAgents');

class FFmpegDownloader extends DownloaderInterface {
  constructor() {
    super();
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
   * 异步流类型检测（供外部调用）
   * @param {string} url - 流地址
   * @returns {Promise<{type: string, metadata: object}>}
   */
  async detectStreamType(url) {
    // 第一层：URL 特征检测（同步，快速判断）
    const urlType = this._detectStreamTypeByUrl(url);
    if (urlType !== 'unknown') {
      return { type: urlType, metadata: { source: 'url' } };
    }

    // 第二层：HTTP 头检测（异步，更可靠）
    const headerType = await this._detectStreamTypeByHeaders(url);
    return { type: headerType, metadata: { source: 'header' } };
  }

  /**
   * URL 特征检测流类型
   */
  _detectStreamTypeByUrl(url) {
    const urlLower = url.toLowerCase();

    if (urlLower.includes('.m3u8') || urlLower.includes('/hls/') || urlLower.includes('playlist')) {
      return 'hls';
    }

    if (urlLower.includes('.flv') || urlLower.includes('/flv/')) {
      return 'flv';
    }

    return 'unknown';
  }

  /**
   * HTTP 头检测流类型
   * 优先 HEAD 请求检查 Content-Type，回退到 Range GET 读取前 100 字节
   */
  async _detectStreamTypeByHeaders(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      // 第一步：HEAD 请求检查 Content-Type（不下载响应体）
      const headResp = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': getOptimalUserAgent() },
      });

      const contentType = headResp.headers.get('content-type');
      if (contentType?.includes('mpegurl') || contentType?.includes('m3u8')) {
        return 'hls';
      }

      // HEAD 已知是 FLV content-type 时直接返回
      if (contentType?.includes('x-flv')) {
        return 'flv';
      }

      // 第二步：Range GET 读取前 100 字节检查内容标记
      const rangeResp = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': getOptimalUserAgent(),
          Range: 'bytes=0-100',
        },
      });

      // 快速读取小块数据后立即消费响应体以释放连接
      const buffer = await rangeResp.arrayBuffer();
      const text = new TextDecoder().decode(buffer);

      if (text.includes('#EXTM3U')) {
        return 'hls';
      }

      return 'flv';
    } catch (err) {
      console.warn('[FFmpegDownloader] 流类型检测失败，默认使用 FLV 参数:', err.message);
      return 'flv';
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 构建 FFmpeg 参数（根据流类型选择策略）
   */
  buildArgs(url, outputPath, options = {}) {
    const { streamType = 'flv' } = options;

    if (streamType === 'hls') {
      return this._buildHLSArgs(url, outputPath, options);
    }

    return this._buildStandardArgs(url, outputPath, options);
  }

  /**
   * 标准 FLV/TS 流参数
   */
  _buildStandardArgs(url, outputPath, options) {
    const { segmentDuration, segmentListPath } = options;
    const userAgent = getOptimalUserAgent();

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
      userAgent,

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

    this._appendSegmentArgs(args, segmentDuration, segmentListPath);

    args.push(outputPath);
    return args;
  }

  /**
   * HLS/m3u8 流专用参数
   */
  _buildHLSArgs(url, outputPath, options) {
    const { segmentDuration, segmentListPath } = options;
    const userAgent = getOptimalUserAgent();

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
      userAgent,

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

    this._appendSegmentArgs(args, segmentDuration, segmentListPath);

    args.push(outputPath);
    return args;
  }

  /**
   * 追加分段录制参数（共用逻辑）
   */
  _appendSegmentArgs(args, segmentDuration, segmentListPath) {
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
      if (segmentListPath) {
        args.push('-segment_list', segmentListPath);
      }
    } else {
      args.push('-f', 'mpegts');
    }
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
      streamType: 'flv',
    };
  }
}

module.exports = FFmpegDownloader;
