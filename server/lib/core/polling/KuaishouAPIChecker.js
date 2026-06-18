const crypto = require('crypto');

const redis = require('../../../db/redis');
const PlatformChecker = require('./PlatformChecker');

const KUAISHOU_BASE_URL = 'https://live.kuaishou.com';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_ROOM_INTERVAL_SECONDS = 60;
const DEFAULT_GLOBAL_INTERVAL_SECONDS = 10;
const DEFAULT_BACKOFF_SECONDS = 120;
const LAST_POLL_TTL_SECONDS = 86400;
const ROOM_NAME_CACHE_TTL_SECONDS = 86400;
const ROOM_NAME_EMPTY_MARKER = '-';
const ANTICRAWL_PATTERN = /请求过快|验证码|风控|400002/i;

function isEnabled(value) {
  return String(value ?? 'true').toLowerCase() !== 'false';
}

function nowMs() {
  return Date.now();
}

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

class KuaishouChecker extends PlatformChecker {
  constructor(roomUrl, options = {}) {
    super(roomUrl);
    this.redis = options.redis || redis;
    this._now = options.now || nowMs;
    this._roomKey = null;
  }

  static getPlatformId() {
    return 'kuaishou';
  }

  static canHandleUrl(url) {
    return /(?:^|\.)kuaishou\.com/i.test(url || '');
  }

  static extractPrincipalId(url) {
    try {
      const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      const parsed = new URL(normalized);
      const segments = parsed.pathname.split('/').filter(Boolean);
      const uIndex = segments.findIndex((segment) => segment.toLowerCase() === 'u');
      const principal = uIndex >= 0 ? segments[uIndex + 1] : segments[segments.length - 1];
      return principal ? principal.split('?')[0].split('#')[0] : null;
    } catch (_) {
      return null;
    }
  }

  static redactUrl(url) {
    if (!url) return url;
    return url.replace(/([?&](txSecret|hwSecret|wsSecret|stat|token|sign|sig)=)[^&]+/gi, '$1<redacted>');
  }

  static pickBestStreamUrl(liveStream) {
    const candidates = [];
    const codecSources = [
      ['h264', liveStream?.playUrls?.h264],
      ['hevc', liveStream?.playUrls?.hevc],
      ['h265', liveStream?.playUrls?.h265],
    ];

    for (const [codec, source] of codecSources) {
      const reps = source?.adaptationSet?.representation;
      if (!Array.isArray(reps)) continue;

      for (const rep of reps) {
        const url = rep?.url;
        if (!url || rep.hidden === true || !/\.flv(\?|$)/i.test(url)) {
          continue;
        }
        candidates.push({
          url,
          codec,
          bitrate: Number(rep.bitrate || rep.bandwidth || 0),
        });
      }

      if (candidates.length > 0) {
        break;
      }
    }

    if (candidates.length === 0 && Array.isArray(liveStream?.playUrls)) {
      for (const item of liveStream.playUrls) {
        const url = item?.url || item?.flvUrl || item?.playUrl;
        if (url && /\.flv(\?|$)/i.test(url)) {
          candidates.push({
            url,
            codec: item.codec || item.type || 'unknown',
            bitrate: Number(item.bitrate || item.bandwidth || 0),
          });
        }
      }
    }

    candidates.sort((a, b) => b.bitrate - a.bitrate);
    return candidates[0] || null;
  }

