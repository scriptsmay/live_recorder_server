'use strict';

/**
 * 通过 Chrome 扩展采集弹幕的平台（服务端无原生弹幕客户端）。
 *
 * 房间级 `extension_danmaku_enabled` 只对这些平台生效：
 * 开启后由扩展打开后台标签页采集弹幕并经 `POST /api/danmaku/batch` 推送。
 */
const EXTENSION_DANMAKU_PLATFORMS = new Set(['kuaishou', 'xiaohongshu']);

/**
 * @param {*} platform
 * @returns {boolean}
 */
function supportsExtensionDanmaku(platform) {
  return EXTENSION_DANMAKU_PLATFORMS.has(String(platform || '').toLowerCase());
}

module.exports = { EXTENSION_DANMAKU_PLATFORMS, supportsExtensionDanmaku };
