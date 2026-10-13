const crypto = require('crypto');
const pool = require('../db/index');
const redis = require('../db/redis');
const { loadBiliupCookie } = require('../lib/utils/biliup-cookie');
const {
  ERROR_CODES,
  SeasonError,
  getVideoInfo,
  getSeasonSection,
  addToSeason,
  listSeasons,
} = require('../lib/core/bilibili-season');

/**
 * 投稿后自动加入合集的编排层
 *
 * 三层防重：DB 原子占位拦并发 → 执行前查小节 episodes 是否已含该稿件 → 写入前复核状态仍为 pending。
 * 终态一律只写 season_* 字段，不改 upload_records.status，不影响投稿后处理策略。
 * 凭证红线：cookie 只经 biliup-cookie 只读加载，错误文案与日志只落错误码与类别。
 */

const LOG = '[合集]';
const STATUS = { PENDING: 'pending', ADDED: 'added', FAILED: 'failed' };

// 20111「合集编辑过于频繁」的退避下限：T0 实测同账号间隔 3s 被拒、6s 后成功
const MIN_EDIT_BACKOFF_MS = 10000;
const MAX_ERROR_CHARS = 400;
const LIST_CACHE_PREFIX = 'season:seasons:';

const SKIP_REASONS = {
  no_record: { http: 404, message: '投稿记录不存在' },
  no_bvid: { http: 400, message: '投稿未成功或尚未取得 BV 号，无法加入合集' },
  no_cookie: { http: 400, message: '模板未配置 cookie 文件路径' },
  no_section: { http: 400, message: '模板未选择合集小节' },
  claim_conflict: { http: 409, message: '该记录正在加入中或已完成，无需重试' },
};

