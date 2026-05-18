require('dotenv').config({ quiet: true });

const envs = process.env;
const SITE_URL = envs.SITE_URL || `http://localhost:${envs.PORT || 1123}/`;

module.exports = {
  envs,
  SITE_URL,
  MESSAGE_FEISHU_WEBHOOK: envs.MESSAGE_FEISHU_WEBHOOK || '',
  MESSAGE_GOTIFY_SERVER: envs.MESSAGE_GOTIFY_SERVER || '',
  MESSAGE_GOTIFY_TOKEN: envs.MESSAGE_GOTIFY_TOKEN || '',
  MESSAGE_GOTIFY_PRIORITY: envs.MESSAGE_GOTIFY_PRIORITY || '5',
};
