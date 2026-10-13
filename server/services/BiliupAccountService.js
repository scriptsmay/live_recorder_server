const pool = require('../db/index');
const { loadBiliupCookie } = require('../lib/utils/biliup-cookie');
const { checkLogin } = require('../lib/core/bilibili-season');
const SeasonService = require('./SeasonService');

/**
 * biliup 账号登记（FR-7，最小化）
 *
 * 只做新增 / 查询 / 删除，不提供 UPDATE：账号信息以 cookie 文件为准，改配置请改文件本身。
 * 凭证红线：cookie 内容一律不入库、不入响应、不入日志；错误只回 code 与可读类别。
 */

const LOG = '[biliup账号]';
const NAME_MAX = 64;
const PATH_MAX = 1024;
const LOGIN_STATUS = { OK: 'ok', EXPIRED: 'expired', UNKNOWN: 'unknown' };
const SELECT_COLUMNS = 'id, name, cookies_path, uid, nickname, login_status, last_checked_at, created_at';

function toPositiveInt(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function fail(http, message) {
  return { ok: false, http, message };
}

class BiliupAccountService {
  static async list() {
    const result = await pool.query(`SELECT ${SELECT_COLUMNS} FROM biliup_accounts ORDER BY id ASC`);
    return { ok: true, http: 200, data: result.rows };
  }

  /**
   * 详情：顺带刷新线上登录态。nav 失败不阻断读取，退化为 unknown。
   * @param {number|string} id - 账号 ID
   */
  static async detail(id) {
    const accountId = toPositiveInt(id);
    if (accountId === null) return fail(400, '账号 ID 非法');

    const found = await pool.query(`SELECT ${SELECT_COLUMNS} FROM biliup_accounts WHERE id = $1`, [accountId]);
    if (!found.rows.length) return fail(404, '账号不存在');

    const row = found.rows[0];
    const probed = await this._probe(row.cookies_path);
    await pool.query(
      `UPDATE biliup_accounts
          SET uid = COALESCE($2, uid), nickname = COALESCE($3, nickname),
              login_status = $4, last_checked_at = NOW()
        WHERE id = $1`,
      [accountId, probed.uid, probed.nickname, probed.login_status]
    );

    return {
      ok: true,
      http: 200,
      data: {
        ...row,
        uid: probed.uid ?? row.uid,
        nickname: probed.nickname ?? row.nickname,
        login_status: probed.login_status,
        last_checked_at: new Date().toISOString(),
      },
    };
  }

  /**
   * 新增：登记一个已存在的 cookie 文件路径。可读、落在白名单内、能取到 bili_jct 才允许入库。
   * @param {{name?: unknown, cookies_path?: unknown}} input
   */
  static async create(input = {}) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const cookiesPath = typeof input.cookies_path === 'string' ? input.cookies_path.trim() : '';

    if (name === '' || name.length > NAME_MAX) return fail(400, `账号名称需为 1-${NAME_MAX} 个字符`);
    if (cookiesPath === '' || !cookiesPath.startsWith('/') || cookiesPath.length > PATH_MAX) {
      return fail(400, 'cookies_path 需为容器内绝对路径');
    }

    try {
      await loadBiliupCookie(cookiesPath);
    } catch (err) {
      console.error(`${LOG} cookie 校验失败: ${err && err.code ? err.code : 'unknown'}`);
      return fail(400, `cookie 文件校验未通过：${(err && err.message) || '不可读'}`);
    }

    const probed = await this._probe(cookiesPath);

    try {
      const inserted = await pool.query(
        `INSERT INTO biliup_accounts (name, cookies_path, uid, nickname, login_status, last_checked_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING ${SELECT_COLUMNS}`,
        [name, cookiesPath, probed.uid, probed.nickname, probed.login_status]
      );
      return { ok: true, http: 201, data: inserted.rows[0] };
    } catch (err) {
      if (err && err.code === '23505') {
        return fail(409, '账号名称或 cookie 路径已登记');
      }
      throw err;
    }
  }

  /**
   * 删除：仅删登记记录，cookie 文件默认保留；被投稿模板引用时拒绝。
   * @param {number|string} id - 账号 ID
   */
  static async remove(id) {
    const accountId = toPositiveInt(id);
    if (accountId === null) return fail(400, '账号 ID 非法');

    const found = await pool.query('SELECT cookies_path FROM biliup_accounts WHERE id = $1', [accountId]);
    if (!found.rows.length) return fail(404, '账号不存在');

    const refs = await pool.query('SELECT COUNT(*)::int AS count FROM upload_templates WHERE cookies_path = $1', [
      found.rows[0].cookies_path,
    ]);
    const count = Number(refs.rows[0] ? refs.rows[0].count : 0) || 0;
    if (count > 0) {
      return {
        ok: false,
        http: 409,
        message: `该 cookie 路径被 ${count} 个投稿模板引用，请先调整模板`,
        referenced_by: count,
      };
    }

    const deleted = await pool.query('DELETE FROM biliup_accounts WHERE id = $1 RETURNING id', [accountId]);
    if (!deleted.rows.length) return fail(404, '账号不存在');

    console.log(`${LOG} 账号 ${accountId} 登记已删除，cookie 文件保留`);
    return { ok: true, http: 200, message: '账号登记已删除，cookie 文件保留' };
  }

  /**
   * 该账号的合集 + 小节列表（带缓存）。
   * @param {number|string} id - 账号 ID
   * @param {{force?: boolean}} [options]
   */
  static async seasons(id, options = {}) {
    const accountId = toPositiveInt(id);
    if (accountId === null) return fail(400, '账号 ID 非法');

    const found = await pool.query('SELECT cookies_path FROM biliup_accounts WHERE id = $1', [accountId]);
    if (!found.rows.length) return fail(404, '账号不存在');

    const payload = await SeasonService.listSeasonsByCookies(found.rows[0].cookies_path, options);
    return { ok: true, http: 200, data: payload };
  }

  /**
   * 探测登录态；任何失败都降级为 unknown，不影响账号读写。cookie 只读一次。
   * @param {string} cookiesPath - cookie 文件绝对路径
   */
  static async _probe(cookiesPath) {
    const fallback = { login_status: LOGIN_STATUS.UNKNOWN, uid: null, nickname: null };
    let credential;
    try {
      credential = await loadBiliupCookie(cookiesPath);
    } catch (err) {
      console.warn(`${LOG} cookie 读取失败: ${err && err.code ? err.code : 'unknown'}`);
      return fallback;
    }

    try {
      const result = await checkLogin(credential);
      return {
        login_status: result.isLogin ? LOGIN_STATUS.OK : LOGIN_STATUS.EXPIRED,
        uid: result.uid || credential.uid || null,
        nickname: result.nickname || null,
      };
    } catch (err) {
      console.warn(`${LOG} 登录态探测失败: ${err && err.code ? err.code : 'unknown'}`);
      return { ...fallback, uid: credential.uid || null };
    }
  }
}

module.exports = BiliupAccountService;