function envInt(name, fallback, min = 0) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function toPositiveInt(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function safeMessage(err) {
  const message = err && err.message ? String(err.message) : String(err);
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
}

// 同账号（同一 cookie 文件）的写请求串行，规避 B 站账号级频控；条目数上限即账号数，不做回收
const accountTails = new Map();

class SeasonService {
  static isEnabled() {
    const raw = process.env.SEASON_AUTO_ADD_ENABLED;
    if (raw === undefined || String(raw).trim() === '') return true;
    return String(raw).trim().toLowerCase() !== 'false';
  }

  static delayMs() {
    return envInt('SEASON_ADD_DELAY_MS', 45000);
  }

  static maxAttempts() {
    return envInt('SEASON_ADD_MAX_ATTEMPTS', 3, 1);
  }

  static backoffBaseMs() {
    return envInt('SEASON_ADD_BACKOFF_MS', 30000);
  }

  static listCacheTtl() {
    return envInt('SEASON_LIST_CACHE_TTL', 600, 1);
  }

  static async _sleep(ms) {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 投稿成功后的自动入口：不抛异常、不阻塞投稿链路。
   * @param {number|string} recordId - upload_records.id
   * @returns {Promise<object>} 跳过原因或执行结果
   */
  static async scheduleAdd(recordId) {
    if (!this.isEnabled()) return { skipped: 'disabled' };
    try {
      const ctx = await this._loadContext(recordId);
      if (!ctx) return { skipped: 'no_record' };
      if (!ctx.season_auto_add) return { skipped: 'template_off' };
      return await this._start(recordId, ctx, this.delayMs());
    } catch (err) {
      console.error(`${LOG} 记录 ${recordId} 触发失败: ${safeMessage(err)}`);
      return { skipped: 'error' };
    }
  }

  /**
   * 手动重试入口：不受总开关限制，返回体带 http 语义供路由直接使用。
   * @param {number|string} recordId - upload_records.id
   * @returns {Promise<{ok: boolean, http: number, message: string}>}
   */
  static async retryAdd(recordId) {
    try {
      const ctx = await this._loadContext(recordId);
      if (!ctx) return this._reply({ skipped: 'no_record' });
      if (ctx.season_status === STATUS.PENDING) {
        return { ok: false, http: 409, message: '加入任务进行中，请稍后刷新查看结果' };
      }
      if (ctx.season_status === STATUS.ADDED) {
        return { ok: false, http: 409, message: '稿件已在合集中，无需重试' };
      }
      const result = await this._start(recordId, ctx, 0, true);
      if (result && result.skipped) return this._reply(result);
      return { ok: true, http: 200, message: '已触发加入合集，稍后刷新查看结果', result };
    } catch (err) {
      console.error(`${LOG} 记录 ${recordId} 手动重试失败: ${safeMessage(err)}`);
      return { ok: false, http: 500, message: '重试触发失败，请查看服务端日志' };
    }
  }

  static _reply(result) {
    const info = SKIP_REASONS[result.skipped] || { http: 500, message: '无法加入合集，请查看服务端日志' };
    return { ok: false, http: info.http, message: info.message, skipped: result.skipped };
  }

  /**
   * 按模板/账号所用 cookie 拉取合集与小节，Redis 缓存键为 cookie 路径摘要（不含路径与凭证）。
   * @param {string} cookiesPath - biliup cookie 文件绝对路径
   * @param {{force?: boolean}} [options] - force 跳过缓存
   * @returns {Promise<{seasons: Array, cached: boolean, fetched_at: number|null}>}
   */
  static async listSeasonsByCookies(cookiesPath, options = {}) {
    const cacheKey = `${LIST_CACHE_PREFIX}${crypto.createHash('sha256').update(String(cookiesPath)).digest('hex').slice(0, 32)}`;

    if (!options.force) {
      const cached = await this._readCache(cacheKey);
      if (cached) return { seasons: cached.seasons, cached: true, fetched_at: cached.fetched_at ?? null };
    }

    const credential = await loadBiliupCookie(cookiesPath);
    const payload = await listSeasons(credential, {
      pn: 1,
      ps: envInt('SEASON_SEASONS_PAGE_SIZE', 30, 1),
    });
    const record = { seasons: payload.seasons, fetched_at: Date.now() };
    await this._writeCache(cacheKey, record);
    return { seasons: record.seasons, cached: false, fetched_at: record.fetched_at };
  }

  /**
   * 模板保存前的归属校验：合集必须属于该 cookie 账号，小节必须属于该合集。
   * 复用列表缓存，成本与编辑页级联下拉一致；取不到列表时按错误类别回 400 / 500。
   * @param {string} cookiesPath - biliup cookie 文件绝对路径
   * @param {number|string|null} seasonId - 待保存的合集 ID
   * @param {number|string|null} sectionId - 待保存的小节 ID
   * @returns {Promise<{ok: boolean, http: number, message: string}>}
   */
  static async validateSelection(cookiesPath, seasonId, sectionId) {
    const wantedSeason = toPositiveInt(seasonId);
    const wantedSection = toPositiveInt(sectionId);
    if (!wantedSeason && !wantedSection) return { ok: true, http: 200, message: '' };
    if (!wantedSeason) return { ok: false, http: 400, message: '选择小节时必须同时指定所属合集' };
    if (!cookiesPath) return { ok: false, http: 400, message: '未配置 cookie 文件路径，无法校验合集归属' };

    let payload;
    try {
      payload = await this.listSeasonsByCookies(cookiesPath);
    } catch (err) {
      return this._selectionFailure(err);
    }

    const seasons = payload && Array.isArray(payload.seasons) ? payload.seasons : [];
    const season = seasons.find((item) => toPositiveInt(item && item.seasonId) === wantedSeason);
    if (!season) return { ok: false, http: 400, message: '所选合集不属于该 cookie 账号，请重新选择' };
    if (!wantedSection) return { ok: true, http: 200, message: '' };

    const sections = Array.isArray(season.sections) ? season.sections : [];
    const hit = sections.some((item) => toPositiveInt(item && item.sectionId) === wantedSection);
    if (hit) return { ok: true, http: 200, message: '' };
    return { ok: false, http: 400, message: '所选小节不属于该合集，请重新选择' };
  }

  static _selectionFailure(err) {
    const code = (err && err.code) || 'unknown';
    console.error(`${LOG} 归属校验失败: ${code}`);
    const cookieIssue = code.startsWith('COOKIE') || code === 'AUTH_EXPIRED' || code === 'CREDENTIAL_INVALID';
    return {
      ok: false,
      http: cookieIssue ? 400 : 500,
      message: cookieIssue
        ? 'cookie 不可用，无法校验合集归属，请检查 cookie 配置与登录态'
        : '合集归属校验失败，请稍后重试',
    };
  }

  static async _readCache(cacheKey) {
    try {
      const raw = await redis.get(cacheKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed && parsed.seasons) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  static async _writeCache(cacheKey, record) {
    try {
      await redis.setEx(cacheKey, this.listCacheTtl(), JSON.stringify(record));
    } catch (_) {
      // 缓存不可用不影响查询本身
    }
  }

  static async _loadContext(recordId) {
    const result = await pool.query(
      `SELECT ur.id, ur.bv_id, ur.season_status, ur.season_attempts,
              ut.id AS template_id, ut.name AS template_name, ut.cookies_path,
              ut.season_id, ut.season_title, ut.section_id, ut.season_auto_add
         FROM upload_records ur
         LEFT JOIN upload_templates ut ON ut.id = ur.template_id
        WHERE ur.id = $1`,
      [recordId]
    );
    return result.rows.length ? result.rows[0] : null;
  }

  static async _start(recordId, ctx, delayMs, detached = false) {
    if (!ctx.bv_id) return { skipped: 'no_bvid' };
    if (!ctx.cookies_path) return { skipped: 'no_cookie' };
    const sectionId = toPositiveInt(ctx.section_id);
    if (!sectionId) return { skipped: 'no_section' };
    if (!(await this._claim(recordId, ctx.season_id))) return { skipped: 'claim_conflict' };
    if (detached) {
      // 占位成功后放到后台：HTTP 请求不随退避重试一起挂住，状态由记录页刷新查看
      this._execute(recordId, ctx, sectionId, delayMs).catch((err) => {
        console.error(`${LOG} 记录 ${recordId} 后台执行异常: ${safeMessage(err)}`);
      });
      return { started: true };
    }
    return this._execute(recordId, ctx, sectionId, delayMs);
  }

  static async _claim(recordId, seasonId) {
    const result = await pool.query(
      `UPDATE upload_records
          SET season_status = 'pending', season_error = NULL, season_attempts = 0,
              season_id = COALESCE($2, season_id)
        WHERE id = $1 AND season_status IN ('none','failed')
      RETURNING id`,
      [recordId, toPositiveInt(seasonId)]
    );
    return result.rows.length > 0;
  }

  /**
   * 执行体：延迟 + 同账号串行 + 重试退避，任何异常都在内部收敛成终态。
   */
  static async _execute(recordId, ctx, sectionId, delayMs) {
    try {
      if (delayMs > 0) await this._sleep(delayMs);
      const key = ctx.cookies_path;
      const previous = accountTails.get(key) || Promise.resolve();
      const next = previous.then(
        () => this._attempts(recordId, ctx, sectionId),
        () => this._attempts(recordId, ctx, sectionId)
      );
      accountTails.set(
        key,
        next.catch((err) => {
          console.error(`${LOG} 记录 ${recordId} 队列异常: ${safeMessage(err)}`);
        })
      );
      return await next;
    } catch (err) {
      console.error(`${LOG} 记录 ${recordId} 执行异常: ${safeMessage(err)}`);
      return { ok: false, attempts: 0, code: 'SEASON_EXEC_ERROR' };
    }
  }

  static async _attempts(recordId, ctx, sectionId) {
    const max = this.maxAttempts();
    let attempt = 0;

    for (;;) {
      attempt += 1;
      await pool.query(
        `UPDATE upload_records SET season_attempts = season_attempts + 1
          WHERE id = $1 AND season_status = 'pending'`,
        [recordId]
      );

      try {
        return await this._attemptOnce(recordId, ctx, sectionId, attempt);
      } catch (err) {
        if (!(err && err.retryable === true) || attempt >= max) {
          await this._markFailed(recordId, err);
          return { ok: false, attempts: attempt, code: (err && err.code) || 'UNKNOWN' };
        }
        await this._sleep(this._backoffMs(attempt, err));
      }
    }
  }

  static _backoffMs(attempt, err) {
    const computed = this.backoffBaseMs() * 2 ** (attempt - 1);
    if (err && err.code === ERROR_CODES.TOO_FREQUENT) return Math.max(computed, MIN_EDIT_BACKOFF_MS);
    return computed;
  }

  static async _attemptOnce(recordId, ctx, sectionId, attempt) {
    const credential = await this._loadCredential(ctx.cookies_path);
    const video = await getVideoInfo(credential, { bvid: ctx.bv_id });
    const section = await getSeasonSection(credential, sectionId);
    const seasonId = toPositiveInt(section.seasonId) || toPositiveInt(ctx.season_id);

    if (section.aids.includes(video.aid)) {
      await this._markAdded(recordId, seasonId);
      console.log(`${LOG} 记录 ${recordId} 稿件已在小节 ${sectionId} 中，直接标记 added`);
      return { ok: true, attempts: attempt, alreadyPresent: true };
    }

    const status = await pool.query(`SELECT season_status FROM upload_records WHERE id = $1`, [recordId]);
    if (!status.rows.length || status.rows[0].season_status !== STATUS.PENDING) {
      console.warn(`${LOG} 记录 ${recordId} 状态已被改写，放弃写入小节 ${sectionId}`);
      return { ok: false, attempts: attempt, code: 'STATE_CHANGED' };
    }

    await addToSeason(credential, {
      sectionId,
      episodes: [{ aid: video.aid, cid: video.cid, title: video.title }],
    });
    await this._markAdded(recordId, seasonId);
    console.log(`${LOG} 记录 ${recordId} 稿件 ${ctx.bv_id} 已加入小节 ${sectionId}`);
    return { ok: true, attempts: attempt, alreadyPresent: false };
  }

  static async _loadCredential(cookiesPath) {
    try {
      return await loadBiliupCookie(cookiesPath);
    } catch (err) {
      throw new SeasonError((err && err.code) || 'COOKIE_INVALID', safeMessage(err) || 'cookie 加载失败');
    }
  }

  static async _markAdded(recordId, seasonId) {
    await pool.query(
      `UPDATE upload_records
          SET season_status = 'added', season_id = COALESCE($2, season_id),
              season_error = NULL, season_added_at = NOW()
        WHERE id = $1 AND season_status = 'pending'`,
      [recordId, seasonId ?? null]
    );
  }

  static async _markFailed(recordId, err) {
    const code = (err && err.code) || 'UNKNOWN';
    const detail = safeMessage(err);
    const text = detail && !detail.includes(code) ? `${code}: ${detail}` : code;
    await pool.query(
      `UPDATE upload_records SET season_status = 'failed', season_error = $2
        WHERE id = $1 AND season_status = 'pending'`,
      [recordId, text]
    );
    console.error(`${LOG} 记录 ${recordId} 加入合集失败: ${text}`);
  }
}

module.exports = SeasonService;
