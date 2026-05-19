require('./env').initEnv();

const envs = process.env;
const SITE_URL = envs.SITE_URL || `http://localhost:${envs.PORT || 1123}/`;

// 允许转码的格式
const SUPPORTED_EXT_REGEX = /\.(flv|ts|mp4)$/i;
const SUPPORTED_TRANSCODE_EXT = /\.(flv|ts)$/i;

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
};
