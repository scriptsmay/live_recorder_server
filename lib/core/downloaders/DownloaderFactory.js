const FFmpegDownloader = require('./FFmpegDownloader');
const TsDownloader = require('./TsDownloader');

const INSTANCES = {
  ffmpeg: new FFmpegDownloader(),
  huya: new TsDownloader(),
};

async function getActiveDownloader(platform = '') {
  if (platform === 'huya') {
    console.log('[DownloaderFactory] 使用 Python 下载器录制虎牙直播');
    return INSTANCES.huya;
  }
  return INSTANCES.ffmpeg;
}

module.exports = { getActiveDownloader };
