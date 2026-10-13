/**
 * FR-8 启动回收孤儿 uploading 的单测
 *
 * 覆盖：两张表回写字段、回收计数、通知只发一条、无孤儿不打扰、DB 异常不阻断启动链。
 */

jest.mock('../server/lib/core/polling/checkers', () => ({
  fetchRoomCoverByUrl: jest.fn(),
}));
jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({
  get: jest.fn(),
  set: jest.fn(),
  setEx: jest.fn(),
  del: jest.fn(),
  exists: jest.fn(async () => 0),
  keys: jest.fn(async () => []),
}));
// RecordingManager 单例构造时会启动 setInterval，必须 mock 避免 jest 挂起
jest.mock('../server/lib/core/RecordingManager', () => ({ __mockedSingleton: true }));
jest.mock('../server/lib/core/notify', () => ({ send: jest.fn(async () => {}) }));

const pool = require('../server/db/index');
const notify = require('../server/lib/core/notify');
const RecorderService = require('../server/services/RecorderService');

/**
 * 假数据库：按表名返回被回收的行。upload_records 是 replay_upload_records 的子串，判断顺序不能颠倒。
 * @param {{recording: number[], replay: number[], failure?: Error}} options - 两张表的孤儿 ID
 */
function mockUploadTables({ recording = [], replay = [], failure = null } = {}) {
  pool.query.mockImplementation(async (sql) => {
    if (failure) throw failure;
    if (sql.includes('replay_upload_records')) return { rows: replay.map((id) => ({ id })) };
    if (sql.includes('upload_records')) return { rows: recording.map((id) => ({ id })) };
    throw new Error(`未预期的 SQL: ${sql}`);
  });
}

function callsFor(marker) {
  return pool.query.mock.calls.filter(([sql]) => sql.includes(marker));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('cleanupStaleUploads', () => {
  test('两张表的 uploading 都被回收为 failed，字段齐全', async () => {
    mockUploadTables({ recording: [11], replay: [485, 486] });

    const recovered = await RecorderService.cleanupStaleUploads();

    expect(recovered).toEqual({ upload_records: [11], replay_upload_records: [485, 486] });
    for (const [sql, params] of callsFor("SET status = 'failed'")) {
      expect(sql).toContain('error_message = $1');
      expect(sql).toContain('completed_at = NOW()');
      expect(sql).toContain("WHERE status = 'uploading'");
      expect(params).toEqual(['服务重启前上传中断（孤儿回收）']);
    }
    expect(callsFor('upload_records')).toHaveLength(2);
    expect(callsFor('replay_upload_records')).toHaveLength(1);
  });

  test('无孤儿时不发通知，只返回空计数', async () => {
    mockUploadTables();

    const recovered = await RecorderService.cleanupStaleUploads();

    expect(recovered).toEqual({ upload_records: [], replay_upload_records: [] });
    expect(notify.send).not.toHaveBeenCalled();
  });

  test('两张表同时有孤儿时也只发一条通知，内容含表名与 ID', async () => {
    mockUploadTables({ recording: [11], replay: [485] });

    await RecorderService.cleanupStaleUploads();

    expect(notify.send).toHaveBeenCalledTimes(1);
    const [eventType, title, content] = notify.send.mock.calls[0];
    expect(eventType).toBe('upload_orphan_recovered');
    expect(title).toContain('2 条投稿任务被中断');
    expect(content).toContain('常规投稿 1 条（ID: 11）');
    expect(content).toContain('回放投稿 1 条（ID: 485）');
  });

  test('只有常规表有孤儿时通知不提及回放 ID', async () => {
    mockUploadTables({ recording: [11] });

    await RecorderService.cleanupStaleUploads();

    const [, , content] = notify.send.mock.calls[0];
    expect(content).toContain('回放投稿 0 条');
    expect(content).not.toContain('ID: 485');
  });

  test('数据库异常只记日志，不阻断启动链', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUploadTables({ failure: new Error('connection reset') });

    const recovered = await RecorderService.cleanupStaleUploads();

    expect(recovered).toEqual({ upload_records: [], replay_upload_records: [] });
    expect(errSpy).toHaveBeenCalledWith('[启动清理] 投稿孤儿回收失败:', expect.any(Error));
    expect(notify.send).not.toHaveBeenCalled();
  });

  test('回收后仍走原有状态查询：不触碰 success / failed 行', async () => {
    mockUploadTables({ recording: [11] });

    await RecorderService.cleanupStaleUploads();

    const [sql] = callsFor('upload_records')[0];
    expect(sql).toContain("WHERE status = 'uploading'");
    expect(sql).not.toContain("'success'");
  });
});
