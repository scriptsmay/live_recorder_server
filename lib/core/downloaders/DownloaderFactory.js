const FFmpegDownloader = require('./FFmpegDownloader');

const INSTANCES = {
  ffmpeg: new FFmpegDownloader(),
};

async function getActiveDownloader(platform = '') {
  if (platform === 'huya') {
    console.log('[DownloaderFactory] 使用 Python 下载器录制虎牙直播');
    // [TODO]
    // return INSTANCES.python;
  }
  return INSTANCES.ffmpeg;
}

module.exports = { getActiveDownloader };
