/**
 * 启动续跑 pending 合集任务的单测
 *
 * 覆盖：非阻塞续跑、沿用已消耗的写次数、续跑窗口、模板失效/软删、开关关闭、
 * 聚合通知只发一条、DB 异常不阻断启动链。
 */

jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({ get: jest.fn(), setEx: jest.fn(), del: jest.fn() }));
jest.mock('../server/lib/core/notify', () => ({ send: jest.fn(async () => {}) }));
jest.mock('../server/lib/utils/biliup-cookie', () => ({ loadBiliupCookie: jest.fn() }));
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
const notify = require('../server/lib/core/notify');
const { loadBiliupCookie } = require('../server/lib/utils/biliup-cookie');
const season = require('../server/lib/core/bilibili-season');
const SeasonService = require('../server/services/SeasonService');

const CREDENTIAL = { cookieHeader: 'SESSDATA=secret; bili_jct=csrf', csrf: 'csrf', uid: '724423252' };
const EMPTY_SUMMARY = { resumed: [], expired: [], invalid: [] };

let clock;
let tables;

function pendingRow(overrides = {}) {
  return {
    id: 101,
    bv_id: 'BV1resume',
    season_status: 'pending',
    season_attempts: 1,
    season_pending_since: new Date(clock.now - 10 * 60000),
    deleted_at: null,
    template_id: 7,
    template_name: '日常投稿',
    cookies_path: '/data/biliup/cookies_a.json',
    season_id: '427651',
    season_title: '直播录像合集',
    section_id: '5857201',
    season_auto_add: true,
    ...overrides,
  };
}

function mockDb() {
  pool.query.mockImplementation(async (sql, params = []) => {
    if (sql.includes("WHERE ur.season_status = 'pending'")) {
      const table = sql.includes('replay_upload_records') ? 'replay_upload_records' : 'upload_records';
      return { rows: tables[table] };
    }
    if (sql.includes('AND season_pending_since IS NULL')) {
      return { rows: params.length ? [{ id: params[0], season_pending_since: new Date(clock.now) }] : [] };
    }
    if (sql.includes('season_attempts = season_attempts + 1')) return { rows: [] };
    if (sql.includes('SELECT season_status FROM')) return { rows: [{ season_status: 'pending' }] };
    if (sql.includes("SET season_status = 'added'")) return { rows: [{ id: params[0] }] };
    if (sql.includes("SET season_status = 'failed'")) return { rows: [{ id: params[0] }] };
    throw new Error(`未预期的 SQL: ${sql}`);
  });
}

function callsFor(marker) {
  return pool.query.mock.calls.filter(([sql]) => sql.includes(marker));
}

