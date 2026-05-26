const path = require('path');
const fs = require('fs');

const PACKAGE_JSON_PATH = path.join(__dirname, '../package.json');
const PACKAGE_JSON = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));

const appVersion = PACKAGE_JSON.version;
const dockerImageVersion = process.env.DOCKER_IMAGE_VERSION || appVersion;
const startTime = new Date();

module.exports = {
  appVersion,
  dockerImageVersion,
  startTime,
};
