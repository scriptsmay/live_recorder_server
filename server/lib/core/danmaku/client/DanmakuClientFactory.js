/**
 * DanmakuClientFactory — 按平台名实例化弹幕客户端（v1.10.0）
 *
 * 平台注册表集中在这里；新增平台时在此挂入 client/platforms/*.js 即可，骨架不动。
 */
const { createModuleLogger } = require('../../logger');
const { HuyaDanmakuClient } = require('./platforms/huya');
const { BilibiliDanmakuClient } = require('./platforms/bilibili');

const PLATFORM_CLIENTS = {
  huya: HuyaDanmakuClient,
  bilibili: BilibiliDanmakuClient,
};

const loggerCache = new Map();

function getPlatformLogger(platform) {
  if (!loggerCache.has(platform)) {
    loggerCache.set(platform, createModuleLogger(`danmaku-client-${platform}`));
  }
  return loggerCache.get(platform);
}

/**
 * 创建平台弹幕客户端
 * @param {string} platform - 平台名（huya/bilibili/douyu/douyin）
 * @param {Object} opts - { roomUrl, onEvent }
 * @returns {DanmakuClientBase|null} 未知平台返回 null
 */
function createDanmakuClient(platform, opts) {
  const ClientClass = PLATFORM_CLIENTS[String(platform || '').toLowerCase()];
  if (!ClientClass) {
    return null;
  }
  return new ClientClass({ ...opts, logger: getPlatformLogger(String(platform).toLowerCase()) });
}

/** 当前支持服务端原生弹幕的平台名列表 */
function getSupportedPlatforms() {
  return Object.keys(PLATFORM_CLIENTS);
}

module.exports = { createDanmakuClient, getSupportedPlatforms };
