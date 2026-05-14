require('dotenv').config({ quiet: true });

const envs = process.env;
const SITE_URL = envs.SITE_URL || `http://localhost:${envs.PORT || 1123}/`;

module.exports = {
  envs,
  SITE_URL,
};
