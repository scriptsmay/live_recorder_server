'use strict';

const { extractFirstUrlFromText } = require('./platform-detector');

/**
 * Normalize Xiaohongshu / RedNote URLs into canonical form:
 * - /livestream/dynpath.../570523767964993440?... -> https://www.xiaohongshu.com/livestream/570523767964993440
 * - /hina/livestream/570523767964993440/... -> https://www.xiaohongshu.com/livestream/570523767964993440
 * - /user/profile/5f849379000000000101e56e?... -> https://www.xiaohongshu.com/user/profile/5f849379000000000101e56e
 *
 * @param {URL} parsed
 * @returns {string|null}
 */
function normalizeXiaohongshuParsedUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  const isXhsMain =
    host === 'xiaohongshu.com' ||
    host.endsWith('.xiaohongshu.com') ||
    host === 'redelight.cn' ||
    host.endsWith('.redelight.cn');

  if (!isXhsMain) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);

  // Match /user/profile/:userId
  const profileIdx = segments.findIndex((s) => s.toLowerCase() === 'profile');
  if (profileIdx >= 0 && segments[profileIdx + 1]) {
    const userId = segments[profileIdx + 1];
    return `https://www.xiaohongshu.com/user/profile/${userId}`;
  }

  // Match /livestream/... or /hina/livestream/...
  const liveIdx = segments.findIndex((s) => s.toLowerCase() === 'livestream');
  if (liveIdx >= 0) {
    const afterLive = segments.slice(liveIdx + 1).filter((seg) => !/^dynpath/i.test(seg));
    const roomIdCandidate = afterLive.find((seg) => /^\d{10,}$/.test(seg)) || afterLive[0];
    if (roomIdCandidate) {
      return `https://www.xiaohongshu.com/livestream/${roomIdCandidate}`;
    }
  }

  return null;
}

/**
 * Return the stable part of a live-room URL used as the room identifier.
 * Share links often append tracking parameters that must not create a new room.
 *
 * @param {*} roomUrl
 * @returns {*}
 */
function normalizeRoomUrl(roomUrl) {
  if (typeof roomUrl !== 'string') return roomUrl;

  const trimmed = extractFirstUrlFromText(roomUrl.trim());

  // Douyin also supports a query-only room identifier. Keep that identity
  // parameter while discarding unrelated share/tracking parameters.
  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.hostname === 'douyin.com' || parsed.hostname.endsWith('.douyin.com')) &&
      parsed.pathname === '/' &&
      parsed.searchParams.has('web_rid')
    ) {
      return `${parsed.origin}/?web_rid=${encodeURIComponent(parsed.searchParams.get('web_rid'))}`;
    }

    const xhsNormalized = normalizeXiaohongshuParsedUrl(parsed);
    if (xhsNormalized) {
      return xhsNormalized;
    }
  } catch (_) {
    // Keep the normal string-based fallback for malformed or scheme-less input.
  }

  const queryIndex = trimmed.indexOf('?');
  const fragmentIndex = trimmed.indexOf('#');
  const delimiterIndexes = [queryIndex, fragmentIndex].filter((index) => index >= 0);

  if (delimiterIndexes.length === 0) return trimmed;
  return trimmed.slice(0, Math.min(...delimiterIndexes));
}

/**
 * 判断是否为小红书个人主页链接。
 *
 * 小红书每次开播都会生成新的 room_id，个人主页链接无法推导出直播间地址，
 * 因此这类房间只能做主播信息预登记，不具备轮询开播状态的能力。
 *
 * @param {*} roomUrl
 * @returns {boolean}
 */
function isXiaohongshuProfileUrl(roomUrl) {
  if (typeof roomUrl !== 'string') return false;

  const trimmed = extractFirstUrlFromText(roomUrl.trim());
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const isXhsMain =
      host === 'xiaohongshu.com' ||
      host.endsWith('.xiaohongshu.com') ||
      host === 'redelight.cn' ||
      host.endsWith('.redelight.cn');
    if (!isXhsMain) return false;

    const segments = parsed.pathname.split('/').filter(Boolean);
    const profileIdx = segments.findIndex((s) => s.toLowerCase() === 'profile');
    return profileIdx >= 0 && Boolean(segments[profileIdx + 1]);
  } catch (_) {
    return false;
  }
}

module.exports = { normalizeRoomUrl, isXiaohongshuProfileUrl };
