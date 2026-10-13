/**
 * 启动回收孤儿 season pending 的单测
 *
 * 覆盖：pending → failed 回写字段、回收计数、通知只发一条、无孤儿不打扰、DB 异常不阻断启动链、
 * 以及「只碰 season_* 与 pending 行」两条边界。
 */

jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({ get: jest.fn(), setEx: jest.fn(), del: jest.fn() }));
jest.mock('../server/lib/core/notify', () => ({ send: jest.fn(async () => {}) }));
jest.mock('../server/lib/utils/biliup-cookie', () => ({ loadBiliupCookie: jest.fn() }));
jest.mock('../server/lib/core/bilibili-season', () => ({
  ERROR_CODES: {},
  SeasonError: class SeasonError extends Error {},
  getVideoInfo: jest.fn(),
  getSeasonSection: jest.fn(),
  addToSeason: jest.fn(),
  listSeasons: jest.fn(),
}));

const pool = require('../server/db/index');
const notify = require('../server/lib/core/notify');
const SeasonService = require('../server/services/SeasonService');

const ORPHAN_NOTE = '服务重启前合集任务被中断（孤儿回收），可手动重试';

/**
 * @param {{recording?: number[], replay?: number[], failure?: Error}} options - 两张表各自被回收的 ID，或抛出的 DB 异常
 */
function mockSeasonSweep({ recording = [], replay = [], failure = null } = {}) {
  pool.query.mockImplementation(async (sql) => {
    if (failure) throw failure;
    const ids = String(sql).includes('replay_upload_records') ? replay : recording;
    return { rows: ids.map((id) => ({ id })) };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('cleanupStalePending', () => {
  test('pending 回收为 failed，字段与文案齐全', async () => {
    mockSeasonSweep({ recording: [101, 102] });

    const recovered = await SeasonService.cleanupStalePending();

    expect(recovered).toEqual([101, 102]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("SET season_status = 'failed'");
    expect(sql).toContain('season_error = $1');
    expect(sql).toContain("WHERE season_status = 'pending'");
    expect(params).toEqual([ORPHAN_NOTE]);
  });

  test('两张投稿表都扫，回收结果按表标注不会指错稿件', async () => {
    mockSeasonSweep({ recording: [101], replay: [101] });

    const recovered = await SeasonService.cleanupStalePending();

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining('UPDATE upload_records'),
      expect.stringContaining('UPDATE replay_upload_records'),
    ]);
    // 跨表同号是两条不同稿件，合并计数与标注都要如实反映
    expect(recovered).toEqual([101, 101]);
    const [, title, content] = notify.send.mock.calls[0];
    expect(title).toContain('2 条加入合集任务被中断');
    expect(content).toContain('常规投稿（ID: 101）');
    expect(content).toContain('回放投稿（ID: 101）');
  });

  test('只回收 pending，不碰 added / failed，也不改投稿主状态', async () => {
    mockSeasonSweep();

    await SeasonService.cleanupStalePending();

    for (const [sql] of pool.query.mock.calls) {
      expect(sql).not.toContain("'added'");
      expect(sql).not.toContain("'none'");
      expect(sql).not.toMatch(/\bstatus\s*=/);
    }
  });

  test('无孤儿时不发通知，返回空数组', async () => {
    mockSeasonSweep();

    const recovered = await SeasonService.cleanupStalePending();

    expect(recovered).toEqual([]);
    expect(notify.send).not.toHaveBeenCalled();
  });

  test('有孤儿时只发一条通知，内容含 ID 与手动重试指引', async () => {
    mockSeasonSweep({ recording: [101, 102] });

    await SeasonService.cleanupStalePending();

    expect(notify.send).toHaveBeenCalledTimes(1);
    const [eventType, title, content] = notify.send.mock.calls[0];
    expect(eventType).toBe('season_orphan_recovered');
    expect(title).toContain('2 条加入合集任务被中断');
    expect(content).toContain('常规投稿（ID: 101, 102）');
    expect(content).toContain('手动重试');
  });

  test('数据库异常只记日志，不阻断启动链', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSeasonSweep({ failure: new Error('connection reset') });

    const recovered = await SeasonService.cleanupStalePending();

    expect(recovered).toEqual([]);
    expect(errSpy).toHaveBeenCalledWith('[启动清理] 合集孤儿回收失败:', expect.any(Error));
    expect(notify.send).not.toHaveBeenCalled();
  });
});
