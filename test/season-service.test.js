/**
 * SeasonService 单测
 *
 * 覆盖：触发门禁、三层幂等、就绪轮询、写阶段退避重试、异常矩阵终态、同账号串行、状态回写、凭证红线、列表缓存。
 * 合集客户端与 cookie 解析全部 mock，只验证编排语义；时钟用虚拟时钟推进，不真实等待。
 */

jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({ get: jest.fn(), setEx: jest.fn(), del: jest.fn() }));
jest.mock('../server/lib/core/notify', () => ({ send: jest.fn(async () => {}) }));
jest.mock('../server/lib/utils/biliup-cookie', () => {
  class CookieError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'CookieError';
      this.code = code;
    }
  }
  return {
    ERROR_CODES: {
      NOT_CONFIGURED: 'COOKIE_NOT_CONFIGURED',
      PATH_INVALID: 'COOKIE_PATH_INVALID',
      NOT_FOUND: 'COOKIE_NOT_FOUND',
      UNREADABLE: 'COOKIE_UNREADABLE',
      MALFORMED: 'COOKIE_MALFORMED',
      NO_CSRF: 'COOKIE_NO_CSRF',
    },
    CookieError,
    loadBiliupCookie: jest.fn(),
  };
});
jest.mock('../server/lib/core/bilibili-season', () => {
  const actual = jest.requireActual('../server/lib/core/bilibili-season');
  return {
    ERROR_CODES: actual.ERROR_CODES,
    SeasonError: actual.SeasonError,
    getVideoInfo: jest.fn(),
    getSeasonSection: jest.fn(),
    addToSeason: jest.fn(),
    listSeasons: jest.fn(),
  };
});

const pool = require('../server/db/index');
const redis = require('../server/db/redis');
const notify = require('../server/lib/core/notify');
const { loadBiliupCookie, CookieError } = require('../server/lib/utils/biliup-cookie');
const season = require('../server/lib/core/bilibili-season');
const SeasonService = require('../server/services/SeasonService');

const CREDENTIAL = {
  cookieHeader: 'SESSDATA=super_secret_value; bili_jct=super_secret_csrf',
  csrf: 'super_secret_csrf',
  uid: '724423252',
};

// 联表查询中模板侧字段的别名，与 _loadContext 的 SELECT 保持一致
const TEMPLATE_FIELDS = {
  template_id: 7,
  template_name: '日常投稿',
  cookies_path: '/data/biliup/cookies_bengtiezi.json',
  season_id: '427651',
  season_title: '直播录像合集',
  section_id: '5857201',
  season_auto_add: true,
};

function recordRow(overrides = {}) {
  return {
    id: 101,
    bv_id: 'BV1testBvid',
    season_status: 'none',
    season_attempts: 0,
    ...TEMPLATE_FIELDS,
    ...overrides,
  };
}

function emptySection(overrides = {}) {
  return { sectionId: 5857201, seasonId: 427651, title: '正片', episodeCount: 0, aids: [], ...overrides };
}

/**
 * SQL 文本派发的假数据库：按语句特征返回，避免脆弱的 once 链。
 * @param {object} options - records 记录集 / claimOk 占位是否成功 / currentStatus 第三层幂等读到的状态
 */
function mockPool({ records = [recordRow()], claimOk = true, currentStatus = 'pending' } = {}) {
  const list = Array.isArray(records) ? records : [records];
  pool.query.mockImplementation(async (sql, params = []) => {
    if (sql.includes("WHERE ur.season_status = 'pending'")) {
      return { rows: [] };
    }
    if (sql.includes('SELECT ur.id')) {
      const row = list.find((r) => String(r.id) === String(params[0]));
      return { rows: row ? [row] : [] };
    }
    if (sql.includes('AND season_pending_since IS NULL')) {
      return { rows: params.length ? [{ id: params[0], season_pending_since: new Date(clock.now) }] : [] };
    }
    if (sql.includes("SET season_status = 'pending'")) {
      return {
        rows: claimOk ? [{ id: params[0], season_pending_since: new Date(clock.now) }] : [],
      };
    }
    if (sql.includes('SELECT season_status FROM')) {
      return { rows: [{ season_status: currentStatus }] };
    }
    if (sql.includes('season_attempts = season_attempts + 1')) {
      return { rows: [] };
    }
    if (sql.includes("SET season_status = 'added'")) {
      return { rows: [{ id: params[0] }] };
    }
    if (sql.includes("SET season_status = 'failed'")) {
      return { rows: [{ id: params[0] }] };
    }
    throw new Error(`未预期的 SQL: ${sql}`);
  });
}

