const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_VIEWPORT = { width: 1365, height: 768 };
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media']);
const BLOCKED_URL_PATTERNS = [
  /sentry/i,
  /log(?:ging)?[./_-]/i,
  /collect/i,
  /captcha\.zt\.kuaishou\.com/i,
  /ad[sx]?[\.-]/i,
];

function shouldBlockRequest(request, options = {}) {
  if (options.blockResources === false) {
    return false;
  }

  const url = request.url();
  const resourceType = request.resourceType();

  if (options.allowFirstScreenResources && ['image', 'font'].includes(resourceType)) {
    return false;
  }

  if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
    return true;
  }

  return BLOCKED_URL_PATTERNS.some((pattern) => pattern.test(url));
}

class RemoteBrowserClient {
  constructor(options = {}) {
    this.endpoint = options.endpoint || process.env.REMOTE_BROWSER_WS_ENDPOINT || '';
    this.browser = options.browser || null;
    this._connectPromise = null;
    this._chromium = options.chromium || null;
  }

  _loadChromium() {
    if (!this._chromium) {
      this._chromium = require('playwright-core').chromium;
    }
    return this._chromium;
  }

  async getBrowser() {
    if (this.browser?.isConnected?.()) {
      return this.browser;
    }

    if (!this.endpoint) {
      throw new Error('REMOTE_BROWSER_WS_ENDPOINT is not configured');
    }

    if (this._connectPromise) {
      return this._connectPromise;
    }

    this._connectPromise = this._loadChromium()
      .connectOverCDP(this.endpoint)
      .then((browser) => {
        this.browser = browser;
        this._connectPromise = null;
        browser.on?.('disconnected', () => {
          this.browser = null;
          this._connectPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        this.browser = null;
        this._connectPromise = null;
        throw err;
      });

    return this._connectPromise;
  }

  async withPage(task, options = {}) {
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const browser = await this.getBrowser();
    let context = null;
    let page = null;
    let timer = null;

    try {
      context = await browser.newContext({
        userAgent: options.userAgent || DEFAULT_USER_AGENT,
        viewport: options.viewport || DEFAULT_VIEWPORT,
        locale: options.locale || 'zh-CN',
        timezoneId: options.timezoneId || 'Asia/Shanghai',
        storageState: options.storageState || undefined,
      });

      if (options.stealth) {
        await context.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => undefined });");
      }

      page = await context.newPage();
      await page.route('**/*', (route) => {
        if (shouldBlockRequest(route.request(), options)) {
          return route.abort();
        }
        return route.continue();
      });

      const taskPromise = Promise.resolve().then(() => task(page, context));
      taskPromise.catch(() => {});

      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`REMOTE_BROWSER_PAGE_TIMEOUT:${timeoutMs}`));
        }, timeoutMs);
      });

      return await Promise.race([taskPromise, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }

      if (page) {
        await page.close().catch(() => {});
      }

      if (context) {
        if (typeof options.saveStorageState === 'function') {
          await this._saveStorageState(context, options.saveStorageState);
        }
        await context.close().catch(() => {});
      }
    }
  }

  async _saveStorageState(context, saveStorageState) {
    try {
      const state = await context.storageState();
      await saveStorageState({
        cookies: Array.isArray(state?.cookies) ? state.cookies : [],
      });
    } catch (_) {}
  }

  async close() {
    const browser = this.browser;
    this.browser = null;
    this._connectPromise = null;

    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  RemoteBrowserClient,
  shouldBlockRequest,
};
