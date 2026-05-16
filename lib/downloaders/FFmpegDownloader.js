const { spawn } = require('child_process');
const DownloaderInterface = require('./DownloaderInterface');

class FFmpegDownloader extends DownloaderInterface {
  get name() {
    return 'ffmpeg';
  }

  buildArgs(url, outputPath, options = {}) {
    const { segmentDuration } = options;
    const args = [
      '-i',
      url,
      '-c',
      'copy',
      '-fflags',
      '+genpts',
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
    ];
    if (segmentDuration > 0) {
      args.push('-f', 'segment', '-segment_time', String(segmentDuration), '-reset_timestamps', '1', '-strftime', '1');
    }
    args.push(outputPath);
    return args;
  }

  spawn(args) {
    return spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
    });
  }
}

module.exports = FFmpegDownloader;