function callsFor(marker) {
  return pool.query.mock.calls.filter(([sql]) => sql.includes(marker));
}

/** 排空一次微任务队列，用于等待后台 detach 的执行链推进 */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function lastWrite(marker) {
  const calls = callsFor(marker);
  return calls.length ? calls[calls.length - 1] : null;
}

function bizError(code, { retryable = false, bizCode, message } = {}) {
  return new season.SeasonError(code, message || `合集接口调用失败: code=${bizCode ?? 0}`, { retryable, bizCode });
}

let sleeps;
let clock;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SEASON_ADD_DELAY_MS = '0';
  process.env.SEASON_ADD_BACKOFF_MS = '30000';
  process.env.SEASON_ADD_MAX_ATTEMPTS = '3';
  process.env.SEASON_READY_POLL_MS = '30000';
  process.env.SEASON_READY_TIMEOUT_MS = '1800000';
  process.env.SEASON_PENDING_MAX_AGE_MIN = '90';
  delete process.env.SEASON_AUTO_ADD_ENABLED;
  delete process.env.SEASON_LIST_CACHE_TTL;

  // 虚拟时钟：_sleep 直接推进时间，长轮询与退避不会真实等待
  clock = { now: Date.parse('2026-10-20T00:00:00Z') };
  jest.spyOn(SeasonService, '_now').mockImplementation(() => clock.now);
  sleeps = [];
  jest.spyOn(SeasonService, '_sleep').mockImplementation(async (ms) => {
    sleeps.push(ms);
    clock.now += ms;
  });

  loadBiliupCookie.mockResolvedValue(CREDENTIAL);
  season.getVideoInfo.mockResolvedValue({ aid: 5001, cid: 6001, title: '稿件标题' });
  season.getSeasonSection.mockResolvedValue(emptySection({ aids: [111, 222] }));
  season.addToSeason.mockResolvedValue({ added: true, alreadyAdded: false, bizCode: 0 });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('自动触发门禁', () => {
  test('总开关关闭时完全不碰数据库', async () => {
    process.env.SEASON_AUTO_ADD_ENABLED = 'false';
    const result = await SeasonService.scheduleAdd(101);
    expect(result).toEqual({ skipped: 'disabled' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('模板未开启 season_auto_add 时不占位', async () => {
    mockPool({ records: [recordRow({ season_auto_add: false })] });
    const result = await SeasonService.scheduleAdd(101);
    expect(result).toEqual({ skipped: 'template_off' });
    expect(callsFor("SET season_status = 'pending'")).toHaveLength(0);
    expect(season.addToSeason).not.toHaveBeenCalled();
  });

  test('模板未选择小节时不占位', async () => {
    mockPool({ records: [recordRow({ section_id: null })] });
    const result = await SeasonService.scheduleAdd(101);
    expect(result).toEqual({ skipped: 'no_section' });
    expect(season.addToSeason).not.toHaveBeenCalled();
  });

  test('投稿未成功、没有 BV 号时不占位', async () => {
    mockPool({ records: [recordRow({ bv_id: '' })] });
    const result = await SeasonService.scheduleAdd(101);
    expect(result).toEqual({ skipped: 'no_bvid' });
    expect(callsFor("SET season_status = 'pending'")).toHaveLength(0);
  });

  test('记录不存在时不占位', async () => {
    mockPool({ records: [] });
    const result = await SeasonService.scheduleAdd(101);
    expect(result).toEqual({ skipped: 'no_record' });
  });

  test('占位失败（并发或已 added）时不发起任何合集请求', async () => {
    mockPool({ claimOk: false });
    const result = await SeasonService.scheduleAdd(101);
    expect(result).toEqual({ skipped: 'claim_conflict' });
    expect(loadBiliupCookie).not.toHaveBeenCalled();
    expect(season.getVideoInfo).not.toHaveBeenCalled();
  });

  test('占位语句带原子条件并写入模板 season_id', async () => {
    mockPool();
    await SeasonService.scheduleAdd(101);
    const [sql, params] = callsFor("SET season_status = 'pending'")[0];
    expect(sql).toContain("season_status IN ('none','failed')");
    expect(sql).toContain('RETURNING id');
    expect(params).toEqual([101, 427651]);
  });

  test('延迟取 SEASON_ADD_DELAY_MS，为 0 时不等待', async () => {
    mockPool();
    await SeasonService.scheduleAdd(101);
    expect(sleeps).toEqual([]);

    process.env.SEASON_ADD_DELAY_MS = '45000';
    mockPool({ records: [recordRow({ id: 102 })] });
    await SeasonService.scheduleAdd(102);
    expect(sleeps).toEqual([45000]);
  });
});

describe('正常执行链路', () => {
  test('占位 → 取稿件信息 → 查小节 → 写入 → 标记 added', async () => {
    season.getSeasonSection.mockResolvedValueOnce(emptySection({ aids: [111] }));
    mockPool();
    const result = await SeasonService.scheduleAdd(101);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(sleeps).toEqual([]);
    expect(loadBiliupCookie).toHaveBeenCalledWith('/data/biliup/cookies_bengtiezi.json');
    expect(season.getVideoInfo).toHaveBeenCalledWith(CREDENTIAL, { bvid: 'BV1testBvid' });
    expect(season.getSeasonSection).toHaveBeenCalledWith(CREDENTIAL, 5857201);
    expect(season.addToSeason).toHaveBeenCalledWith(CREDENTIAL, {
      sectionId: 5857201,
      episodes: [{ aid: 5001, cid: 6001, title: '稿件标题' }],
    });
    const [sql, params] = lastWrite("SET season_status = 'added'");
    expect(sql).toContain("WHERE id = $1 AND season_status = 'pending'");
    expect(params).toEqual([101, 427651]);
    expect(callsFor("SET season_status = 'failed'")).toHaveLength(0);
  });

  test('小节已含该稿件时直接置 added，不发写请求', async () => {
    season.getSeasonSection.mockResolvedValueOnce(emptySection({ episodeCount: 3, aids: [5001] }));
    mockPool();
    const result = await SeasonService.scheduleAdd(101);

    expect(result.ok).toBe(true);
    expect(result.alreadyPresent).toBe(true);
    expect(season.addToSeason).not.toHaveBeenCalled();
    expect(lastWrite("SET season_status = 'added'")).not.toBeNull();
  });

  test('写入前状态已被改写时放弃写请求（第三层幂等）', async () => {
    season.getSeasonSection.mockResolvedValueOnce(emptySection());
    mockPool({ currentStatus: 'added' });
    const result = await SeasonService.scheduleAdd(101);

    expect(result.ok).toBe(false);
    expect(result.code).toBe('STATE_CHANGED');
    expect(season.addToSeason).not.toHaveBeenCalled();
    expect(callsFor("SET season_status = 'failed'")).toHaveLength(0);
  });

  test('B 站返回 20080 归一为成功，不标 failed', async () => {
    season.getSeasonSection.mockResolvedValueOnce(emptySection());
    season.addToSeason.mockResolvedValueOnce({ added: true, alreadyAdded: true, bizCode: 20080 });
    mockPool();
    const result = await SeasonService.scheduleAdd(101);

    expect(result.ok).toBe(true);
    expect(callsFor("SET season_status = 'added'")).toHaveLength(1);
    expect(callsFor("SET season_status = 'failed'")).toHaveLength(0);
  });

  test('小节归属以线上为准，覆盖模板里的展示用 season_id', async () => {
    season.getSeasonSection.mockResolvedValueOnce(emptySection({ seasonId: 999888 }));
    mockPool();
    await SeasonService.scheduleAdd(101);
    const [, params] = lastWrite("SET season_status = 'added'");
    expect(params).toEqual([101, 999888]);
  });
});

describe('就绪轮询', () => {
  test('稿件晚就绪时持续轮询，就绪后才写且只消耗一次写尝试', async () => {
    season.getVideoInfo
      .mockRejectedValueOnce(bizError(season.ERROR_CODES.VIDEO_NOT_READY, { retryable: true, bizCode: -404 }))
      .mockRejectedValueOnce(bizError(season.ERROR_CODES.VIDEO_NOT_READY, { retryable: true, bizCode: -404 }))
      .mockResolvedValueOnce({ aid: 5001, cid: 6001, title: '稿件标题' });
    mockPool();
    const result = await SeasonService.scheduleAdd(101);

    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([30000, 30000]);
    expect(season.getVideoInfo).toHaveBeenCalledTimes(3);
    expect(callsFor('season_attempts = season_attempts + 1')).toHaveLength(1);
    expect(season.addToSeason).toHaveBeenCalledTimes(1);
    expect(lastWrite("SET season_status = 'added'")).not.toBeNull();
  });

  test('瞬态网络错误（retryable）在就绪阶段被容忍', async () => {
    season.getVideoInfo
      .mockRejectedValueOnce(bizError('NETWORK_ERROR', { retryable: true, message: 'fetch failed' }))
      .mockResolvedValueOnce({ aid: 5001, cid: 6001, title: '稿件标题' });
    mockPool();
    const result = await SeasonService.scheduleAdd(101);

    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([30000]);
    expect(callsFor('season_attempts = season_attempts + 1')).toHaveLength(1);
  });

  test('凭证失效等不可重试错误直接失败，不进入写队列', async () => {
    season.getVideoInfo.mockRejectedValue(bizError(season.ERROR_CODES.AUTH_EXPIRED, { bizCode: -101 }));
    mockPool();
    const result = await SeasonService.scheduleAdd(101);

    expect(result.ok).toBe(false);
    expect(result.code).toBe(season.ERROR_CODES.AUTH_EXPIRED);
    expect(sleeps).toEqual([]);
    expect(season.getSeasonSection).not.toHaveBeenCalled();
    expect(season.addToSeason).not.toHaveBeenCalled();
  });

  test('就绪超时以 VIDEO_READY_TIMEOUT 收敛，不占用写重试次数', async () => {
    process.env.SEASON_READY_TIMEOUT_MS = '60000';
    season.getVideoInfo.mockRejectedValue(
      bizError(season.ERROR_CODES.VIDEO_NOT_READY, { retryable: true, bizCode: -404 })
    );
    mockPool();
    const result = await SeasonService.scheduleAdd(101);

    expect(result).toEqual({ ok: false, attempts: 0, code: season.ERROR_CODES.VIDEO_READY_TIMEOUT });
    expect(sleeps).toEqual([30000, 30000]);
    expect(season.getVideoInfo).toHaveBeenCalledTimes(3);
    expect(callsFor('season_attempts = season_attempts + 1')).toHaveLength(0);
    expect(season.addToSeason).not.toHaveBeenCalled();
    const [, params] = lastWrite("SET season_status = 'failed'");
    expect(params[1]).toContain(season.ERROR_CODES.VIDEO_READY_TIMEOUT);
  });

  test('最终失败只发一条 season_add_failed 通知', async () => {
    season.getSeasonSection.mockResolvedValueOnce(emptySection());
    season.addToSeason.mockRejectedValue(bizError(season.ERROR_CODES.AUTH_EXPIRED, { bizCode: -101 }));
    mockPool();
    await SeasonService.scheduleAdd(101);

    expect(notify.send).toHaveBeenCalledTimes(1);
    const [eventType, title, content] = notify.send.mock.calls[0];
    expect(eventType).toBe('season_add_failed');
    expect(title).toContain('BV1testBvid');
    expect(content).toContain('记录 ID：101');
    expect(content).toContain('AUTH_EXPIRED');
  });

  test('重复收敛（状态已非 pending）不再发通知', async () => {
    // 模拟 UPDATE ... WHERE season_status='pending' 命中 0 行
    pool.query.mockResolvedValue({ rows: [] });
    const err = bizError(season.ERROR_CODES.AUTH_EXPIRED, { bizCode: -101 });

    const changed = await SeasonService._markFailed(101, err, { ...recordRow(), table: 'upload_records' });

    expect(changed).toBe(false);
    expect(notify.send).not.toHaveBeenCalled();
  });
});

describe('重试与退避', () => {
  test('写阶段瞬态错误按指数退避重试后成功', async () => {
    season.getSeasonSection.mockResolvedValue(emptySection());
    season.addToSeason
      .mockRejectedValueOnce(bizError('NETWORK_ERROR', { retryable: true, message: 'fetch failed' }))
      .mockResolvedValueOnce({ added: true, alreadyAdded: false, bizCode: 0 });
    mockPool();
    const result = await SeasonService.scheduleAdd(101);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([30000]);
    expect(callsFor('season_attempts = season_attempts + 1')).toHaveLength(2);
  });

  test('写阶段可重试错误按指数退避到上限后转 failed', async () => {
    season.getSeasonSection.mockResolvedValue(emptySection());
    season.addToSeason.mockRejectedValue(bizError(season.ERROR_CODES.BIZ_ERROR, { retryable: true, bizCode: 99999 }));
    mockPool();
    const result = await SeasonService.scheduleAdd(101);

    expect(result).toEqual({ ok: false, attempts: 3, code: season.ERROR_CODES.BIZ_ERROR });
    expect(sleeps).toEqual([30000, 60000]);
    expect(season.addToSeason).toHaveBeenCalledTimes(3);
    expect(callsFor('season_attempts = season_attempts + 1')).toHaveLength(3);
    const [, params] = lastWrite("SET season_status = 'failed'");
    expect(params[1]).toContain(season.ERROR_CODES.BIZ_ERROR);
  });

  test('不可重试错误立即 failed，不消耗重试额度', async () => {
    season.getSeasonSection.mockResolvedValueOnce(emptySection());
    season.addToSeason.mockRejectedValue(bizError(season.ERROR_CODES.AUTH_EXPIRED, { bizCode: -101 }));
    mockPool();
    const result = await SeasonService.scheduleAdd(101);

    expect(result.attempts).toBe(1);
    expect(season.addToSeason).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  test('命中 20111 频控时退避不低于 10s', async () => {
    process.env.SEASON_ADD_BACKOFF_MS = '1000';
    season.getSeasonSection.mockResolvedValueOnce(emptySection());
    season.addToSeason.mockRejectedValueOnce(
      bizError(season.ERROR_CODES.TOO_FREQUENT, { retryable: true, bizCode: 20111 })
    );
    mockPool();
    const result = await SeasonService.scheduleAdd(101);

    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([10000]);
  });

  test('cookie 读取失败按不可重试处理，立即 failed', async () => {
    loadBiliupCookie.mockRejectedValue(new CookieError('COOKIE_NO_CSRF', 'cookie 缺少 bili_jct，无法执行合集写操作'));
    mockPool();
    const result = await SeasonService.scheduleAdd(101);

    expect(result.ok).toBe(false);
    expect(result.code).toBe('COOKIE_NO_CSRF');
    expect(season.getVideoInfo).not.toHaveBeenCalled();
    const [, params] = lastWrite("SET season_status = 'failed'");
    expect(params[1]).toContain('COOKIE_NO_CSRF');
  });
});

describe('同账号串行', () => {
  test('慢就绪记录不阻塞同账号后续记录进入写队列（队头阻塞回归）', async () => {
    mockPool({
      records: [recordRow({ id: 101, bv_id: 'BV1fast' }), recordRow({ id: 102, bv_id: 'BV1slow' })],
    });
    let releaseSlow;
    const slowReady = new Promise((resolve) => {
      releaseSlow = () => resolve({ aid: 5002, cid: 6002, title: '慢稿件' });
    });
    season.getVideoInfo.mockImplementation(async (_credential, { bvid }) => {
      if (bvid === 'BV1slow') return slowReady;
      return { aid: 5001, cid: 6001, title: '快稿件' };
    });
    season.getSeasonSection.mockResolvedValue(emptySection());
    let inFlight = 0;
    let peak = 0;
    season.addToSeason.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      return { added: true, alreadyAdded: false, bizCode: 0 };
    });

    const slow = SeasonService.scheduleAdd(102);
    const fast = SeasonService.scheduleAdd(101);

    // 慢记录仍在轮询时，快记录应已完成写入，而不是排在它后面等待
    const fastResult = await fast;
    expect(fastResult.ok).toBe(true);
    expect(season.addToSeason).toHaveBeenCalledTimes(1);
    expect(season.addToSeason.mock.calls[0][1].episodes[0].title).toBe('快稿件');

    releaseSlow();
    const slowResult = await slow;
    expect(slowResult.ok).toBe(true);
    expect(season.addToSeason).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  });

  test('同一 cookie 路径的两次加入不并发发起写请求', async () => {
    mockPool({ records: [recordRow(), recordRow({ id: 102 })] });
    let inFlight = 0;
    let peak = 0;
    season.getSeasonSection.mockResolvedValue(emptySection());
    season.addToSeason.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      return { added: true, alreadyAdded: false, bizCode: 0 };
    });

    await Promise.all([SeasonService.scheduleAdd(101), SeasonService.scheduleAdd(102)]);
    expect(peak).toBe(1);
    expect(season.addToSeason).toHaveBeenCalledTimes(2);
  });

  test('不同 cookie 路径的加入互不阻塞', async () => {
    mockPool({
      records: [recordRow(), recordRow({ id: 102, cookies_path: '/data/biliup/cookies_other.json' })],
    });
    let inFlight = 0;
    let peak = 0;
    season.getSeasonSection.mockResolvedValue(emptySection());
    season.addToSeason.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      return { added: true, alreadyAdded: false, bizCode: 0 };
    });

    await Promise.all([SeasonService.scheduleAdd(101), SeasonService.scheduleAdd(102)]);
    expect(peak).toBe(2);
  });
});

