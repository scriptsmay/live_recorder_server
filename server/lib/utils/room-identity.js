'use strict';

const { extractFirstUrlFromText } = require('./platform-detector');

/**
 * Xiaohongshu 直播身份解析。
 *
 * 小红书的直播间地址（/livestream/{room_id}）是「单场」地址，每次开播变化；
 * 个人主页（/user/profile/{user_id}）才是稳定的录制目标。分享链接通常带
 * `host_id` 查询参数，是开播时把场次归并到目标的唯一可靠线索。
 *
 * 本模块只做纯字符串解析，不发起请求，便于服务端与测试复用。
 */

function isXiaohongshuHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return (
    host === 'xiaohongshu.com' ||
    host.endsWith('.xiaohongshu.com') ||
    host === 'redelight.cn' ||
    host.endsWith('.redelight.cn')
  );
}

/**
 * 从任意小红书链接（个人主页 / 直播间 / xhslink 解析结果 / 分享文本）解析身份。
 *
 * @param {*} input
 * @returns {{ hostUserId: string|null, liveRoomId: string|null, isProfile: boolean,
 *             profileUrl: string|null, liveUrl: string|null } | null} 非小红书链接返回 null
 */
function parseXiaohongshuIdentity(input) {
  if (typeof input !== 'string') return null;

  const trimmed = extractFirstUrlFromText(input.trim());
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_) {
    return null;
  }

  if (!isXiaohongshuHost(parsed.hostname)) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  let hostUserId = parsed.searchParams.get('host_id') || parsed.searchParams.get('hostId') || null;
  let liveRoomId = parsed.searchParams.get('room_id') || parsed.searchParams.get('roomId') || null;
  let isProfile = false;

  const profileIdx = segments.findIndex((s) => s.toLowerCase() === 'profile');
  if (profileIdx >= 0 && segments[profileIdx + 1]) {
    hostUserId = segments[profileIdx + 1];
    isProfile = true;
  }

  const liveIdx = segments.findIndex((s) => s.toLowerCase() === 'livestream');
  if (liveIdx >= 0) {
    const afterLive = segments.slice(liveIdx + 1).filter((seg) => !/^dynpath/i.test(seg));
    liveRoomId = afterLive.find((seg) => /^\d{10,}$/.test(seg)) || afterLive[0] || liveRoomId;
    isProfile = false;
  }

  if (!hostUserId && !liveRoomId) return null;

  return {
    hostUserId: hostUserId || null,
    liveRoomId: liveRoomId || null,
    isProfile,
    profileUrl: hostUserId ? buildXiaohongshuProfileUrl(hostUserId) : null,
    liveUrl: liveRoomId ? buildXiaohongshuLiveUrl(liveRoomId) : null,
  };
}

/**
 * @param {string} hostUserId
 * @returns {string}
 */
function buildXiaohongshuProfileUrl(hostUserId) {
  return `https://www.xiaohongshu.com/user/profile/${hostUserId}`;
}

/**
 * @param {string} liveRoomId
 * @returns {string}
 */
function buildXiaohongshuLiveUrl(liveRoomId) {
  return `https://www.xiaohongshu.com/livestream/${liveRoomId}`;
}

module.exports = {
  parseXiaohongshuIdentity,
  buildXiaohongshuProfileUrl,
  buildXiaohongshuLiveUrl,
  isXiaohongshuHost,
};
