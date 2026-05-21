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
    return '.ts';
  }

  isSegment() {
    // ts 格式支持分段录制
    return true;
  }

  buildArgs(url, outputPath, options = {}) {
    const { segmentDuration, segmentListPath } = options;
    
    // 伪装浏览器 UA，防止被 CDN 节点 403 拦截
    const userAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    const args = [
      '-y',
      
      // 超时与重连控制
      '-rw_timeout',
      '30000000', // 读写超时设为 30 秒 (微秒)
      '-reconnect',
      '1',
      '-reconnect_at_eof',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '60', // 最大重试延迟
      
      // 用户代理
      '-user_agent',
      userAgent,
      
      // 协议白名单
      '-protocol_whitelist',
      'rtmp,crypto,file,http,https,tcp,tls,udp,rtp,httpproxy',
      
      // 输入分析
      '-analyzeduration',
      '20000000',
      '-probesize',
      '20000000',
      
      '-i',
      url,
      
      // 编解码
      '-c',
      'copy',
      '-map',
      '0',
      
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
      '2048',
      
      // 字幕和数据处理
      '-sn',
      '-dn',
      
      // 缓冲区大小
      '-bufsize',
      '15000k',
    ];
    
    if (segmentDuration > 0) {
      args.push(
        '-f', 'segment',
        '-segment_time', String(segmentDuration),
        '-segment_format', 'mpegts',
        '-reset_timestamps', '1',
        '-strftime', '1'
      );
      if (segmentListPath) {
        args.push('-segment_list', segmentListPath);
      }
    } else {
      args.push('-f', 'mpegts');
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