describe('手动重试入口', () => {
  test('已 added 返回 409', async () => {
    mockPool({ records: [recordRow({ season_status: 'added' })] });
    const result = await SeasonService.retryAdd(101);
    expect(result.http).toBe(409);
    expect(callsFor("SET season_status = 'pending'")).toHaveLength(0);
  });

  test('pending 返回 409（并发保护）', async () => {
    mockPool({ records: [recordRow({ season_status: 'pending' })] });
    const result = await SeasonService.retryAdd(101);
    expect(result.http).toBe(409);
    expect(season.getVideoInfo).not.toHaveBeenCalled();
  });

  test('failed 重新占位并立即执行（不延迟）', async () => {
    mockPool({ records: [recordRow({ season_status: 'failed' })] });
    const result = await SeasonService.retryAdd(101);
    expect(result.http).toBe(200);
    await flush();
    expect(sleeps).toEqual([]);
    expect(season.addToSeason).toHaveBeenCalledTimes(1);
  });

  test('重试请求不等待执行完成，占位后立即返回', async () => {
    mockPool({ records: [recordRow({ season_status: 'failed' })] });
    let release;
    season.addToSeason.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ added: true, alreadyAdded: false, bizCode: 0 })))
    );

    const result = await SeasonService.retryAdd(101);
    await flush();

    expect(result.ok).toBe(true);
    expect(season.addToSeason).toHaveBeenCalledTimes(1);
    expect(callsFor("SET season_status = 'added'")).toHaveLength(0);

    release();
    await flush();
    expect(callsFor("SET season_status = 'added'")).toHaveLength(1);
  });

  test('总开关关闭时手动重试仍然可用', async () => {
    process.env.SEASON_AUTO_ADD_ENABLED = 'false';
    mockPool({ records: [recordRow({ season_status: 'failed' })] });
    const result = await SeasonService.retryAdd(101);
    expect(result.http).toBe(200);
    await flush();
    expect(season.addToSeason).toHaveBeenCalledTimes(1);
  });

  test('记录不存在返回 404', async () => {
    mockPool({ records: [] });
    const result = await SeasonService.retryAdd(999);
    expect(result.http).toBe(404);
  });

  test('模板未配置小节返回 400 且带可读提示', async () => {
    mockPool({ records: [recordRow({ section_id: null, season_status: 'failed' })] });
    const result = await SeasonService.retryAdd(101);
    expect(result.http).toBe(400);
    expect(result.message).toContain('小节');
  });
});

