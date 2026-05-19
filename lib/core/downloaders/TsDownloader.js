const { spawn } = require('child_process');
const readline = require('readline');
const DownloaderInterface = require('./DownloaderInterface');

class TsDownloader extends DownloaderInterface {
  constructor() {
    super(); // <--- 必须有这一行，否则 EventEmitter 功能无法初始化
  }
  get name() {
    return 'ts-downloader';
  }

  getExtension() {
    return '.ts';
  }

  /**
   * 不支持分段
   * @returns
   */
  isSegment() {
    return false;
  }

  buildArgs(url, outputPath) {
    // const { segmentDuration, segmentListPath } = options;

    // 伪装浏览器 UA，防止被 CDN 节点 403 拦截
    const userAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    const args = [
      '-y',
      '-loglevel',
      'error', // 保持控制台干净，只输出真实错误
      '-user_agent',
      userAgent, // 关键：注入 UA

      // 超时与重连控制
      '-rw_timeout',
      '15000000', // 读写超时设为 15 秒 (微秒)
      '-reconnect',
      '1',
      '-reconnect_at_eof',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '10', // 缩小最大重试延迟，超时尽早退出交给上层处理

      // 探测参数 (按需保留，对于 FLV 有好处)
      '-analyzeduration',
      '20000000',
      '-probesize',
      '10000000',

      '-i',
      url,

      '-c',
      'copy',

      // 关键：容错与时间戳修复机制
      '-fflags',
      '+genpts+igndts+discardcorrupt', // 丢弃损坏的包，防止崩溃
      '-correct_ts_overflow',
      '1', // 修复时间戳溢出
      '-avoid_negative_ts',
      '1', // 避免负时间戳导致封装失败

      // 队列控制：防止高码率直播导致缓存溢出报错
      '-thread_queue_size',
      '1024',
      '-max_muxing_queue_size',
      '1024',
    ];

    // 不处理分片，让转码前切割
    // // 分片逻辑
    // if (segmentDuration > 0) {
    //   // 建议：如果你要存 ts，segment_format 显式声明为 mpegts 会更稳
    //   args.push(
    //     '-f',
    //     'segment',
    //     '-segment_time',
    //     String(segmentDuration),
    //     '-segment_format',
    //     outputPath.endsWith('.ts') ? 'mpegts' : 'mp4',
    //     '-reset_timestamps',
    //     '1',
    //     '-strftime',
    //     '1'
    //   );

    //   if (segmentListPath) {
    //     args.push('-segment_list', segmentListPath);
    //   }
    // }

    args.push(outputPath);
    return args;
  }

  spawn(args) {
    // 保持轻量
    return spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  }

  start(url, outputPath, options) {
    const args = this.buildArgs(url, outputPath, options);
    const child = this.spawn(args);

    const rl = readline.createInterface({ input: child.stderr, terminal: false });

    rl.on('line', (line) => {
      // 1. 处理进度
      const progress = this.parseProgress(line);
      if (progress) this.emit('progress', progress);

      // 2. 处理分片 (虽然目前 isSegment 返回 false，但保留逻辑更灵活)
      const segmentMatch = line.match(/\[segment @ .*\] Opening '(.*)' for writing/);
      if (segmentMatch) this.emitSegment(segmentMatch[1]);
    });

    child.stderr.on('data', (data) => {
      const line = data.toString();
      const progress = this.parseProgress(line);
      if (progress) {
        // 通过事件对外广播进度
        this.emit('progress', progress);
      }
    });

    child.on('close', (code) => {
      this.emit('exit', code);
    });

    return child; // 返回 child 给外部，以便调用 kill 等方法
  }

  parseProgress(stderrLine) {
    // 如果当前行不是进度信息（不包含 frame=），直接返回 null
    if (!stderrLine.includes('frame=')) return null;

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
    };
  }
}

module.exports = TsDownloader;
