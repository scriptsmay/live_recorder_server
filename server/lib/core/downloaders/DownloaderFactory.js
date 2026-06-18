const FFmpegDownloader = require('./FFmpegDownloader');

const INSTANCE = new FFmpegDownloader();

/**
 * 获取 FFmpeg 下载器（现在所有平台统一使用 FFmpegDownloader）
 * @param {string} polling_platform - 轮询平台（已不再使用，保留参数兼容）
 * @returns {Object} FFmpegDownloader 实例
 */
function getActiveDownloader(_polling_platform = '') {
  // 现在所有平台统一使用 FFmpegDownloader
  return INSTANCE;
}

module.exports = { getActiveDownloader };
