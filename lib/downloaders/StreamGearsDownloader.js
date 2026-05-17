const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const DownloaderInterface = require('./DownloaderInterface');

const WRAPPER_SCRIPT = path.join(__dirname, 'stream_gears_wrapper.py');

class StreamGearsDownloader extends DownloaderInterface {
  get name() {
    return 'stream-gears';
  }

  getExtension() {
    return '.flv';
  }

  buildArgs(url, outputPath, options = {}) {
    const { segmentDuration } = options;
    const segment = segmentDuration > 0 ? { Time: { time: segmentDuration } } : { Size: { size: 0 } };
    const cleanPath = outputPath.replace(/\.flv$/i, '');
    const config = {
      url,
      file_name: cleanPath,
      segment,
      headers: {},
    };
    return [config];
  }

  spawn(args) {
    const config = args[0];
    const configStr = JSON.stringify(config);
    const proc = spawn('python3', [WRAPPER_SCRIPT, configStr], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    return proc;
  }

  parseProgress(stdoutLine) {
    const progress = {};

    const segmentMatch = stdoutLine.match(/segment\s+(\d+)\s+completed/i);
    if (segmentMatch) {
      progress.segment = parseInt(segmentMatch[1], 10);
    }

    const downloadMatch = stdoutLine.match(/downloaded\s+([\d.]+)\s*(kB|MB|GB)/i);
    if (downloadMatch) {
      let sizeBytes = parseFloat(downloadMatch[1]);
      const unit = downloadMatch[2].toLowerCase();
      if (unit === 'kb') sizeBytes *= 1024;
      if (unit === 'mb') sizeBytes *= 1024 * 1024;
      if (unit === 'gb') sizeBytes *= 1024 * 1024 * 1024;
      progress.sizeBytes = sizeBytes;
    }

    if (Object.keys(progress).length > 0) {
      return progress;
    }
    return null;
  }

  getRetryStrategy(errorCode) {
    if (errorCode !== 0) {
      return {
        shouldRetry: true,
        delayMs: 3000,
        maxRetries: 2,
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
      autoRepair: true,
    };
  }

  static getWrapperScript() {
    return WRAPPER_SCRIPT;
  }

  static ensureWrapperScript() {
    if (!fs.existsSync(WRAPPER_SCRIPT)) {
      fs.writeFileSync(
        WRAPPER_SCRIPT,
        `import sys, json
from stream_gears import download, PySegment

if __name__ == '__main__':
    config = json.loads(sys.argv[1])
    segment = config['segment']
    seg = PySegment()
    if 'Time' in segment:
        seg.time = segment['Time']['time']
    else:
        seg.size = segment['Size']['size']
    download(config['url'], config.get('headers', {}), config['file_name'], seg)
`
      );
    }
  }
}

StreamGearsDownloader.ensureWrapperScript();

module.exports = StreamGearsDownloader;
