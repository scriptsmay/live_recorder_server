/**
 * B 站合集（Season / Section）只读+写入客户端
 *
 * 走创作中心私有接口 `member.bilibili.com/x2/creative/web/*`。
 * 接口契约对齐 biliup 1.2.8 `biliup/plugins/bili_webup.py`，并于 2026-10-13 线上只读探测复核。
 *
 * 凭证红线：cookie / csrf 绝不进入错误信息、堆栈或日志；超时错误不复用会带 URL 的通用封装，
 * 因为写接口的 csrf 就在 URL 上。
 */

const MEMBER_BASE = 'https://member.bilibili.com';
const API_BASE = 'https://api.bilibili.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const ERROR_CODES = {
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  CREDENTIAL_INVALID: 'CREDENTIAL_INVALID',
  SEASON_TIMEOUT: 'SEASON_TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  HTTP_ERROR: 'HTTP_ERROR',
  RESPONSE_MALFORMED: 'RESPONSE_MALFORMED',
  BIZ_ERROR: 'BIZ_ERROR',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  CSRF_FAILED: 'CSRF_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  TOO_FREQUENT: 'TOO_FREQUENT',
  VIDEO_NOT_READY: 'VIDEO_NOT_READY',
  VIDEO_READY_TIMEOUT: 'VIDEO_READY_TIMEOUT',
  SECTION_INVALID: 'SECTION_INVALID',
  ALREADY_IN_SEASON: 'ALREADY_IN_SEASON',
};

// B 站业务码 → 归一错误码 + 是否值得重试（重试编排由 SeasonService 负责）
const BIZ_CODE_MAP = {
  [-101]: { code: ERROR_CODES.AUTH_EXPIRED, retryable: false },
  [-111]: { code: ERROR_CODES.CSRF_FAILED, retryable: false },
  [-352]: { code: ERROR_CODES.RATE_LIMITED, retryable: false },
  [-404]: { code: ERROR_CODES.BIZ_ERROR, retryable: false },
  [20080]: { code: ERROR_CODES.ALREADY_IN_SEASON, retryable: false },
  [20111]: { code: ERROR_CODES.TOO_FREQUENT, retryable: true },
};

const BIZ_OK = 0;
// nav 在未登录时返回 -101：属于「探测成功、结论为否」，不作为异常
const BIZ_NOT_LOGGED_IN = -101;

class SeasonError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'SeasonError';
    this.code = code;
    this.retryable = extra.retryable ?? false;
    if (extra.bizCode !== undefined) this.bizCode = extra.bizCode;
    if (extra.httpStatus !== undefined) this.httpStatus = extra.httpStatus;
  }
}

