require('./env').initEnv();
const path = require('path');

const envs = process.env;
const SITE_URL = envs.SITE_URL || `http://localhost:${envs.PORT || 1123}/`;

// 允许转码的格式
const SUPPORTED_EXT_REGEX = /\.(flv|ts|mp4)$/i;
const SUPPORTED_TRANSCODE_EXT = /\.(flv|ts)$/i;

// 弹幕压制产物后缀，用于在文件扫描时排除，避免被误当作录制分段计入统计或投稿
const DANMAKU_BURN_SUFFIX = '_danmaku.mp4';
function isDanmakuBurnFile(filename) {
  return filename.toLowerCase().endsWith(DANMAKU_BURN_SUFFIX);
}

// 弹幕压制产物独立输出目录
function getDanmakuOutputDir() {
  return envs.DANMAKU_OUTPUT_DIR || path.join(path.dirname(envs.VIDEO_DOWNLOAD_DIR || '.'), 'danmaku_output');
}

module.exports = {
  envs,
  SITE_URL,
  MESSAGE_FEISHU_WEBHOOK: envs.MESSAGE_FEISHU_WEBHOOK || '',
  MESSAGE_GOTIFY_SERVER: envs.MESSAGE_GOTIFY_SERVER || '',
  MESSAGE_GOTIFY_TOKEN: envs.MESSAGE_GOTIFY_TOKEN || '',
  MESSAGE_GOTIFY_PRIORITY: envs.MESSAGE_GOTIFY_PRIORITY || '5',
  VIDEO_TYPES: '(flv|mp4|ts)',
  SUPPORTED_EXT_REGEX,
  SUPPORTED_TRANSCODE_EXT,
  DANMAKU_BURN_SUFFIX,
  isDanmakuBurnFile,
  getDanmakuOutputDir,
};
