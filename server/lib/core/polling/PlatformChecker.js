const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT = 10000;

class PlatformChecker {
  constructor(roomUrl) {
    this.roomUrl = roomUrl;
  }

  async checkStatus() {
    throw new Error('Not implemented');
  }

  static getPlatformId() {
    throw new Error('Not implemented');
  }

  static canHandleUrl(_url) {
    throw new Error('Not implemented');
  }

  static async fetchJson(url, options = {}) {
    const { timeout = DEFAULT_TIMEOUT, headers = {}, ...rest } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Accept: 'application/json',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...headers,
        },
        ...rest,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`请求超时: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  static async fetchText(url, options = {}) {
    const { timeout = DEFAULT_TIMEOUT, headers = {}, ...rest } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...headers,
        },
        ...rest,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.text();
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`请求超时: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  static normalizeResult(partial) {
    return {
      isLive: partial.isLive ?? false,
      recordable: partial.recordable ?? true,
      roomName: partial.roomName ?? '',
      roomTitle: partial.roomTitle ?? '',
      roomCover: partial.roomCover ?? '',
      streamUrl: partial.streamUrl ?? null,
      streamInfo: partial.streamInfo ?? null,
      error: partial.error ?? null,
    };
  }

  static extractLastPathSegment(url) {
    try {
      const pathname = new URL(url).pathname;
      const segments = pathname.split('/').filter(Boolean);
      return segments[segments.length - 1] || null;
    } catch (_) {
      return null;
    }
  }
}

module.exports = PlatformChecker;