function lastWrite(marker) {
  const calls = callsFor(marker);
  return calls.length ? calls[calls.length - 1] : null;
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, attempts = 200) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error('等待条件超时');
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SEASON_ADD_MAX_ATTEMPTS = '3';
  process.env.SEASON_PENDING_MAX_AGE_MIN = '90';
  process.env.SEASON_READY_POLL_MS = '30000';
  process.env.SEASON_READY_TIMEOUT_MS = '1800000';
  process.env.SEASON_WRITE_GAP_MS = '0';
  delete process.env.SEASON_AUTO_ADD_ENABLED;

  clock = { now: Date.parse('2026-10-20T00:00:00Z') };
  jest.spyOn(SeasonService, '_now').mockImplementation(() => clock.now);
  jest.spyOn(SeasonService, '_sleep').mockImplementation(async (ms) => {
    clock.now += ms;
  });

  tables = { upload_records: [], replay_upload_records: [] };
  loadBiliupCookie.mockResolvedValue(CREDENTIAL);
  season.getVideoInfo.mockResolvedValue({ aid: 5001, cid: 6001, title: '稿件标题' });
  season.getSeasonSection.mockResolvedValue({
    sectionId: 5857201,
    seasonId: 427651,
    title: '正片',
    episodeCount: 0,
    aids: [],
  });
  season.addToSeason.mockResolvedValue({ added: true, alreadyAdded: false, bizCode: 0 });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('resumePending', () => {
  test('有效 pending 非阻塞续跑，完成后置 added 且不再占位', async () => {
    tables.upload_records = [pendingRow()];
    mockDb();

    const summary = await SeasonService.resumePending();

    expect(summary).toEqual({ resumed: [101], expired: [], invalid: [] });
    await waitFor(() => callsFor("SET season_status = 'added'").length === 1);
    expect(season.addToSeason).toHaveBeenCalledTimes(1);
    // 续跑记录已是 pending，不能再走 _claim 的状态条件
    expect(callsFor("SET season_status = 'pending'")).toHaveLength(0);
    expect(lastWrite("SET season_status = 'added'")[0]).toContain('UPDATE upload_records');
    expect(notify.send).not.toHaveBeenCalled();
  });

  test('续跑不阻塞启动链：执行仍在等待时 resumePending 已返回', async () => {
    tables.upload_records = [pendingRow()];
    let release;
    season.getVideoInfo.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ aid: 5001, cid: 6001, title: '稿件标题' });
        })
    );
    mockDb();

    const summary = await SeasonService.resumePending();

    expect(summary.resumed).toEqual([101]);
    expect(season.addToSeason).not.toHaveBeenCalled();

    release();
    await waitFor(() => callsFor("SET season_status = 'added'").length === 1);
  });

  test('续跑沿用已消耗的写次数：预算只剩一次时失败即终态', async () => {
    tables.upload_records = [pendingRow({ season_attempts: 2 })];
    season.addToSeason.mockRejectedValue(
      new season.SeasonError('BIZ_ERROR', '合集接口调用失败: code=99999', { retryable: true, bizCode: 99999 })
    );
    mockDb();

    const summary = await SeasonService.resumePending();
    expect(summary.resumed).toEqual([101]);

    await waitFor(() => callsFor("SET season_status = 'failed'").length === 1);
    // 第 3 次即上限，不再有退避重试
    expect(season.addToSeason).toHaveBeenCalledTimes(1);
    const [eventType] = notify.send.mock.calls[0];
    expect(eventType).toBe('season_add_failed');
  });

  test('超过续跑窗口判 failed，两表合并成一条 season_pending_expired 通知', async () => {
    const stale = new Date(clock.now - 91 * 60000);
    tables.upload_records = [pendingRow({ id: 101, season_pending_since: stale })];
    tables.replay_upload_records = [pendingRow({ id: 201, season_pending_since: stale })];
    mockDb();

    const summary = await SeasonService.resumePending();

    expect(summary).toEqual({ resumed: [], expired: [101, 201], invalid: [] });
    expect(season.getVideoInfo).not.toHaveBeenCalled();
    expect(notify.send).toHaveBeenCalledTimes(1);
    const [eventType, title, content] = notify.send.mock.calls[0];
    expect(eventType).toBe('season_pending_expired');
    expect(title).toContain('2 条');
    expect(content).toContain('常规投稿：ID 101');
    expect(content).toContain('回放投稿：ID 201');
    expect(callsFor("SET season_status = 'failed'")).toHaveLength(2);
  });

  test('软删除记录静默失败，不触发批量通知', async () => {
    tables.upload_records = [pendingRow({ deleted_at: new Date(clock.now - 1000) })];
    mockDb();

    const summary = await SeasonService.resumePending();

    expect(summary.invalid).toEqual([101]);
    expect(notify.send).not.toHaveBeenCalled();
    expect(season.getVideoInfo).not.toHaveBeenCalled();
    const [, params] = lastWrite("SET season_status = 'failed'");
    expect(params[1]).toContain('已删除');
  });

  test('模板失效或缺少小节判 invalid，不发起任何线上请求', async () => {
    tables.upload_records = [pendingRow({ section_id: null })];
    mockDb();

    const summary = await SeasonService.resumePending();

    expect(summary.invalid).toEqual([101]);
    expect(loadBiliupCookie).not.toHaveBeenCalled();
    expect(notify.send).toHaveBeenCalledTimes(1);
    expect(notify.send.mock.calls[0][2]).toContain('任务数据不完整');
  });

  test('写次数已耗尽的 pending 不再续跑', async () => {
    tables.upload_records = [pendingRow({ season_attempts: 3 })];
    mockDb();

    const summary = await SeasonService.resumePending();

    expect(summary.expired).toEqual([101]);
    expect(season.addToSeason).not.toHaveBeenCalled();
    expect(notify.send.mock.calls[0][2]).toContain('重试次数已耗尽');
  });

  test('历史记录缺少 season_pending_since 时补写占位时刻', async () => {
    tables.upload_records = [pendingRow({ season_pending_since: null })];
    mockDb();

    const summary = await SeasonService.resumePending();

    expect(summary.resumed).toEqual([101]);
    expect(callsFor('AND season_pending_since IS NULL')).toHaveLength(1);
    await waitFor(() => callsFor("SET season_status = 'added'").length === 1);
  });

  test('总开关关闭时 pending 回收为 failed，不再续跑', async () => {
    process.env.SEASON_AUTO_ADD_ENABLED = 'false';
    tables.upload_records = [pendingRow()];
    mockDb();

    const summary = await SeasonService.resumePending();

    expect(summary.expired).toEqual([101]);
    expect(season.getVideoInfo).not.toHaveBeenCalled();
    expect(notify.send).toHaveBeenCalledTimes(1);
    expect(notify.send.mock.calls[0][2]).toContain('自动加入已关闭');
  });

  test('数据库异常只记日志，不阻断启动链', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    pool.query.mockRejectedValue(new Error('connection reset'));

    const summary = await SeasonService.resumePending();

    expect(summary).toEqual(EMPTY_SUMMARY);
    expect(errSpy).toHaveBeenCalledWith('[启动续跑] 合集 pending 扫描失败:', expect.any(Error));
    expect(notify.send).not.toHaveBeenCalled();
  });
});
