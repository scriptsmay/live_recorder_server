/**
 * 兼容性 fetch 封装
 * Node.js 18+ 使用原生 fetch，统一提供超时和错误处理
 */

const DEFAULT_TIMEOUT = 10000;

/**
 * 获取带超时的 fetch 封装
 * @param {number} timeout - 默认超时时间(ms)
 * @returns {Function} 封装后的 fetch 函数
 */
function createFetch(defaultTimeout = DEFAULT_TIMEOUT) {
  return async function fetchWithTimeout(url, options = {}) {
    const { timeout = defaultTimeout, signal, ...rest } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    // 支持外部传入的 signal
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      return await fetch(url, { signal: controller.signal, ...rest });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`请求超时: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { createFetch };
