'use strict';

const https = require('https');
const PlatformChecker = require('./PlatformChecker');
const { extractFirstUrlFromText } = require('../../utils/platform-detector');
const { normalizeRoomUrl } = require('../../utils/room-url');
const { createModuleLogger } = require('../logger');

const log = createModuleLogger('polling');

const XHS_IOS_USER_AGENT = 'ios/7.830 (ios 17.0; ; iPhone 15 (A2846/A3089/A3090/A3092))';
const XHS_COMMON_PARAMS = 'platform=iOS&sid=session.1722166379345546829388';
const XHS_APP_REFERER = 'https://app.xhs.cn/';
const XHS_PC_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const XHS_MOBILE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;

function isEnabled(value) {
  return String(value ?? 'true').toLowerCase() !== 'false';
}

class XiaohongshuChecker extends PlatformChecker {
  constructor(roomUrl, options = {}) {
    super(roomUrl);
    this._timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  static getPlatformId() {
    return 'xiaohongshu';
  }

  static canHandleUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const cleaned = extractFirstUrlFromText(url);
    return /(?:^|\.|\/)(?:xiaohongshu\.com|xhslink\.com|redelight\.cn)/i.test(cleaned);
  }

  /**
   * Resolve an xhslink.com short URL via GET (redirect: 'manual') because
   * Xiaohongshu's karen-gateway returns 404 for HEAD requests.
   *
   * @param {string} rawUrl
   * @returns {Promise<string>}
   */
  static async resolveShortUrl(rawUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
    let currentUrl = extractFirstUrlFromText(String(rawUrl || '').trim());
    if (!currentUrl) return rawUrl;
    if (!/^https?:\/\//i.test(currentUrl)) {
      currentUrl = `https://${currentUrl}`;
    }

    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (_) {
        break;
      }

      const host = parsed.hostname.toLowerCase();
      if (host !== 'xhslink.com' && !host.endsWith('.xhslink.com')) {
        break;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': XHS_IOS_USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });
        const location = response.headers.get('location') || response.headers.get('Location');
        if (location) {
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }
        break;
      } catch (err) {
        log.warn(`[XiaohongshuChecker] 解析短链失败 (${currentUrl}): ${err.message}`);
        break;
      } finally {
        clearTimeout(timer);
      }
    }

