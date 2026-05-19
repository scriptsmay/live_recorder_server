const { spawn } = require('child_process');
const path = require('path');
const DownloaderInterface = require('./DownloaderInterface');

class HuyaPythonDownloader extends DownloaderInterface {
  get name() {
    return 'huya-python';
  }

  getExtension() {
    return '.ts';
  }

  buildArgs(url, outputPath, options = {}) {
    const { segmentDuration, quality = 'UHD', maxRetries = 30 } = options;
    const scriptPath = path.resolve(__dirname, './huya_downloader.py');
    const args = [
      scriptPath,
      '--url',
      url,
      '--output',
      outputPath,
      '--quality',
      quality,
      '--max-retries',
      String(maxRetries),
    ];
    if (segmentDuration > 0) {
      args.push('--segment-duration', String(segmentDuration));
    }
    return args;
  }

  spawn(args) {
    return spawn('python3', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
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
    console.log('huya-python errorCode', errorCode)
    return {
      shouldRetry: false,
      delayMs: 0,
      maxRetries: 0,
    };
  }

  getDefaultOptions() {
    return {
      segmentDuration: 0,
      quality: 'UHD',
      isStreamUrl: false,
    };
  }
}

module.exports = HuyaPythonDownloader;
