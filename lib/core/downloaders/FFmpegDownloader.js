const { spawn } = require('child_process');
const readline = require('readline');
const DownloaderInterface = require('./DownloaderInterface');

class FFmpegDownloader extends DownloaderInterface {
  constructor() {
    super(); // <--- 必须有这一行，否则 EventEmitter 功能无法初始化
  }
  get name() {
    return 'ffmpeg';
  }

  getExtension() {
    return '.flv';
  }

  isSegment() {
    // flv 下载快手直播时是可以直接分段的
    return true;
  }

  buildArgs(url, outputPath, options = {}) {
    const { segmentDuration, segmentListPath } = options;
    const args = [
      '-y',
      '-f',
      'flv',
      '-i',
      url,
      '-c',
      'copy',
      '-fflags',
      '+genpts+igndts',
      '-timeout',
      '2147483647',
      '-reconnect',
      '1',
      '-reconnect_at_eof',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '60',
      '-rw_timeout',
      '30000000',
      '-analyzeduration',
      '20000000',
      '-probesize',
      '10000000',
      '-thread_queue_size',
      '512',
    ];
    if (segmentDuration > 0) {
      args.push('-f', 'segment', '-segment_time', String(segmentDuration), '-reset_timestamps', '1', '-strftime', '1');
      if (segmentListPath) {
        args.push('-segment_list', segmentListPath);
      }
    }
    args.push(outputPath);
    return args;
  }

  spawn(args) {
    const process = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    // 监听 stderr
    const rl = readline.createInterface({ input: process.stderr, terminal: false });
    rl.on('line', (line) => {
      // 1. 之前已有的：检测分片（兼容旧代码逻辑）
      const segmentMatch = line.match(/\[segment @ .*\] Opening '(.*)' for writing/);
      if (segmentMatch) {
        this.emitSegment(segmentMatch[1]);
      }

      // 2. 新增：检测单文件模式下是否开始写入
      // 当 FFmpeg 成功打开输出文件时，通常会输出类似 Output #0, mpegts, to '...'
      const outputMatch = line.match(/Output #0, .*, to '(.*)':/);
      if (outputMatch) {
        this.emit('file_created', outputMatch[1]); // 发送文件创建事件
      }

      // 3. 进度解析
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
    };
  }
}

module.exports = FFmpegDownloader;
