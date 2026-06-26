require('./env').initEnv();
const path = require('path');

const envs = process.env;
const SITE_URL = envs.SITE_URL || `http://localhost:${envs.PORT || 1123}/`;

// 允许转码的格式
const SUPPORTED_EXT_REGEX = /\.(flv|ts|mp4)$/i;
const SUPPORTED_TRANSCODE_EXT = /\.(flv|ts)$/i;

function getReplayWorkDir() {
  return envs.REPLAY_WORK_DIR || path.join(path.dirname(envs.VIDEO_DOWNLOAD_DIR || '.'), 'replay');
}

// 项目根目录（logs/ 等运行时目录的基准路径）
function getLogsDir() {
  return envs.LOG_DIR || path.join(__dirname, '..', '..');
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
  getReplayWorkDir,
  getLogsDir,
};
