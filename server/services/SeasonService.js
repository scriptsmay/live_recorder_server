const crypto = require('crypto');
const pool = require('../db/index');
const redis = require('../db/redis');
const notify = require('../lib/core/notify');
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
 * 终态一律只写 season_* 字段，不改投稿记录的 status，不影响投稿后处理策略。
 * 凭证红线：cookie 只经 biliup-cookie 只读加载，错误文案与日志只落错误码与类别。
 *
 * 常规投稿与回放投稿共用本编排层：两张表的 season_* 列同名同语义，SQL 中的表名取自下方常量白名单，
 * 永不来自请求入参（两表 id 各自独立自增，跨表同号是不同稿件，source 必须一路透传到终态写入）。
 */

const LOG = '[合集]';
const STATUS = { PENDING: 'pending', ADDED: 'added', FAILED: 'failed' };

const SEASON_TABLES = {
  recording: 'upload_records',
  replay: 'replay_upload_records',
};

/** 投稿来源 → 承载 season_* 状态的表名；未知来源一律退回常规投稿表。 */
function seasonTable(source) {
  return SEASON_TABLES[source] || SEASON_TABLES.recording;
}

const SOURCE_LABELS = {
  [SEASON_TABLES.recording]: '常规投稿',
  [SEASON_TABLES.replay]: '回放投稿',
};

