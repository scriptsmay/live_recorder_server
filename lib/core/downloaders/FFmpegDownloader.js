const { spawn } = require('child_process');
const readline = require('readline');
const DownloaderInterface = require('./DownloaderInterface');

class FFmpegDownloader extends DownloaderInterface {
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
      // 如果匹配到分片，触发接口定义的 emitSegment
      const match = line.match(/\[segment @ .*\] Opening '(.*)' for writing/);
      if (match) {
        this.emitSegment(match[1]); // 统一通过事件向上层发送
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
