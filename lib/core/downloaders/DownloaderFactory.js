const FFmpegDownloader = require('./FFmpegDownloader');
const TsDownloader = require('./TsDownloader');

const INSTANCES = {
  ffmpeg: new FFmpegDownloader(),
  huya: new TsDownloader(),
};

/**
 * 根据直播间 room 的轮询平台 polling_platform 获取下载器
 * @param {string} polling_platform 轮询平台，为空则使用默认下载器 ffmpeg
 * @returns
 */
function getActiveDownloader(polling_platform = '') {
  if (polling_platform === 'huya') {
    console.log('[DownloaderFactory] 使用 TsDownloader 录制虎牙直播');
    return INSTANCES.huya;
  }
  return INSTANCES.ffmpeg;
}

module.exports = { getActiveDownloader };