describe('状态回写与凭证红线', () => {
  test('失败原因含错误码与线上文案，不含任何凭证', async () => {
    season.getSeasonSection.mockResolvedValueOnce(emptySection());
    season.addToSeason.mockRejectedValue(
      bizError(season.ERROR_CODES.BIZ_ERROR, { bizCode: 99999, message: '合集接口调用失败: code=99999' })
    );
    mockPool();
    await SeasonService.scheduleAdd(101);
    const [, params] = lastWrite("SET season_status = 'failed'");
    expect(params[1]).toContain('BIZ_ERROR');
    expect(params[1]).not.toContain('super_secret');
    expect(params[1]).not.toContain('SESSDATA');
    expect(params[1]).not.toContain('bili_jct');
  });

  test('日志只输出错误码与类别，不含 cookie / csrf 值', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    season.getSeasonSection.mockResolvedValueOnce(emptySection());
    season.addToSeason.mockRejectedValue(bizError(season.ERROR_CODES.RATE_LIMITED, { bizCode: -352 }));
    mockPool();
    await SeasonService.scheduleAdd(101);

    const all = [...errSpy.mock.calls, ...logSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String).join('\n');
    expect(all).toContain('RATE_LIMITED');
    expect(all).not.toContain('super_secret_value');
    expect(all).not.toContain('super_secret_csrf');
  });

  test('执行体内的意外异常被收敛，不冒泡成未处理拒绝', async () => {
    mockPool();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    season.getVideoInfo.mockRejectedValue(new TypeError('boom'));
    const result = await SeasonService.scheduleAdd(101);
    expect(result.ok).toBe(false);
    const [, params] = lastWrite("SET season_status = 'failed'");
    expect(params[1]).toContain('UNKNOWN');
  });
});