  static extractRoomNameFromHtml(html) {
    const title = String(html || '').match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '';
    return title
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/-快手直播$/, '')
      .trim();
  }

  static assertNoAnticrawl(payload) {
    const data = payload?.data || payload || {};
    const message = firstNonEmpty(
      data?.errorType?.title,
      payload?.errorType?.title,
      data?.message,
      payload?.message,
      String(data?.result || '')
    );

    if (data?.result === 400002 || payload?.result === 400002 || ANTICRAWL_PATTERN.test(message)) {
      throw new Error(`KUAISHOU_ANTICRAWL:${message || 'unknown'}`);
    }
  }

  static extractStatusFromLivedetail(payload, fallbackRoomName = '') {
    KuaishouChecker.assertNoAnticrawl(payload);

    const data = payload?.data || payload || {};
    const author = data.author || {};
    const liveStream = data.liveStream || {};
    const stream = KuaishouChecker.pickBestStreamUrl(liveStream);
    const explicitLiving = author.living ?? data.living ?? liveStream.living;
    const isLive = explicitLiving === true || Boolean(stream?.url);
    const result = Number(data.result ?? payload?.result);

    if (!isLive && explicitLiving !== false && result !== 2) {
      throw new Error('KUAISHOU_UNKNOWN_LIVE_STATE');
    }

    return PlatformChecker.normalizeResult({
      isLive,
      recordable: !isLive || Boolean(stream?.url),
      roomName: firstNonEmpty(
        author.userName,
        author.user_name,
        author.name,
        author.nickname,
        data.userName,
        data.nickname,
        fallbackRoomName
      ),
      roomTitle: firstNonEmpty(data.caption, data.title, liveStream.caption, liveStream.title),
      roomCover: firstNonEmpty(data.coverUrl, data.poster, liveStream.coverUrl, author.headUrl, author.avatar),
      streamUrl: stream?.url || null,
      streamInfo: stream
        ? {
            format: 'flv',
            codec: stream.codec,
            bitrate: stream.bitrate,
          }
        : null,
    });
  }

  static extractStatusFromProfilePublic(payload, fallbackRoomName = '') {
    KuaishouChecker.assertNoAnticrawl(payload);

    const data = payload?.data || payload || {};
    const live = data.live || {};
    const author = live.author || data.author || {};
    const stream = KuaishouChecker.pickBestStreamUrl({
      playUrls: live.playUrls || liveStreamPlayUrls(data),
    });
    const explicitLiving = live.living ?? author.living ?? data.living;
    const isLive = explicitLiving === true || Boolean(stream?.url);
    const result = Number(data.result ?? payload?.result);

    if (!isLive && explicitLiving !== false && result !== 2) {
      throw new Error('KUAISHOU_UNKNOWN_LIVE_STATE');
    }

    return PlatformChecker.normalizeResult({
      isLive,
      recordable: !isLive || Boolean(stream?.url),
      roomName: firstNonEmpty(
        author.userName,
        author.user_name,
        author.name,
        author.nickname,
        data.userName,
        data.nickname,
        fallbackRoomName
      ),
      roomTitle: firstNonEmpty(live.caption, live.title, data.caption, data.title),
      roomCover: firstNonEmpty(live.coverUrl, live.poster, data.coverUrl, author.headUrl, author.avatar),
      streamUrl: stream?.url || null,
      streamInfo: stream
        ? {
            format: 'flv',
            codec: stream.codec,
            bitrate: stream.bitrate,
          }
        : null,
    });
  }

  getRoomKey() {
    if (this._roomKey) return this._roomKey;
    this._roomKey = KuaishouChecker.extractPrincipalId(this.roomUrl);
    return this._roomKey;
  }

  getTimeoutMs() {
    return parsePositiveInt(process.env.KUAISHOU_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  }

  getRoomIntervalSeconds() {
    return DEFAULT_ROOM_INTERVAL_SECONDS;
  }

  getGlobalIntervalSeconds() {
    return DEFAULT_GLOBAL_INTERVAL_SECONDS;
  }

  getBackoffSeconds() {
    return DEFAULT_BACKOFF_SECONDS;
  }

  getNormalizedUrl() {
    return /^https?:\/\//i.test(this.roomUrl) ? this.roomUrl : `https://${this.roomUrl}`;
  }

  getApiHeaders(accept = 'application/json') {
    return {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: accept,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: `${KUAISHOU_BASE_URL}/`,
      Origin: KUAISHOU_BASE_URL,
    };
  }

  async checkStatus() {
    if (!isEnabled(process.env.KUAISHOU_CHECKER_ENABLED)) {
      throw new Error('KUAISHOU_CHECKER_DISABLED');
    }

    const roomKey = this.getRoomKey();
    if (!roomKey) {
      throw new Error('KUAISHOU_INVALID_ROOM_URL');
    }

    return this._withPollingGuards(roomKey, async () => {
      let result;

      try {
        const payload = await this.fetchLivedetail(roomKey);
        result = KuaishouChecker.extractStatusFromLivedetail(payload);
      } catch (err) {
        if (/KUAISHOU_ANTICRAWL/.test(err.message)) {
          throw err;
        }

        const payload = await this.fetchProfilePublic(roomKey);
        result = KuaishouChecker.extractStatusFromProfilePublic(payload);
      }

      if (!result.roomName) {
        const roomName = await this.fetchRoomName(roomKey).catch(() => '');
        if (roomName) {
          result.roomName = roomName;
        }
      }

      return result;
    });
  }

  async fetchLivedetail(principalId) {
    const params = new URLSearchParams({ principalId });
    return PlatformChecker.fetchJson(`${KUAISHOU_BASE_URL}/live_api/liveroom/livedetail?${params}`, {
      timeout: this.getTimeoutMs(),
      headers: this.getApiHeaders(),
    });
  }

  async fetchProfilePublic(principalId) {
    const params = new URLSearchParams({ principalId });
    return PlatformChecker.fetchJson(`${KUAISHOU_BASE_URL}/live_api/profile/public?${params}`, {
      timeout: this.getTimeoutMs(),
      headers: this.getApiHeaders(),
    });
  }

  async fetchRoomName(principalId) {
    const cacheKey = `kuaishou:checker:room_name:${principalId}`;
    const cached = await this.redis.get(cacheKey).catch(() => null);
    if (cached) {
      return cached === ROOM_NAME_EMPTY_MARKER ? '' : cached;
    }

    const html = await PlatformChecker.fetchText(`${KUAISHOU_BASE_URL}/u/${encodeURIComponent(principalId)}`, {
      timeout: this.getTimeoutMs(),
      headers: this.getApiHeaders('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'),
    });
    const roomName = KuaishouChecker.extractRoomNameFromHtml(html);

    await this.redis.setEx(cacheKey, ROOM_NAME_CACHE_TTL_SECONDS, roomName || ROOM_NAME_EMPTY_MARKER).catch(() => {});

    return roomName;
  }

  async hasStoredSession() {
    return false;
  }

  getSessionKey() {
    return 'kuaishou:checker:session:deprecated';
  }

  async _withPollingGuards(roomKey, task) {
    await this._ensureNoBackoff('kuaishou:checker:platform_backoff', 'KUAISHOU_PLATFORM_BACKOFF_ACTIVE');
    await this._ensureNoBackoff(`kuaishou:checker:backoff:${roomKey}`, 'KUAISHOU_BACKOFF_ACTIVE');
    await this._ensureInterval(
      `kuaishou:checker:last_poll:${roomKey}`,
      this.getRoomIntervalSeconds(),
      'KUAISHOU_ROOM_RATE_LIMITED'
    );

    const roomLock = await this._acquireLock(`kuaishou:checker:lock:${roomKey}`, 'KUAISHOU_ROOM_LOCK_BUSY');
    try {
      const platformLock = await this._acquireLock('kuaishou:checker:platform_lock', 'KUAISHOU_PLATFORM_LOCK_BUSY');
      try {
        await this._ensureNoBackoff('kuaishou:checker:platform_backoff', 'KUAISHOU_PLATFORM_BACKOFF_ACTIVE');
        await this._ensureInterval(
          'kuaishou:checker:platform_last_poll',
          this.getGlobalIntervalSeconds(),
          'KUAISHOU_PLATFORM_RATE_LIMITED'
        );
        await this._markLastPoll(roomKey);

        try {
          return await task();
        } catch (err) {
          if (/KUAISHOU_ANTICRAWL|请求过快|验证码|400002/.test(err.message)) {
            await this._setBackoff(roomKey);
          }
          throw err;
        }
      } finally {
        await this._releaseLock(platformLock);
      }
    } finally {
      await this._releaseLock(roomLock);
    }
  }

  async _ensureNoBackoff(key, code) {
    const active = await this.redis.get(key).catch(() => null);
    if (active) {
      throw new Error(code);
    }
  }

  async _ensureInterval(key, intervalSeconds, code) {
    const lastPoll = await this.redis.get(key).catch(() => null);
    if (!lastPoll) return;

    const elapsedMs = this._now() - Number(lastPoll);
    if (Number.isFinite(elapsedMs) && elapsedMs < intervalSeconds * 1000) {
      throw new Error(code);
    }
  }

  async _markLastPoll(roomKey) {
    const now = String(this._now());
    await this.redis.setEx('kuaishou:checker:platform_last_poll', LAST_POLL_TTL_SECONDS, now).catch(() => {});
    await this.redis.setEx(`kuaishou:checker:last_poll:${roomKey}`, LAST_POLL_TTL_SECONDS, now).catch(() => {});
  }

  async _setBackoff(roomKey) {
    const seconds = this.getBackoffSeconds();
    await this.redis.setEx(`kuaishou:checker:backoff:${roomKey}`, seconds, '1').catch(() => {});
    await this.redis.setEx('kuaishou:checker:platform_backoff', seconds, '1').catch(() => {});
  }

  async _acquireLock(key, code) {
    const token = crypto.randomUUID();
    const ttlSeconds = Math.ceil(this.getTimeoutMs() / 1000) + 10;
    const result = await this.redis.set(key, token, {
      NX: true,
      EX: ttlSeconds,
    });

    if (result !== 'OK') {
      throw new Error(code);
    }

    return { key, token };
  }

  async _releaseLock(lock) {
    if (!lock) return;

    const current = await this.redis.get(lock.key).catch(() => null);
    if (current === lock.token) {
      await this.redis.del(lock.key).catch(() => {});
    }
  }
}

function liveStreamPlayUrls(data) {
  return data?.liveStream?.playUrls || data?.playUrls || [];
}

module.exports = KuaishouChecker;