function defaultTimeoutMs() {
  const parsed = parseInt(process.env.SEASON_HTTP_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10000;
}

function positiveInt(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function requireCredential(credential, { needCsrf = false } = {}) {
  const cookieHeader = credential && credential.cookieHeader;
  if (typeof cookieHeader !== 'string' || cookieHeader.trim() === '') {
    throw new SeasonError(ERROR_CODES.CREDENTIAL_INVALID, '缺少可用的 cookie');
  }
  const csrf = credential && credential.csrf;
  if (needCsrf && (typeof csrf !== 'string' || csrf.trim() === '')) {
    throw new SeasonError(ERROR_CODES.CREDENTIAL_INVALID, 'cookie 缺少 csrf，无法执行合集写操作');
  }
  return { cookieHeader, csrf: typeof csrf === 'string' ? csrf : '' };
}

/**
 * 带超时的请求。错误信息一律不含 URL —— 写接口的 query 上挂着 csrf。
 */
async function request(url, credential, options = {}) {
  const { cookieHeader } = requireCredential(credential);
  const timeoutMs = positiveInt(options.timeoutMs) || defaultTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    'User-Agent': USER_AGENT,
    Cookie: cookieHeader,
    Referer: `${MEMBER_BASE}/platform/home.html`,
    ...(options.headers || {}),
  };

  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new SeasonError(ERROR_CODES.SEASON_TIMEOUT, `合集接口请求超时（${timeoutMs}ms）`, { retryable: true });
    }
    throw new SeasonError(ERROR_CODES.NETWORK_ERROR, `合集接口网络异常: ${err && err.code ? err.code : 'unknown'}`, {
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const status = response.status;
    throw new SeasonError(ERROR_CODES.HTTP_ERROR, `合集接口 HTTP ${status}`, {
      retryable: status >= 500 || status === 429,
      httpStatus: status,
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new SeasonError(ERROR_CODES.RESPONSE_MALFORMED, '合集接口返回非 JSON 响应', { retryable: true });
  }
  if (!payload || typeof payload !== 'object') {
    throw new SeasonError(ERROR_CODES.RESPONSE_MALFORMED, '合集接口响应结构异常', { retryable: true });
  }
  return payload;
}

/**
 * B 站业务码检查。code=0 放行；20080 由调用方按成功处理；其余归一为 SeasonError。
 */
function assertBizOk(payload, context, fallback = {}) {
  const code = payload.code;
  if (code === BIZ_OK || code === undefined) return;
  const message = payload.message || payload.msg || '';
  const mapped = BIZ_CODE_MAP[code] || { code: ERROR_CODES.BIZ_ERROR, retryable: false };
  const finalCode = mapped.code === ERROR_CODES.BIZ_ERROR ? fallback.code || mapped.code : mapped.code;

  throw new SeasonError(finalCode, `${context}失败: code=${code}${message ? ` ${message}` : ''}`, {
    retryable: mapped.retryable,
    bizCode: code,
  });
}

function buildUrl(base, path, params) {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * 拉取合集 + 小节列表。
 * 线上形状：`data.seasons[].season.{id,title}` + `data.seasons[].sections.sections[].{id,title}`
 */
async function listSeasons(credential, options = {}) {
  const pn = positiveInt(options.pn) || 1;
  const ps = positiveInt(options.ps) || positiveInt(process.env.SEASON_SEASONS_PAGE_SIZE) || 30;
  const url = buildUrl(MEMBER_BASE, '/x2/creative/web/seasons', {
    pn,
    ps,
    order: 'mtime',
    sort: 'desc',
    platform: 'web',
    draft: 1,
  });

  const payload = await request(url, credential, { timeoutMs: options.timeoutMs });
  assertBizOk(payload, '获取合集列表');

  const data = payload.data || {};
  const rawSeasons = Array.isArray(data.seasons) ? data.seasons : [];
  const seasons = [];

  for (const item of rawSeasons) {
    if (!item || typeof item !== 'object') continue;
    const season = item.season || {};
    const seasonId = asNumber(season.id);
    if (seasonId === null) continue;

    const sectionWrap = item.sections || {};
    const rawSections = Array.isArray(sectionWrap.sections) ? sectionWrap.sections : [];
    const sections = [];
    for (const section of rawSections) {
      if (!section || typeof section !== 'object') continue;
      const sectionId = asNumber(section.id);
      if (sectionId === null) continue;
      sections.push({ sectionId, title: typeof section.title === 'string' ? section.title : '' });
    }

    seasons.push({ seasonId, title: typeof season.title === 'string' ? season.title : '', sections });
  }

  return { seasons, total: asNumber(data.total) ?? seasons.length };
}

/**
 * 查小节现有稿件，用于幂等判断（写入前先确认 aid 是否已在小节内）。
 * 空小节的 `data.episodes` 是 null，不是 []。
 */
async function getSeasonSection(credential, sectionId, options = {}) {
  const id = positiveInt(sectionId);
  if (id === null) {
    throw new SeasonError(ERROR_CODES.INVALID_ARGUMENT, 'section_id 非法');
  }

  const url = buildUrl(MEMBER_BASE, '/x2/creative/web/season/section', { id });
  const payload = await request(url, credential, { timeoutMs: options.timeoutMs });
  assertBizOk(payload, '获取合集小节', { code: ERROR_CODES.SECTION_INVALID });

  const data = payload.data || {};
  const section = data.section || {};
  const episodes = Array.isArray(data.episodes) ? data.episodes : [];
  const aids = [];
  for (const episode of episodes) {
    if (!episode || typeof episode !== 'object') continue;
    const aid = asNumber(episode.aid);
    if (aid !== null) aids.push(aid);
  }

  const sectionIdValue = asNumber(section.id) ?? id;
  return {
    sectionId: sectionIdValue,
    seasonId: asNumber(section.seasonId),
    title: typeof section.title === 'string' ? section.title : '',
    episodeCount: asNumber(section.epCount) ?? aids.length,
    aids,
  };
}

/**
 * bvid/aid → aid + cid + title。多 P 稿件取 `pages[0].cid`（只加主体）。
 * 投稿后稿件可能仍在过审，`view` 查不到 → VIDEO_NOT_READY（可重试）。
 */
async function getVideoInfo(credential, target = {}, options = {}) {
  const bvid = typeof target.bvid === 'string' ? target.bvid.trim() : '';
  const aid = positiveInt(target.aid);
  if (!bvid && aid === null) {
    throw new SeasonError(ERROR_CODES.INVALID_ARGUMENT, '查询稿件需要 bvid 或 aid');
  }

  const url = buildUrl(API_BASE, '/x/web-interface/view', bvid ? { bvid } : { aid });
  const payload = await request(url, credential, { timeoutMs: options.timeoutMs });

  // -404 在 view 语义下是「稿件还没就绪」而非参数错误，需要重试
  if (payload.code === -404) {
    throw new SeasonError(ERROR_CODES.VIDEO_NOT_READY, '稿件信息暂不可查（可能仍在审核）', {
      retryable: true,
      bizCode: -404,
    });
  }
  assertBizOk(payload, '获取稿件信息', { code: ERROR_CODES.VIDEO_NOT_READY });

  const data = payload.data;
  const videoAid = data ? positiveInt(data.aid) : null;
  const pages = data && Array.isArray(data.pages) ? data.pages : [];
  const cid = pages.length > 0 ? positiveInt(pages[0].cid) : null;

  if (videoAid === null || cid === null) {
    throw new SeasonError(ERROR_CODES.VIDEO_NOT_READY, '稿件信息缺少 aid/cid（可能仍在审核）', {
      retryable: true,
      bizCode: payload.code,
    });
  }

  return { aid: videoAid, cid, title: typeof data.title === 'string' ? data.title : '' };
}

/**
 * 追加稿件到小节。`sectionId` 为驼峰（线上契约），`episodes[].cid` 必填。
 * code 20080（已在合集中）归一为成功 —— B 站侧自带去重。
 */
async function addToSeason(credential, params = {}) {
  const sectionId = positiveInt(params.sectionId);
  if (sectionId === null) {
    throw new SeasonError(ERROR_CODES.INVALID_ARGUMENT, 'section_id 非法');
  }

  const source = Array.isArray(params.episodes) ? params.episodes : [];
  if (source.length === 0) {
    throw new SeasonError(ERROR_CODES.INVALID_ARGUMENT, '待加入小节的稿件为空');
  }

  const episodes = [];
  for (const item of source) {
    if (!item || typeof item !== 'object') {
      throw new SeasonError(ERROR_CODES.INVALID_ARGUMENT, '稿件条目结构非法');
    }
    const aid = positiveInt(item.aid);
    const cid = positiveInt(item.cid);
    if (aid === null || cid === null) {
      throw new SeasonError(ERROR_CODES.INVALID_ARGUMENT, '稿件条目缺少 aid/cid');
    }
    episodes.push({
      aid,
      cid,
      title: typeof item.title === 'string' ? item.title : '',
      charging_pay: positiveInt(item.charging_pay) ?? 0,
    });
  }

  const { csrf } = requireCredential(credential, { needCsrf: true });
  const url = buildUrl(MEMBER_BASE, '/x2/creative/web/season/section/episodes/add', { csrf });

  const payload = await request(url, credential, {
    method: 'POST',
    timeoutMs: params.timeoutMs,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ sectionId, episodes, csrf }),
  });

  if (payload.code === 20080) {
    return { added: true, alreadyAdded: true, bizCode: 20080 };
  }
  assertBizOk(payload, '加入合集小节');

  return { added: true, alreadyAdded: false, bizCode: payload.code ?? BIZ_OK };
}

/**
 * 登录态探测：`x/web-interface/nav`。返回 UID 与昵称，供账号登记与列表展示。
 * @returns {Promise<{isLogin: boolean, uid: string|null, nickname: string|null}>}
 */
async function checkLogin(credential, options = {}) {
  const url = buildUrl(API_BASE, '/x/web-interface/nav', {});
  const payload = await request(url, credential, { timeoutMs: options.timeoutMs });

  if (payload.code === BIZ_NOT_LOGGED_IN) {
    return { isLogin: false, uid: null, nickname: null };
  }
  assertBizOk(payload, '登录态探测');

  const data = payload.data || {};
  const mid = asNumber(data.mid);
  return {
    isLogin: data.isLogin === true,
    uid: mid === null ? null : String(mid),
    nickname: typeof data.uname === 'string' && data.uname !== '' ? data.uname : null,
  };
}

module.exports = {
  ERROR_CODES,
  SeasonError,
  listSeasons,
  getSeasonSection,
  getVideoInfo,
  addToSeason,
  checkLogin,
};
