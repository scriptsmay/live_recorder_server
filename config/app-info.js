/**
 * 应用信息配置模块
 * 
 * 从 package.json 读取应用版本信息，并提供 Docker 镜像版本和应用启动时间
 */
const path = require('path');
const fs = require('fs');

// 读取并解析 package.json 文件获取应用版本信息
const PACKAGE_JSON_PATH = path.join(__dirname, '../package.json');
const PACKAGE_JSON = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));

// 应用版本号
const appVersion = PACKAGE_JSON.version;

// Docker 镜像版本，优先使用环境变量 DOCKER_IMAGE_VERSION，否则使用应用版本号
const dockerImageVersion = process.env.DOCKER_IMAGE_VERSION || appVersion;

// 应用启动时间
const startTime = new Date();

/**
 * 导出的应用信息对象
 * @property {string} appVersion - 应用程序版本号
 * @property {string} dockerImageVersion - Docker 镜像版本号
 * @property {Date} startTime - 应用启动时间
 */
module.exports = {
  appVersion,
  dockerImageVersion,
  startTime,
};
