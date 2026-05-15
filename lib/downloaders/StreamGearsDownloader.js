const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const DownloaderInterface = require('./DownloaderInterface');

const WRAPPER_SCRIPT = path.join(__dirname, 'stream_gears_wrapper.py');

class StreamGearsDownloader extends DownloaderInterface {
  get name() {
    return 'stream-gears';
  }

  buildArgs(url, outputPath, options = {}) {
    const { segmentDuration } = options;
    const segment = segmentDuration > 0 ? { Time: { time: segmentDuration } } : { Size: { size: 0 } };
    const config = {
      url,
      file_name: outputPath,
      segment,
      headers: {},
    };
    return [config];
  }

  spawn(args, logFd) {
    const config = args[0];
    const configStr = JSON.stringify(config);
    const proc = spawn('python3', [WRAPPER_SCRIPT, configStr], {
      stdio: ['ignore', logFd, logFd],
    });
    return proc;
  }

  static getWrapperScript() {
    return WRAPPER_SCRIPT;
  }

  static ensureWrapperScript() {
    if (!fs.existsSync(WRAPPER_SCRIPT)) {
      fs.writeFileSync(
        WRAPPER_SCRIPT,
        `import sys, json
from stream_gears import download

if __name__ == '__main__':
    config = json.loads(sys.argv[1])
    segment = config['segment']
    if 'Time' in segment:
        from stream_gears import PySegment
        seg = PySegment.time(time=segment['Time']['time'])
    else:
        from stream_gears import PySegment
        seg = PySegment.size(size=segment['Size']['size'])
    download(config['url'], config.get('headers', {}), config['file_name'], seg)
`
      );
    }
  }
}

StreamGearsDownloader.ensureWrapperScript();

module.exports = StreamGearsDownloader;
