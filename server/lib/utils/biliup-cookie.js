const fs = require('fs');

const { resolveAndValidate } = require('./path-safety');

/**
 * biliup cookie 文件只读解析
 *
 * 供合集接口（member.bilibili.com 创作中心）构造 Cookie 头与 csrf。
 * 红线：只读，任何情况下不回写；错误信息不得包含凭证值。
 */

const ERROR_CODES = {
  NOT_CONFIGURED: 'COOKIE_NOT_CONFIGURED',
  PATH_INVALID: 'COOKIE_PATH_INVALID',
  NOT_FOUND: 'COOKIE_NOT_FOUND',
  UNREADABLE: 'COOKIE_UNREADABLE',
  MALFORMED: 'COOKIE_MALFORMED',
  NO_CSRF: 'COOKIE_NO_CSRF',
};

class CookieError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CookieError';
    this.code = code;
  }
}

/**
 * 解析 cookie 文件 JSON → name/value 映射。
 * 结构为 biliup 落盘格式：`cookie_info.cookies[] = { name, value, ... }`
 * @param {unknown} parsed
 * @returns {Map<string, string>}
 */
function toCookieMap(parsed) {
  const list = parsed && parsed.cookie_info && parsed.cookie_info.cookies;
  if (!Array.isArray(list)) {
    throw new CookieError(ERROR_CODES.MALFORMED, 'cookie 文件缺少 cookie_info.cookies 数组');
  }

  const map = new Map();
  for (const item of list) {
    if (!item || typeof item.name !== 'string' || typeof item.value !== 'string') continue;
    if (item.name === '' || item.value === '') continue;
    map.set(item.name, item.value);
  }
  return map;
}

/**
 * 取 uid：优先 `DedeUserID` cookie，回退 `token_info.mid`
 * @param {Map<string, string>} map
 * @param {unknown} parsed
 * @returns {string|null}
 */
function extractUid(map, parsed) {
  const fromCookie = map.get('DedeUserID');
  if (fromCookie) return fromCookie;

  const mid = parsed && parsed.token_info && parsed.token_info.mid;
  if (typeof mid === 'number' && Number.isFinite(mid)) return String(mid);
  if (typeof mid === 'string' && mid !== '') return mid;
  return null;
}

/**
 * 只读加载 biliup cookie 文件。
 * @param {string} cookiesPath - 模板配置的 cookie 文件绝对路径
 * @returns {Promise<{cookieHeader: string, csrf: string, uid: string|null}>}
 * @throws {CookieError}
 */
async function loadBiliupCookie(cookiesPath) {
  if (typeof cookiesPath !== 'string' || cookiesPath.trim() === '') {
    throw new CookieError(ERROR_CODES.NOT_CONFIGURED, '未配置 cookie 文件路径');
  }

  const check = await resolveAndValidate(cookiesPath);
  if (!check.valid) {
    throw new CookieError(ERROR_CODES.PATH_INVALID, `cookie 路径校验未通过: ${check.reason}`);
  }

  let raw;
  try {
    raw = await fs.promises.readFile(check.resolvedPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new CookieError(ERROR_CODES.NOT_FOUND, 'cookie 文件不存在');
    }
    throw new CookieError(ERROR_CODES.UNREADABLE, `cookie 文件不可读: ${err.code || 'unknown'}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CookieError(ERROR_CODES.MALFORMED, 'cookie 文件不是合法 JSON');
  }

  const map = toCookieMap(parsed);

  const csrf = map.get('bili_jct');
  if (!csrf) {
    throw new CookieError(ERROR_CODES.NO_CSRF, 'cookie 缺少 bili_jct，无法执行合集写操作');
  }

  const cookieHeader = [...map].map(([name, value]) => `${name}=${value}`).join('; ');

  return { cookieHeader, csrf, uid: extractUid(map, parsed) };
}

module.exports = {
  ERROR_CODES,
  CookieError,
  loadBiliupCookie,
};