/** 就绪轮询可容忍的瞬态错误：稿件未发布（-404）或网络超时/5xx /429 */
function isTransientReadError(err) {
  if (!err) return false;
  return err.code === ERROR_CODES.VIDEO_NOT_READY || err.retryable === true;
}

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

  static readyPollMs() {
    return envInt('SEASON_READY_POLL_MS', 30000, 1);
  }

  static readyTimeoutMs() {
    return envInt('SEASON_READY_TIMEOUT_MS', 1800000, 1);
  }

  static pendingMaxAgeMin() {
    return envInt('SEASON_PENDING_MAX_AGE_MIN', 90, 1);
  }

  static listCacheTtl() {
    return envInt('SEASON_LIST_CACHE_TTL', 600, 1);
  }

  /** 可替换的时钟钩子：单测用虚拟时钟推进截止时间，避免真实等待 30 分钟 */
  static _now() {
    return Date.now();
  }

  static async _sleep(ms) {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 投稿成功后的自动入口：不抛异常、不阻塞投稿链路。
   * @param {number|string} recordId - 投稿记录 ID
   * @param {'recording'|'replay'} [source] - 投稿来源表，缺省为 recording
   * @returns {Promise<object>} 跳过原因或执行结果
   */
  static async scheduleAdd(recordId, source = 'recording') {
    if (!this.isEnabled()) return { skipped: 'disabled' };
    try {
      const ctx = await this._loadContext(recordId, source);
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
   * @param {number|string} recordId - 投稿记录 ID
   * @param {'recording'|'replay'} [source] - 投稿来源表，缺省为 recording
   * @returns {Promise<{ok: boolean, http: number, message: string}>}
   */
  static async retryAdd(recordId, source = 'recording') {
    try {
      const ctx = await this._loadContext(recordId, source);
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
   * 启动续跑：扫描两张投稿表中上次进程遗留的 pending 合集任务。
   *
   * 有效任务以 detached 后台方式续跑（不阻塞启动），沿用它已消耗的 season_attempts 预算；
   * 只有超过续跑窗口、尝试预算耗尽或上下文失效（软删/模板删除/缺 BV/cookie/小节）才判失败。
   * pending 是「已占位、执行中」的中间态，retryAdd 与 _claim 都拒绝 pending，不处理就是永久死锁。
   * 批量失败一律 notify=false 静默写入，最后合并为一条 season_pending_expired 通知，避免通知风暴。
   * @returns {Promise<{resumed: number[], expired: number[], invalid: number[]}>}
   */
  static async resumePending() {
    const summary = { resumed: [], expired: [], invalid: [] };
    const failures = [];
    try {
      for (const table of Object.values(SEASON_TABLES)) {
        const result = await pool.query(
          `SELECT ur.id, ur.bv_id, ur.season_status, ur.season_attempts, ur.season_pending_since,
                  ur.deleted_at,
                  ut.id AS template_id, ut.name AS template_name, ut.cookies_path,
                  ut.season_id, ut.season_title, ut.section_id, ut.season_auto_add
             FROM ${table} ur
             LEFT JOIN upload_templates ut ON ut.id = ur.template_id AND ut.deleted_at IS NULL
            WHERE ur.season_status = 'pending'`
        );

        for (const row of result.rows) {
          const ctx = { ...row, table };
          const recordId = row.id;
          const sectionId = toPositiveInt(row.section_id);

          if (row.deleted_at) {
            // 软删记录完全静默：不进聚合通知，避免用户已删稿件还收到打扰
            await this._discardPending(recordId, ctx, '投稿记录已删除，任务不再续跑');
            summary.invalid.push(recordId);
            continue;
          }
          if (!this.isEnabled()) {
            await this._discardPending(recordId, ctx, '自动加入合集已关闭，重启后不再续跑');
            failures.push({ table, id: recordId, reason: '自动加入已关闭' });
            summary.expired.push(recordId);
            continue;
          }
          if (!row.bv_id || !row.cookies_path || !sectionId) {
            await this._discardPending(recordId, ctx, '缺少 BV 号、cookie 或合集小节，无法续跑');
            failures.push({ table, id: recordId, reason: '任务数据不完整' });
            summary.invalid.push(recordId);
            continue;
          }
          if (Number(row.season_attempts) >= this.maxAttempts()) {
            await this._discardPending(recordId, ctx, '写阶段重试次数已耗尽，重启后不再续跑');
            failures.push({ table, id: recordId, reason: '重试次数已耗尽' });
            summary.expired.push(recordId);
            continue;
          }

          const pendingSince = await this._ensurePendingSince(recordId, ctx);
          if (this._now() - pendingSince > this.pendingMaxAgeMin() * 60000) {
            await this._discardPending(recordId, ctx, '超过重启续跑窗口，任务已过期');
            failures.push({ table, id: recordId, reason: `超过 ${this.pendingMaxAgeMin()} 分钟续跑窗口` });
            summary.expired.push(recordId);
            continue;
          }

          const usedAttempts = Number(row.season_attempts) || 0;
          console.log(
            `${LOG} 记录 ${recordId}（${SOURCE_LABELS[table]}）重启续跑，已用尝试 ${usedAttempts}/${this.maxAttempts()}`
          );
          this._dispatch(recordId, ctx, sectionId, 0, usedAttempts, true);
          summary.resumed.push(recordId);
        }
      }

      if (failures.length > 0) {
        await notify.send(
          'season_pending_expired',
          `服务重启：${failures.length} 条加入合集任务未续跑`,
          `${this._formatResumeFailures(failures)}\n已标记为失败，可在「投稿记录」页手动重试。`
        );
      }
      return summary;
    } catch (err) {
      console.error('[启动续跑] 合集 pending 扫描失败:', err);
      return summary;
    }
  }

  /** 重启清理的静默失败：不逐条发通知，由 resumePending 汇总 */
  static async _discardPending(recordId, ctx, message) {
    const err = new SeasonError('SEASON_RESUME_DISCARDED', message, { retryable: false });
    await this._markFailed(recordId, err, ctx, { notify: false });
  }

  static _formatResumeFailures(failures) {
    const lines = [];
    for (const [table, label] of Object.entries(SOURCE_LABELS)) {
      const items = failures.filter((item) => item.table === table);
      if (items.length === 0) continue;
      lines.push(`${label}：${items.map((item) => `ID ${item.id}（${item.reason}）`).join('、')}`);
    }
    return lines.join('\n');
  }

  /** 旧版本升级上来的 pending 可能没有 season_pending_since，补写占位时刻 */
  static async _ensurePendingSince(recordId, ctx) {
    const existing = ctx.season_pending_since ? new Date(ctx.season_pending_since).getTime() : NaN;
    if (Number.isFinite(existing)) return existing;

    const result = await pool.query(
      `UPDATE ${ctx.table}
          SET season_pending_since = NOW()
        WHERE id = $1 AND season_pending_since IS NULL
      RETURNING season_pending_since`,
      [recordId]
    );
    const stamped = result.rows[0] && result.rows[0].season_pending_since;
    const parsed = stamped ? new Date(stamped).getTime() : NaN;
    const now = this._now();
    ctx.season_pending_since = new Date(Number.isFinite(parsed) ? parsed : now);
    return Number.isFinite(parsed) ? parsed : now;
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

  static async _loadContext(recordId, source = 'recording') {
    const table = seasonTable(source);
    // v1.12.0：合集上下文查询过滤软删行（投稿记录与其模板）
    const result = await pool.query(
      `SELECT ur.id, ur.bv_id, ur.season_status, ur.season_attempts, ur.season_pending_since,
              ut.id AS template_id, ut.name AS template_name, ut.cookies_path,
              ut.season_id, ut.season_title, ut.section_id, ut.season_auto_add
         FROM ${table} ur
         LEFT JOIN upload_templates ut ON ut.id = ur.template_id AND ut.deleted_at IS NULL
        WHERE ur.id = $1 AND ur.deleted_at IS NULL`,
      [recordId]
    );
    if (!result.rows.length) return null;
    // 表名随上下文流到所有终态写入，避免中途丢失来源
    return { ...result.rows[0], table };
  }

  static async _start(recordId, ctx, delayMs, detached = false) {
    if (!ctx.bv_id) return { skipped: 'no_bvid' };
    if (!ctx.cookies_path) return { skipped: 'no_cookie' };
    const sectionId = toPositiveInt(ctx.section_id);
    if (!sectionId) return { skipped: 'no_section' };
    if (!(await this._claim(recordId, ctx))) return { skipped: 'claim_conflict' };
    return this._dispatch(recordId, ctx, sectionId, delayMs, 0, detached);
  }

  /**
   * 后台派发：detached 用于手动重试与重启续跑，HTTP 请求/启动链不随长轮询与退避挂住。
   * 续跑记录已经是 pending，直接进入 _execute，不能再走 _claim 的状态条件。
   */
  static _dispatch(recordId, ctx, sectionId, delayMs, usedAttempts, detached) {
    if (!detached) return this._execute(recordId, ctx, sectionId, delayMs, usedAttempts);
    this._execute(recordId, ctx, sectionId, delayMs, usedAttempts).catch((err) => {
      console.error(`${LOG} 记录 ${recordId} 后台执行异常: ${safeMessage(err)}`);
    });
    return { started: true };
  }

  static async _claim(recordId, ctx) {
    const result = await pool.query(
      `UPDATE ${ctx.table}
          SET season_status = 'pending', season_error = NULL, season_attempts = 0,
              season_pending_since = NOW(),
              season_id = COALESCE($2, season_id)
        WHERE id = $1 AND season_status IN ('none','failed')
      RETURNING id, season_pending_since`,
      [recordId, toPositiveInt(ctx.season_id)]
    );
    if (!result.rows.length) return false;
    // 手动重试时 ctx 可能还带着上一轮的占位时间，截止时间必须以本次占位结果为准
    ctx.season_pending_since = result.rows[0].season_pending_since ?? new Date(this._now());
    return true;
  }

  /**
   * 执行体：初始延迟 → 并发就绪等待（不占写锁）→ 同账号串行写 → 有界重试。
   * 任何异常都在内部收敛成终态，避免记录永久停留在 pending。
   */
  static async _execute(recordId, ctx, sectionId, delayMs, usedAttempts = 0) {
    try {
      if (delayMs > 0) await this._sleep(delayMs);
      const video = await this._waitForVideoReady(recordId, ctx);

      const key = ctx.cookies_path;
      const previous = accountTails.get(key) || Promise.resolve();
      const next = previous.then(
        () => this._attempts(recordId, ctx, sectionId, video, usedAttempts),
        () => this._attempts(recordId, ctx, sectionId, video, usedAttempts)
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
      try {
        await this._markFailed(recordId, err, ctx);
      } catch (markErr) {
        console.error(`${LOG} 记录 ${recordId} 终态写入失败: ${safeMessage(markErr)}`);
      }
      return { ok: false, attempts: usedAttempts, code: (err && err.code) || 'SEASON_EXEC_ERROR' };
    }
  }

  /**
   * 并发等待稿件可查（B 站 view 就绪）。
   *
   * 只读接口不触发合集编辑频控，因此在同账号写队列之外并发执行，避免大稿件长时间转码阻塞同账号后续任务。
   * 容忍 VIDEO_NOT_READY 与 retryable 的瞬态错误（DNS/超时/5xx/429）；凭证失效等不可重试错误直接抛出。
   * 截止时间 = min(本次等待预算, 占位时刻 + 重启续跑硬上限)：正常运行有完整预算，跨停机则不会无限等。
   * @throws {SeasonError} VIDEO_READY_TIMEOUT — 等待窗口内仍未就绪
   */
  static async _waitForVideoReady(recordId, ctx) {
    const pollMs = this.readyPollMs();
    const now = this._now();
    const pendingSince = ctx.season_pending_since ? new Date(ctx.season_pending_since).getTime() : NaN;
    const deadline = Number.isFinite(pendingSince)
      ? Math.min(now + this.readyTimeoutMs(), pendingSince + this.pendingMaxAgeMin() * 60000)
      : now + this.readyTimeoutMs();

    for (;;) {
      try {
        const credential = await this._loadCredential(ctx.cookies_path);
        return await getVideoInfo(credential, { bvid: ctx.bv_id });
      } catch (err) {
        if (!isTransientReadError(err)) throw err;

        const current = this._now();
        if (current >= deadline) {
          throw new SeasonError(ERROR_CODES.VIDEO_READY_TIMEOUT, '稿件在等待窗口内仍未就绪', { retryable: false });
        }
        const wait = Math.max(1, Math.min(pollMs, deadline - current));
        console.warn(
          `${LOG} 记录 ${recordId} 稿件暂不可查（${(err && err.code) || 'UNKNOWN'}），${Math.ceil(wait / 1000)}s 后继续轮询`
        );
        await this._sleep(wait);
      }
    }
  }

  static async _attempts(recordId, ctx, sectionId, video, usedAttempts = 0) {
    const max = this.maxAttempts();
    let attempt = usedAttempts;

    for (;;) {
      attempt += 1;
      await pool.query(
        `UPDATE ${ctx.table} SET season_attempts = season_attempts + 1
          WHERE id = $1 AND season_status = 'pending'`,
        [recordId]
      );

      try {
        return await this._attemptOnce(recordId, ctx, sectionId, attempt, video);
      } catch (err) {
        if (!(err && err.retryable === true) || attempt >= max) {
          await this._markFailed(recordId, err, ctx);
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

  static async _attemptOnce(recordId, ctx, sectionId, attempt, video) {
    const credential = await this._loadCredential(ctx.cookies_path);
    const section = await getSeasonSection(credential, sectionId);
    const seasonId = toPositiveInt(section.seasonId) || toPositiveInt(ctx.season_id);

    if (section.aids.includes(video.aid)) {
      await this._markAdded(recordId, seasonId, ctx);
      console.log(`${LOG} 记录 ${recordId} 稿件已在小节 ${sectionId} 中，直接标记 added`);
      return { ok: true, attempts: attempt, alreadyPresent: true };
    }

    const status = await pool.query(`SELECT season_status FROM ${ctx.table} WHERE id = $1`, [recordId]);
    if (!status.rows.length || status.rows[0].season_status !== STATUS.PENDING) {
      console.warn(`${LOG} 记录 ${recordId} 状态已被改写，放弃写入小节 ${sectionId}`);
      return { ok: false, attempts: attempt, code: 'STATE_CHANGED' };
    }

    await addToSeason(credential, {
      sectionId,
      episodes: [{ aid: video.aid, cid: video.cid, title: video.title }],
    });
    await this._markAdded(recordId, seasonId, ctx);
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

  static async _markAdded(recordId, seasonId, ctx) {
    await pool.query(
      `UPDATE ${ctx.table}
          SET season_status = 'added', season_id = COALESCE($2, season_id),
              season_error = NULL, season_added_at = NOW()
        WHERE id = $1 AND season_status = 'pending'`,
      [recordId, seasonId ?? null]
    );
  }

  /**
   * 终态失败写入。notify=false 用于重启批量清理与软删记录，避免重启时通知风暴。
   * 只在确实完成 pending → failed 迁移时发通知，重复收敛不会打扰。
   * @returns {Promise<boolean>} 是否真正完成了状态迁移
   */
  static async _markFailed(recordId, err, ctx, options = {}) {
    const code = (err && err.code) || 'UNKNOWN';
    const detail = safeMessage(err);
    const text = detail && !detail.includes(code) ? `${code}: ${detail}` : code;
    const result = await pool.query(
      `UPDATE ${ctx.table} SET season_status = 'failed', season_error = $2
        WHERE id = $1 AND season_status = 'pending'
      RETURNING id`,
      [recordId, text]
    );
    const changed = result.rows.length === 1;
    console.error(`${LOG} 记录 ${recordId} 加入合集失败: ${text}`);

    if (changed && options.notify !== false) {
      try {
        await notify.send(
          'season_add_failed',
          `加入合集失败：${ctx.bv_id || '未知稿件'}`,
          [
            `来源：${SOURCE_LABELS[ctx.table] || '投稿'}`,
            `记录 ID：${recordId}`,
            `BV 号：${ctx.bv_id || '未知'}`,
            `错误：${text}`,
            '可在「投稿记录」页手动重试。',
          ].join('\n')
        );
      } catch (notifyErr) {
        console.error(`${LOG} 记录 ${recordId} 失败通知发送异常: ${safeMessage(notifyErr)}`);
      }
    }
    return changed;
  }
}

module.exports = SeasonService;
