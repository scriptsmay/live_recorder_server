const FFmpegDownloader = require('./FFmpegDownloader');
const TsDownloader = require('./TsDownloader');

const INSTANCES = {
  ffmpeg: new FFmpegDownloader(),
  huya: new TsDownloader(),
};

function getActiveDownloader(platform = '') {
  if (platform === 'huya') {
    console.log('[DownloaderFactory] 使用 TsDownloader 录制虎牙直播');
    return INSTANCES.huya;
  }
  return INSTANCES.ffmpeg;
}

module.exports = { getActiveDownloader };
