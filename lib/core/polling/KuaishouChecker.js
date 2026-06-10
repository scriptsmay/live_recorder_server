/* global window, document */

const crypto = require('crypto');

const redis = require('../../../db/redis');
const PlatformChecker = require('./PlatformChecker');
const { RemoteBrowserClient } = require('../browser/RemoteBrowserClient');
const defaultHumanBehavior = require('../browser/humanBehavior');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_WAIT_MS = 12000;
const DEFAULT_ROOM_INTERVAL_SECONDS = 60;
const DEFAULT_GLOBAL_INTERVAL_SECONDS = 20;
const DEFAULT_BACKOFF_SECONDS = 180;
const DEFAULT_SESSION_TTL_SECONDS = 604800;
const DEFAULT_SIMULATE_MIN_DELAY_MS = 1500;
const DEFAULT_SIMULATE_MAX_DELAY_MS = 4000;
const DEFAULT_SIMULATE_SCROLL_COUNT = 2;
const LAST_POLL_TTL_SECONDS = 86400;
const ANTICRAWL_PATTERN = /请求过快|验证码|风控|400002/i;

const defaultBrowserClient = new RemoteBrowserClient();

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isEnabled(value) {
  return String(value ?? 'true').toLowerCase() !== 'false';
}

function isExplicitTrue(value) {
  return String(value ?? '').toLowerCase() === 'true';
}

function nowMs() {
  return Date.now();
}

