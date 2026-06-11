/**
 * 默认浏览器 User-Agent 字符串，模拟 Chrome 121 on Windows 10 x64
 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

/** 页面操作默认超时时间（毫秒） */
const DEFAULT_TIMEOUT_MS = 45000;
/** 默认浏览器视口尺寸 */
const DEFAULT_VIEWPORT = { width: 1365, height: 768 };
/** 需要拦截的资源类型集合 */
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media']);
/** 需要拦截的 URL 正则模式列表，匹配埋点、日志、广告等无关请求 */
const BLOCKED_URL_PATTERNS = [
  /sentry/i,
  /log(?:ging)?[./_-]/i,
  /collect/i,
  /captcha\.zt\.kuaishou\.com/i,
  /ad[sx]?[\.-]/i,
];

/**
 * 判断是否应拦截指定的网络请求。
 *
 * @param {object} request - Playwright 请求对象，需实现 url() 和 resourceType() 方法
 * @param {object} [options={}] - 拦截策略选项
 * @param {boolean} [options.blockResources] - 设为 false 时禁用所有资源拦截
 * @param {boolean} [options.allowFirstScreenResources] - 设为 true 时放行首屏图片和字体资源
 * @returns {boolean} 返回 true 表示该请求应被拦截
 */
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

/**
 * 远程浏览器客户端，基于 Playwright 通过 CDP 协议连接并控制远程浏览器实例。
 * 提供浏览器连接管理、页面生命周期管理、请求拦截及反检测等能力。
 */
class RemoteBrowserClient {
  /**
   * 创建 RemoteBrowserClient 实例。
   *
   * @param {object} [options={}] - 配置选项
   * @param {string} [options.endpoint] - 远程浏览器 WebSocket 端点地址，缺省读取环境变量 REMOTE_BROWSER_WS_ENDPOINT
   * @param {object|null} [options.browser] - 已有的浏览器实例，传入后跳过自动连接
   * @param {object|null} [options.chromium] - 已有的 Playwright chromium 模块引用，用于延迟加载优化
   */
  constructor(options = {}) {
    this.endpoint = options.endpoint || process.env.REMOTE_BROWSER_WS_ENDPOINT || '';
    this.browser = options.browser || null;
    this._connectPromise = null;
    this._chromium = options.chromium || null;
  }

  /**
   * 延迟加载 Playwright 的 chromium 模块，避免不必要的 require 开销。
   *
   * @returns {object} Playwright chromium 模块
   */
  _loadChromium() {
    if (!this._chromium) {
      this._chromium = require('playwright-core').chromium;
    }
    return this._chromium;
  }

  /**
   * 获取远程浏览器连接实例。支持单例复用和断线自动重连。
   * 并发调用时会复用同一个连接 Promise，避免重复建立连接。
   *
   * @returns {Promise<object>} Playwright Browser 实例
   * @throws {Error} 当未配置 endpoint 时抛出异常
   */
  async getBrowser() {
    if (this.browser?.isConnected?.()) {
      return this.browser;
    }

    if (!this.endpoint) {
      throw new Error('REMOTE_BROWSER_WS_ENDPOINT is not configured');
    }

    // 复用正在进行的连接请求，防止并发重复连接
    if (this._connectPromise) {
      return this._connectPromise;
    }

    this._connectPromise = this._loadChromium()
      .connectOverCDP(this.endpoint)
      .then((browser) => {
        this.browser = browser;
        this._connectPromise = null;
        console.log(`[playwright-core] Connected to remote browser: ${this.endpoint}`);
        // 监听断线事件，自动清理状态以便下次重连
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

  /**
   * 在隔离的浏览器上下文和页面中执行异步任务，自动管理生命周期和超时控制。
   * 任务完成或异常后会自动清理页面和上下文资源。
   *
   * @param {function} task - 要执行的异步任务函数，签名为 (page, context) => Promise<any>
   * @param {object} [options={}] - 页面与任务选项
   * @param {number} [options.timeoutMs] - 任务超时时间（毫秒），默认 45000
   * @param {string} [options.userAgent] - 自定义 User-Agent
   * @param {object} [options.viewport] - 视口尺寸，默认 1365x768
   * @param {string} [options.locale] - 页面语言，默认 'zh-CN'
   * @param {string} [options.timezoneId] - 时区标识，默认 'Asia/Shanghai'
   * @param {object} [options.storageState] - 浏览器存储状态（cookies 等）
   * @param {boolean} [options.stealth] - 是否启用反检测模式（隐藏 webdriver 标志）
   * @param {boolean} [options.blockResources] - 是否启用资源拦截，传给 shouldBlockRequest
   * @param {boolean} [options.allowFirstScreenResources] - 是否放行首屏资源，传给 shouldBlockRequest
   * @param {function} [options.saveStorageState] - 上下文关闭前保存存储状态的回调，签名为 (state) => Promise<void>
   * @returns {Promise<any>} 任务函数的返回值
   * @throws {Error} 当任务超时时抛出 REMOTE_BROWSER_PAGE_TIMEOUT 异常
   */
  async withPage(task, options = {}) {
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const browser = await this.getBrowser();
    let context = null;
    let page = null;
    let timer = null;

    try {
      // 创建隔离的浏览器上下文，配置 UA、视口、语言、时区等环境参数
      context = await browser.newContext({
        userAgent: options.userAgent || DEFAULT_USER_AGENT,
        viewport: options.viewport || DEFAULT_VIEWPORT,
        locale: options.locale || 'zh-CN',
        timezoneId: options.timezoneId || 'Asia/Shanghai',
        storageState: options.storageState || undefined,
      });

      // 注入反检测脚本，隐藏 Playwright 的 webdriver 特征
      if (options.stealth) {
        await context.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => undefined });");
      }

      page = await context.newPage();
      // 注册全局路由拦截，根据策略阻断无关资源请求
      await page.route('**/*', (route) => {
        if (shouldBlockRequest(route.request(), options)) {
          return route.abort();
        }
        return route.continue();
      });

      // 执行用户任务，并通过 Promise.race 实现超时竞争
      const taskPromise = Promise.resolve().then(() => task(page, context));
      taskPromise.catch(() => {});

      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`REMOTE_BROWSER_PAGE_TIMEOUT:${timeoutMs}`));
        }, timeoutMs);
      });

      return await Promise.race([taskPromise, timeoutPromise]);
    } finally {
      // 确保无论成功或异常，都按序清理定时器、页面和上下文资源
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

  /**
   * 从浏览器上下文中提取存储状态（cookies）并通过回调传出。
   *
   * @param {object} context - Playwright BrowserContext 实例
   * @param {function} saveStorageState - 状态保存回调，签名为 (state: { cookies: Array }) => Promise<void>
   * @returns {Promise<void>}
   */
  async _saveStorageState(context, saveStorageState) {
    try {
      const state = await context.storageState();
      await saveStorageState({
        cookies: Array.isArray(state?.cookies) ? state.cookies : [],
      });
    } catch (_) {}
  }

  /**
   * 关闭浏览器连接并重置内部状态。
   *
   * @returns {Promise<void>}
   */
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