    return currentUrl;
  }

  /**
   * Parse roomId and hostId from a resolved Xiaohongshu URL.
   *
   * @param {string} resolvedUrl
   * @returns {{ roomId: string|null, hostId: string|null, isProfileUrl: boolean, canonicalUrl: string }}
   */
  static parseUrlIdentifiers(resolvedUrl) {
    const cleaned = extractFirstUrlFromText(String(resolvedUrl || '').trim());
    const withScheme = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;

    try {
      const parsed = new URL(withScheme);
      const segments = parsed.pathname.split('/').filter(Boolean);
      const queryHostId = parsed.searchParams.get('host_id') || parsed.searchParams.get('hostId') || null;

      // /user/profile/:userId
      const profileIdx = segments.findIndex((s) => s.toLowerCase() === 'profile');
      if (profileIdx >= 0 && segments[profileIdx + 1]) {
        const hostId = segments[profileIdx + 1];
        return {
          roomId: null,
          hostId,
          isProfileUrl: true,
          canonicalUrl: `https://www.xiaohongshu.com/user/profile/${hostId}`,
        };
      }

      // /livestream/:roomId or /livestream/dynpath.../:roomId or /hina/livestream/:roomId
      const liveIdx = segments.findIndex((s) => s.toLowerCase() === 'livestream');
      if (liveIdx >= 0) {
        const afterLive = segments.slice(liveIdx + 1).filter((seg) => !/^dynpath/i.test(seg));
        const roomId = afterLive.find((seg) => /^\d{10,}$/.test(seg)) || afterLive[0] || null;
        return {
          roomId,
          hostId: queryHostId,
          isProfileUrl: false,
          canonicalUrl: normalizeRoomUrl(withScheme),
        };
      }

      const queryRoomId = parsed.searchParams.get('room_id') || parsed.searchParams.get('roomId') || null;
      return {
        roomId: queryRoomId,
        hostId: queryHostId,
        isProfileUrl: false,
        canonicalUrl: normalizeRoomUrl(withScheme),
      };
    } catch (_) {
      return {
        roomId: null,
        hostId: null,
        isProfileUrl: false,
        canonicalUrl: cleaned,
      };
    }
  }

  /**
   * Parse window.__INITIAL_STATE__ or window.__INITIAL_SSR_STATE__ from HTML.
   *
   * @param {string} html
   * @returns {object|null}
   */
  static extractInitialState(html) {
    if (!html || typeof html !== 'string') return null;

    const match = html.match(
      /<script>\s*window\.__(?:INITIAL_STATE|INITIAL_SSR_STATE)__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/
    );
    if (!match || !match[1]) return null;

    try {
      const sanitized = match[1].replace(/([:,\[])\s*undefined\b/g, '$1null');
      return JSON.parse(sanitized);
    } catch (err) {
      log.warn(`[XiaohongshuChecker] 解析 __INITIAL_STATE__ JSON 失败: ${err.message}`);
      return null;
    }
  }

  /**
   * Extract stream URLs and hostId from roomInfo.pullConfig and roomInfo.deeplink.
   *
   * @param {object} roomInfo
   * @returns {{ streamUrl: string|null, backupUrls: string[], hostId: string|null }}
   */
  static parseStreamAndDeeplink(roomInfo) {
    if (!roomInfo || typeof roomInfo !== 'object') {
      return { streamUrl: null, backupUrls: [], hostId: null };
    }

    let hostId = null;
    let deeplinkFlvRoomId = null;

    if (typeof roomInfo.deeplink === 'string' && roomInfo.deeplink) {
      try {
        const dlUrl = new URL(roomInfo.deeplink);
        hostId = dlUrl.searchParams.get('host_id') || dlUrl.searchParams.get('hostId') || null;
        const flvUrl = dlUrl.searchParams.get('flvUrl') || '';
        const roomMatch = flvUrl.match(/\/live\/([^.?/]+)\.(?:flv|m3u8)/i);
        if (roomMatch) {
          deeplinkFlvRoomId = roomMatch[1];
        }
      } catch (_) {}
    }

    const flvUrls = [];
    const hlsUrls = [];

    if (roomInfo.pullConfig) {
      try {
        const pullConfig =
          typeof roomInfo.pullConfig === 'string' ? JSON.parse(roomInfo.pullConfig) : roomInfo.pullConfig;
        const h264List = Array.isArray(pullConfig?.h264) ? pullConfig.h264 : [];
        const h265List = Array.isArray(pullConfig?.h265) ? pullConfig.h265 : [];

        for (const item of [...h264List, ...h265List]) {
          const masterUrl = item?.master_url || item?.url;
          if (!masterUrl || typeof masterUrl !== 'string') continue;
          if (/\.flv(\?|$)/i.test(masterUrl)) {
            flvUrls.push(masterUrl);
          } else if (/\.m3u8(\?|$)/i.test(masterUrl)) {
            hlsUrls.push(masterUrl);
          }
        }
      } catch (err) {
        log.warn(`[XiaohongshuChecker] 解析 pullConfig 失败: ${err.message}`);
      }
    }

    const fallbackRoomId = deeplinkFlvRoomId || (roomInfo.roomId ? String(roomInfo.roomId) : null);
    if (flvUrls.length === 0 && hlsUrls.length === 0 && fallbackRoomId) {
      flvUrls.push(`http://live-source-play.xhscdn.com/live/${fallbackRoomId}.flv`);
      hlsUrls.push(`http://live-source-play.xhscdn.com/live/${fallbackRoomId}.m3u8`);
    }

    const allCandidates = [...flvUrls, ...hlsUrls];
    const streamUrl = allCandidates[0] || null;
    const backupUrls = allCandidates.slice(1);

    return { streamUrl, backupUrls, hostId };
  }

  /**
   * Fetch HTML over HTTP/1.1 via node `https.get` (avoids HTTP/2 ALPN + Sec-Fetch-Mode
   * header fingerprinting on Xiaohongshu PC Web SSR routes).
   *
   * @param {string} url
   * @param {object} [options]
   * @returns {Promise<string>}
   */
  static fetchProfileHtml(url, options = {}) {
    const timeoutMs = options.timeout || DEFAULT_TIMEOUT_MS;
    const headers = {
      'User-Agent': XHS_PC_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...(options.headers || {}),
    };

    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers, timeout: timeoutMs }, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve(body));
      });
      req.on('timeout', () => {
        req.destroy(new Error(`Request timeout (${timeoutMs}ms): ${url}`));
      });
      req.on('error', reject);
    });
  }

  /**
   * Fetch anchor metadata from /user/profile/:hostId when added while offline.
   * Uses PC Web SSR over HTTP/1.1 (no xsec_token or cookie required) with fallback
   * to Mobile H5 SSR when the original URL contains an xsec_token.
   *
   * @param {string} hostId
   * @param {string} [originalUrl]
   * @returns {Promise<{ roomName: string, roomCover: string }>}
   */
  async _fetchProfileMetadata(hostId, originalUrl = '') {
    const profileUrl = `https://www.xiaohongshu.com/user/profile/${hostId}`;
    try {
      const html = await XiaohongshuChecker.fetchProfileHtml(profileUrl, {
        timeout: this._timeoutMs,
      });
      const state = XiaohongshuChecker.extractInitialState(html);
      const userInfo = state?.user?.userPageData?.basicInfo || state?.profile?.userInfo || {};
      const roomName = (userInfo.nickname || userInfo.nickName || '').trim();
      const roomCover = (userInfo.images || userInfo.imageb || userInfo.image || userInfo.avatar || '').trim();
      if (roomName || roomCover) {
        return { roomName, roomCover };
      }
    } catch (err) {
      log.debug(`[XiaohongshuChecker] PC 主页元信息获取跳过 (${hostId}): ${err.message}`);
    }

    // Fallback: if original URL carries xsec_token, Mobile Safari SSR returns state.profile.userInfo
    if (originalUrl && originalUrl.includes('xsec_token=')) {
      try {
        const html = await PlatformChecker.fetchText(originalUrl, {
          timeout: this._timeoutMs,
          headers: {
            'User-Agent': XHS_MOBILE_SAFARI_UA,
          },
        });
        const state = XiaohongshuChecker.extractInitialState(html);
        const userInfo = state?.profile?.userInfo || state?.user?.userPageData?.basicInfo || {};
        const roomName = (userInfo.nickname || userInfo.nickName || '').trim();
        const roomCover = (userInfo.images || userInfo.imageb || userInfo.image || userInfo.avatar || '').trim();
        return { roomName, roomCover };
      } catch (err) {
        log.debug(`[XiaohongshuChecker] H5 主页元信息获取跳过 (${hostId}): ${err.message}`);
      }
    }

    return { roomName: '', roomCover: '' };
  }

  async checkStatus() {
    if (!isEnabled(process.env.XIAOHONGSHU_CHECKER_ENABLED)) {
      return PlatformChecker.normalizeResult({
        isLive: false,
        recordable: false,
        error: 'Xiaohongshu checker is disabled via XIAOHONGSHU_CHECKER_ENABLED=false',
      });
    }

    try {
      const resolvedUrl = await XiaohongshuChecker.resolveShortUrl(this.roomUrl, this._timeoutMs);
      const { roomId, hostId, isProfileUrl } = XiaohongshuChecker.parseUrlIdentifiers(resolvedUrl);

      if (isProfileUrl && !roomId) {
        const meta = await this._fetchProfileMetadata(hostId, resolvedUrl);
        return PlatformChecker.normalizeResult({
          isLive: false,
          recordable: false,
          roomName: meta.roomName,
          roomCover: meta.roomCover,
          avatarUrl: meta.roomCover,
          streamInfo: {
            hostId,
            isProfileUrl: true,
            note: '小红书每次开播生成独立 room_id，个人主页链接仅用于预登记主播信息，无法免登录轮询开播状态；开播时请使用直播间分享链接（xhslink.com 或 /livestream/{room_id}）',
          },
        });
      }

      if (!roomId) {
        return PlatformChecker.normalizeResult({
          isLive: false,
          recordable: false,
          error: `无法从小红书链接提取 roomId: ${this.roomUrl}`,
        });
      }

      const livestreamUrl = `https://www.xiaohongshu.com/livestream/${roomId}`;
      const html = await PlatformChecker.fetchText(livestreamUrl, {
        timeout: this._timeoutMs,
        headers: {
          'User-Agent': XHS_IOS_USER_AGENT,
          'xy-common-params': XHS_COMMON_PARAMS,
          Referer: XHS_APP_REFERER,
        },
      });

      const state = XiaohongshuChecker.extractInitialState(html);
      const liveStream = state?.liveStream;
      if (!liveStream) {
        return PlatformChecker.normalizeResult({
          isLive: false,
          recordable: false,
          error: '小红书直播页未返回有效 __INITIAL_STATE__.liveStream',
        });
      }

      const hostInfo = liveStream.roomData?.hostInfo || {};
      const roomInfo = liveStream.roomData?.roomInfo || {};
      const roomName = (hostInfo.nickName || hostInfo.nickname || '').trim();
      const roomTitle = (roomInfo.roomTitle || roomInfo.name || '').trim();
      const avatarUrl = (hostInfo.avatar || hostInfo.images || hostInfo.image || '').trim();
      const roomCover = (roomInfo.roomCover || avatarUrl).trim();

      // Strictly check liveStatus === 'success' and status === 2 (ignore nextRoomInfo on end!)
      const isLive =
        liveStream.liveStatus === 'success' && Number(roomInfo.status) === 2 && !roomTitle.includes('回放');

      if (!isLive) {
        return PlatformChecker.normalizeResult({
          isLive: false,
          recordable: true,
          roomName,
          roomTitle,
          roomCover,
          avatarUrl,
        });
      }

      const { streamUrl, backupUrls, hostId: dlHostId } = XiaohongshuChecker.parseStreamAndDeeplink(roomInfo);
      const finalHostId = dlHostId || hostId || null;

      return PlatformChecker.normalizeResult({
        isLive: Boolean(streamUrl),
        recordable: Boolean(streamUrl),
        roomName,
        roomTitle,
        roomCover,
        avatarUrl,
        streamUrl,
        streamInfo: {
          roomId: String(roomInfo.roomId || roomId),
          ...(finalHostId ? { hostId: finalHostId } : {}),
          ...(backupUrls.length > 0 ? { backupUrls: backupUrls.join(',') } : {}),
        },
      });
    } catch (err) {
      log.error(`[XiaohongshuChecker] 检查直播状态失败 (${this.roomUrl}): ${err.message}`);
      return PlatformChecker.normalizeResult({
        isLive: false,
        recordable: false,
        error: err.message,
      });
    }
  }
}

module.exports = XiaohongshuChecker;