class KuaishouChecker extends PlatformChecker {
  constructor(roomUrl, options = {}) {
    super(roomUrl);
    this.redis = options.redis || redis;
    this.browserClient = options.browserClient || defaultBrowserClient;
    this.humanBehavior = options.humanBehavior || defaultHumanBehavior;
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
            codec: item.codec || 'unknown',
            bitrate: Number(item.bitrate || 0),
          });
        }
      }
    }

    candidates.sort((a, b) => b.bitrate - a.bitrate);
    return candidates[0] || null;
  }

  static extractStatus(snapshot) {
    const state = snapshot?.state;
    const liveroom = state?.liveroom || {};
    const playList = Array.isArray(liveroom.playList) ? liveroom.playList : [];
    const activeIndex = Number.isInteger(liveroom.activeIndex) ? liveroom.activeIndex : 0;
    const item = playList[activeIndex] || playList[0];
    const errorTitle = item?.errorType?.title || liveroom.errorType?.title || '';
    const bodyText = snapshot?.bodyText || '';

    if (ANTICRAWL_PATTERN.test(errorTitle) || ANTICRAWL_PATTERN.test(bodyText)) {
      throw new Error(`KUAISHOU_ANTICRAWL:${errorTitle || 'unknown'}`);
    }

    if (!item) {
      throw new Error('KUAISHOU_NO_LIVEROOM_STATE');
    }

    const author = item.author || {};
    const roomName =
      author.userName ||
      author.user_name ||
      author.name ||
      author.nickname ||
      snapshot.title?.replace(/-快手直播$/, '') ||
      '';
    const stream = KuaishouChecker.pickBestStreamUrl(item.liveStream);
    const isLive = item.isLiving === true || Boolean(stream?.url);
    const isOffline = item.isLiving === false && /主播尚未开播/.test(bodyText);

    if (!isLive && !isOffline && item.isLiving !== false) {
      throw new Error('KUAISHOU_UNKNOWN_LIVE_STATE');
    }

    return PlatformChecker.normalizeResult({
      isLive,
      recordable: true,
      roomName,
      roomTitle: item.caption || item.title || item.liveStream?.caption || '',
      roomCover: item.coverUrl || item.poster || item.liveStream?.coverUrl || '',
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
    return parsePositiveInt(process.env.KUAISHOU_CHECKER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  }

  getWaitMs() {
    return parsePositiveInt(process.env.KUAISHOU_CHECKER_WAIT_MS, DEFAULT_WAIT_MS);
  }

  getRoomIntervalSeconds() {
    return parsePositiveInt(process.env.KUAISHOU_CHECKER_MIN_INTERVAL_SECONDS, DEFAULT_ROOM_INTERVAL_SECONDS);
  }

  getGlobalIntervalSeconds() {
    return parsePositiveInt(process.env.KUAISHOU_CHECKER_GLOBAL_INTERVAL_SECONDS, DEFAULT_GLOBAL_INTERVAL_SECONDS);
  }

  getBackoffSeconds() {
    return parsePositiveInt(process.env.KUAISHOU_CHECKER_BACKOFF_SECONDS, DEFAULT_BACKOFF_SECONDS);
  }

  getSessionTtlSeconds() {
    return parsePositiveInt(process.env.KUAISHOU_CHECKER_SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS);
  }

  getSessionScope() {
    return process.env.KUAISHOU_CHECKER_SESSION_SCOPE === 'room' ? 'room' : 'platform';
  }

  getSessionKey(roomKey = this.getRoomKey()) {
    return this.getSessionScope() === 'room'
      ? `kuaishou:checker:session:room:${roomKey}`
      : 'kuaishou:checker:session:platform';
  }

  getHumanBehaviorOptions() {
    const minDelayMs = parsePositiveInt(
      process.env.KUAISHOU_CHECKER_SIMULATE_MIN_DELAY_MS,
      DEFAULT_SIMULATE_MIN_DELAY_MS
    );
    const maxDelayMs = parsePositiveInt(
      process.env.KUAISHOU_CHECKER_SIMULATE_MAX_DELAY_MS,
      DEFAULT_SIMULATE_MAX_DELAY_MS
    );

    return {
      minDelayMs: Math.min(minDelayMs, maxDelayMs),
      maxDelayMs: Math.max(minDelayMs, maxDelayMs),
      scrollCount: parseNonNegativeInt(
        process.env.KUAISHOU_CHECKER_SIMULATE_SCROLL_COUNT,
        DEFAULT_SIMULATE_SCROLL_COUNT
      ),
    };
  }

  getUserAgent() {
    return process.env.KUAISHOU_CHECKER_HEADLESS_USER_AGENT || DEFAULT_USER_AGENT;
  }

  getNormalizedUrl() {
    return /^https?:\/\//i.test(this.roomUrl) ? this.roomUrl : `https://${this.roomUrl}`;
  }

  async checkStatus() {
    if (!isEnabled(process.env.KUAISHOU_CHECKER_ENABLED)) {
      throw new Error('KUAISHOU_CHECKER_DISABLED');
    }

    if (
      this.browserClient === defaultBrowserClient &&
      !process.env.REMOTE_BROWSER_WS_ENDPOINT &&
      !this.browserClient?.endpoint
    ) {
      throw new Error('REMOTE_BROWSER_WS_ENDPOINT is not configured');
    }

    const roomKey = this.getRoomKey();
    if (!roomKey) {
      throw new Error('KUAISHOU_INVALID_ROOM_URL');
    }

    return this._withPollingGuards(roomKey, async () => {
      const timeoutMs = this.getTimeoutMs();
      const storageState = await this._loadSession(roomKey);
      const snapshot = await this.browserClient.withPage(
        async (page) => {
          await page.goto(this.getNormalizedUrl(), {
            waitUntil: 'domcontentloaded',
            timeout: timeoutMs,
          });

          await page
            .waitForFunction(
              () => {
                const state = window.__INITIAL_STATE__;
                return Boolean(state?.liveroom?.playList?.length || state?.liveroom?.errorType);
              },
              null,
              { timeout: this.getWaitMs() }
            )
            .catch(() => {});

          if (isEnabled(process.env.KUAISHOU_CHECKER_SIMULATE_HUMAN)) {
            await this.humanBehavior.simulateHumanBehavior(page, this.getHumanBehaviorOptions());
          }

          return page.evaluate(() => ({
            title: document.title || '',
            bodyText: document.body?.innerText?.slice(0, 5000) || '',
            state: window.__INITIAL_STATE__ || null,
          }));
        },
        {
          timeoutMs,
          userAgent: this.getUserAgent(),
          stealth: isExplicitTrue(process.env.KUAISHOU_CHECKER_STEALTH),
          allowFirstScreenResources: isExplicitTrue(process.env.KUAISHOU_CHECKER_ALLOW_FIRST_SCREEN_RESOURCES),
          storageState,
          saveStorageState: (state) => this._saveSession(roomKey, state),
        }
      );

      return KuaishouChecker.extractStatus(snapshot);
    });
  }

  async hasStoredSession(roomKey = this.getRoomKey()) {
    if (!roomKey || !isEnabled(process.env.KUAISHOU_CHECKER_PERSIST_SESSION)) {
      return false;
    }

    const raw = await this.redis.get(this.getSessionKey(roomKey)).catch(() => null);
    return Boolean(raw);
  }

  async _loadSession(roomKey) {
    if (!isEnabled(process.env.KUAISHOU_CHECKER_PERSIST_SESSION)) {
      return undefined;
    }

    const raw = await this.redis.get(this.getSessionKey(roomKey)).catch(() => null);
    if (!raw) {
      return undefined;
    }

    try {
      const state = JSON.parse(raw);
      const cookies = this._filterKuaishouCookies(state?.cookies);
      return cookies.length > 0 ? { cookies } : undefined;
    } catch (_) {
      return undefined;
    }
  }

  async _saveSession(roomKey, state) {
    if (!isEnabled(process.env.KUAISHOU_CHECKER_PERSIST_SESSION)) {
      return;
    }

    const cookies = this._filterKuaishouCookies(state?.cookies);
    if (cookies.length === 0) {
      return;
    }

    await this.redis
      .setEx(this.getSessionKey(roomKey), this.getSessionTtlSeconds(), JSON.stringify({ cookies }))
      .catch(() => {});
  }

  _filterKuaishouCookies(cookies) {
    if (!Array.isArray(cookies)) {
      return [];
    }

    return cookies.filter((cookie) => {
      const domain = String(cookie?.domain || '').toLowerCase();
      return domain === 'kuaishou.com' || domain.endsWith('.kuaishou.com');
    });
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

module.exports = KuaishouChecker;