describe('回放投稿复用同一编排', () => {
  test('source=replay 时读上下文与三处状态写入全部落在 replay_upload_records', async () => {
    mockPool({ records: [recordRow({ id: 201 })] });
    const result = await SeasonService.scheduleAdd(201, 'replay');

    expect(result.ok).toBe(true);
    expect(callsFor('SELECT ur.id')[0][0]).toContain('FROM replay_upload_records ur');
    expect(callsFor("SET season_status = 'pending'")[0][0]).toContain('UPDATE replay_upload_records');
    expect(lastWrite("SET season_status = 'added'")[0]).toContain('UPDATE replay_upload_records');
    // 两表 id 各自独立自增，串到常规表就是静默改错稿件
    expect(callsFor('UPDATE upload_records')).toHaveLength(0);
    expect(callsFor('FROM upload_records ')).toHaveLength(0);
  });

  test('手动重试同样按 source 选表', async () => {
    mockPool({ records: [recordRow({ id: 201, season_status: 'failed' })] });
    const result = await SeasonService.retryAdd(201, 'replay');

    expect(result.ok).toBe(true);
    expect(callsFor("SET season_status = 'pending'")[0][0]).toContain('UPDATE replay_upload_records');
    expect(callsFor('UPDATE upload_records')).toHaveLength(0);
  });

  test('缺省与未知 source 都退回常规投稿表', async () => {
    mockPool();
    await SeasonService.scheduleAdd(101);
    await SeasonService.retryAdd(101, 'nonsense');

    expect(callsFor('SELECT ur.id').every(([sql]) => sql.includes('FROM upload_records ur'))).toBe(true);
    expect(callsFor('UPDATE replay_upload_records')).toHaveLength(0);
  });

  test('失败终态写回发起的那张表，不留错误在另一张表', async () => {
    season.getSeasonSection.mockResolvedValueOnce(emptySection());
    season.addToSeason.mockRejectedValue(bizError(season.ERROR_CODES.RATE_LIMITED, { bizCode: 20111 }));
    mockPool({ records: [recordRow({ id: 201 })] });
    const result = await SeasonService.scheduleAdd(201, 'replay');

    expect(result.ok).toBe(false);
    expect(lastWrite("SET season_status = 'failed'")[0]).toContain('UPDATE replay_upload_records');
  });
});

