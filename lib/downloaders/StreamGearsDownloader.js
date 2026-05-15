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
    // stream-gears 会自动追加 .flv 后缀，去掉 outputPath 的扩展名避免重复
    const cleanPath = outputPath.replace(/\.flv$/i, '');
    const config = {
      url,
      file_name: cleanPath,
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
