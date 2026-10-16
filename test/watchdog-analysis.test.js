jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/services/DataService', () => ({ getSetting: jest.fn() }));
jest.mock('../server/services/DanmakuAnalysisService', () => ({ requestAnalysis: jest.fn() }));

const pool = require('../server/db/index');
const DataService = require('../server/services/DataService');
const analysisService = require('../server/services/DanmakuAnalysisService');
const { checkSessionAnalysis } = require('../server/lib/core/watchdog');

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('watchdog 弹幕分析扫描', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('总开关或自动开关任一关闭：不查询、不入队', async () => {
    DataService.getSetting.mockResolvedValueOnce('true').mockResolvedValueOnce('false');

    await checkSessionAnalysis();

    expect(pool.query).not.toHaveBeenCalled();
    expect(analysisService.requestAnalysis).not.toHaveBeenCalled();
  });

  test('两开关齐开：按 NOT EXISTS + 快手过滤查询，逐场入队且不 await 分析', async () => {
    DataService.getSetting.mockResolvedValue('true');
    pool.query.mockResolvedValue({
      rows: [
        { id: 11, room_url: 'https://kuaishou.com/1' },
        { id: 12, room_url: 'https://kuaishou.com/2' },
      ],
    });
    analysisService.requestAnalysis.mockResolvedValue({ accepted: true, state: 'running' });

    await checkSessionAnalysis();
    await flush();

    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('FROM danmaku_analysis_records dar');
    expect(sql).toContain('dar.deleted_at IS NULL');
    expect(sql).toContain("r.polling_platform = 'kuaishou'");
    expect(sql).toContain("dcr.platform = 'kuaishou'");
    expect(sql).toContain("INTERVAL '7 days'");
    expect(sql).toContain('LIMIT 5');
    expect(analysisService.requestAnalysis.mock.calls.map((c) => c[0])).toEqual([11, 12]);
  });

  test('入队异常被吞掉，不影响看门狗其余任务', async () => {
    DataService.getSetting.mockResolvedValue('true');
    pool.query.mockResolvedValue({ rows: [{ id: 13, room_url: 'u' }] });
    analysisService.requestAnalysis.mockRejectedValue(new Error('boom'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await checkSessionAnalysis();
    await flush();

    expect(errSpy).toHaveBeenCalled();
  });

  test('查询失败仅记日志，不抛出', async () => {
    DataService.getSetting.mockResolvedValue('true');
    pool.query.mockRejectedValue(new Error('db down'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(checkSessionAnalysis()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });
});