describe('合集列表缓存', () => {
  const SEASONS = [{ id: 1, title: 'A', sections: [{ id: 2, title: 'B' }] }];

  test('未命中缓存时拉取线上并写入缓存', async () => {
    redis.get.mockResolvedValue(null);
    season.listSeasons.mockResolvedValue({ seasons: SEASONS, total: 1 });
    const result = await SeasonService.listSeasonsByCookies('/data/biliup/cookies_a.json');
    expect(result.seasons).toEqual(SEASONS);
    expect(result.cached).toBe(false);
    expect(season.listSeasons).toHaveBeenCalledWith(CREDENTIAL, { pn: 1, ps: 30 });
    expect(redis.setEx).toHaveBeenCalled();
  });

  test('命中缓存时不发起线上请求', async () => {
    redis.get.mockResolvedValue(JSON.stringify({ seasons: SEASONS, fetched_at: 1 }));
    const result = await SeasonService.listSeasonsByCookies('/data/biliup/cookies_a.json');
    expect(result.cached).toBe(true);
    expect(result.seasons).toEqual(SEASONS);
    expect(season.listSeasons).not.toHaveBeenCalled();
    expect(loadBiliupCookie).not.toHaveBeenCalled();
  });

  test('Redis 不可用时降级直连，不影响结果', async () => {
    redis.get.mockRejectedValue(new Error('redis down'));
    redis.setEx.mockRejectedValue(new Error('redis down'));
    season.listSeasons.mockResolvedValue({ seasons: SEASONS, total: 1 });
    const result = await SeasonService.listSeasonsByCookies('/data/biliup/cookies_a.json');
    expect(result.seasons).toEqual(SEASONS);
  });

  test('缓存键与缓存值都不含 cookie 路径和凭证', async () => {
    redis.get.mockResolvedValue(null);
    season.listSeasons.mockResolvedValue({ seasons: SEASONS, total: 1 });
    await SeasonService.listSeasonsByCookies('/data/biliup/cookies_a.json');
    const [key, ttl, value] = redis.setEx.mock.calls[0];
    expect(key).toContain('season:seasons:');
    expect(key).not.toContain('cookies_a');
    expect(ttl).toBe(600);
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain('super_secret');
    expect(serialized).not.toContain('cookies_a');
  });

  test('cookie 不可读时抛出错误而非空列表', async () => {
    redis.get.mockResolvedValue(null);
    loadBiliupCookie.mockRejectedValue(new CookieError('COOKIE_NOT_FOUND', 'cookie 文件不存在'));
    await expect(SeasonService.listSeasonsByCookies('/data/biliup/missing.json')).rejects.toMatchObject({
      code: 'COOKIE_NOT_FOUND',
    });
  });
});

describe('模板保存前的归属校验', () => {
  const PATH = '/data/biliup/cookies_a.json';
  const ONLINE = [
    { seasonId: 427651, title: '直播录像合集', sections: [{ sectionId: 5857201, title: '正片' }] },
    { seasonId: 427652, title: '其他合集', sections: [] },
  ];

  beforeEach(() => {
    redis.get.mockResolvedValue(null);
    season.listSeasons.mockResolvedValue({ seasons: ONLINE, total: ONLINE.length });
  });

  test('合集与小节都匹配时通过', async () => {
    const verdict = await SeasonService.validateSelection(PATH, 427651, 5857201);
    expect(verdict.ok).toBe(true);
    expect(verdict.http).toBe(200);
  });

  test('pg 回传的字符串 ID 同样能匹配', async () => {
    const verdict = await SeasonService.validateSelection(PATH, '427651', '5857201');
    expect(verdict.ok).toBe(true);
  });

  test('只选合集不选小节时只校验合集归属', async () => {
    const verdict = await SeasonService.validateSelection(PATH, 427652, null);
    expect(verdict.ok).toBe(true);
  });

  test('合集不属于该账号时拒绝，不静默放行', async () => {
    const verdict = await SeasonService.validateSelection(PATH, 123456, null);
    expect(verdict).toEqual({ ok: false, http: 400, message: '所选合集不属于该 cookie 账号，请重新选择' });
  });

  test('小节不属于该合集时拒绝', async () => {
    const verdict = await SeasonService.validateSelection(PATH, 427652, 5857201);
    expect(verdict).toEqual({ ok: false, http: 400, message: '所选小节不属于该合集，请重新选择' });
  });

  test('只给小节不给合集时拒绝', async () => {
    const verdict = await SeasonService.validateSelection(PATH, null, 5857201);
    expect(verdict).toEqual({ ok: false, http: 400, message: '选择小节时必须同时指定所属合集' });
    expect(loadBiliupCookie).not.toHaveBeenCalled();
  });

  test('未选择合集时直接通过，不碰线上', async () => {
    const verdict = await SeasonService.validateSelection(PATH, null, null);
    expect(verdict.ok).toBe(true);
    expect(loadBiliupCookie).not.toHaveBeenCalled();
    expect(season.listSeasons).not.toHaveBeenCalled();
  });

  test('缺少 cookie 路径时拒绝，提示先配置 cookie', async () => {
    const verdict = await SeasonService.validateSelection('', 427651, null);
    expect(verdict).toEqual({ ok: false, http: 400, message: '未配置 cookie 文件路径，无法校验合集归属' });
  });

  test('命中列表缓存时不重复拉线上', async () => {
    redis.get.mockResolvedValue(JSON.stringify({ seasons: ONLINE, fetched_at: 1 }));
    const verdict = await SeasonService.validateSelection(PATH, 427651, 5857201);
    expect(verdict.ok).toBe(true);
    expect(season.listSeasons).not.toHaveBeenCalled();
  });

  test('cookie 类失败回 400，日志与文案都不含凭证', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    loadBiliupCookie.mockRejectedValue(new CookieError('COOKIE_MALFORMED', `解析失败: ${CREDENTIAL.cookieHeader}`));

    const verdict = await SeasonService.validateSelection(PATH, 427651, 5857201);

    expect(verdict.ok).toBe(false);
    expect(verdict.http).toBe(400);
    const serialized = JSON.stringify(verdict) + console.error.mock.calls.join(' ');
    expect(serialized).not.toContain('super_secret_value');
    expect(serialized).not.toContain('super_secret_csrf');
    expect(console.error).toHaveBeenCalledWith('[合集] 归属校验失败: COOKIE_MALFORMED');
  });

  test('线上不可用回 500 通用文案，不伪装成归属不匹配', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    season.listSeasons.mockRejectedValue(new season.SeasonError('RATE_LIMITED', '请求过于频繁', { retryable: true }));

    const verdict = await SeasonService.validateSelection(PATH, 427651, 5857201);

    expect(verdict).toEqual({ ok: false, http: 500, message: '合集归属校验失败，请稍后重试' });
  });
});
