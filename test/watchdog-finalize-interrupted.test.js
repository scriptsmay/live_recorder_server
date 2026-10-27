jest.mock('../server/db/index', () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));
jest.mock('../server/services/DataService', () => ({ getSetting: jest.fn() }));
jest.mock('../server/services/UploadService', () => ({ scanPendingAutoUpload: jest.fn() }));
jest.mock('../server/lib/core/downloaders/DownloaderFactory', () => ({ getActiveDownloader: jest.fn() }));
jest.mock('../server/lib/core/scan-files', () => ({ scanRecordingFiles: jest.fn() }));
jest.mock('../server/lib/core/TranscodeQueue', () => ({ enqueue: jest.fn() }));
jest.mock('../server/lib/core/hls-generator', () => ({ generateForRecording: jest.fn() }));
jest.mock('../server/lib/core/logger', () => ({
  createModuleLogger: jest.fn(() => ({
    info: jest.fn(),
    important: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

const pool = require('../server/db/index');
const DataService = require('../server/services/DataService');
const { finalizeInterruptedSessions } = require('../server/lib/core/watchdog');

function makeClient(sessionReturning = []) {
  return {
    query: jest.fn(async (sql) => {
      if (/UPDATE recording_sessions/.test(sql)) {
        return { rows: sessionReturning.map((id) => ({ id })), rowCount: sessionReturning.length };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
}

describe('watchdog.finalizeInterruptedSessions — 会话与文件同事务完成', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('超时判定在 SQL 侧完成（INTERVAL 模式），不对 ended_at 做 JS Date 运算', async () => {
    DataService.getSetting.mockResolvedValue('60');
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await finalizeInterruptedSessions();

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("status = 'interrupted'");
    expect(sql).toContain('ended_at IS NOT NULL');
    // 数据库时钟比较：ended_at < NOW() - INTERVAL '1 second' * $1
    expect(sql).toMatch(/ended_at\s*<\s*NOW\(\)\s*-\s*INTERVAL\s*'1 second'\s*\*\s*\$1/);
    expect(params).toEqual([60]);
    // 查询结果只用于取 id，不参与时间比较
    expect(sql).not.toContain('elapsed_seconds <');
  });

  test('超时会话与其 interrupted 文件在同一事务中原子更新为 completed', async () => {
    DataService.getSetting.mockResolvedValue('60');
    const client = makeClient([1, 2]);
    pool.connect.mockResolvedValue(client);
    pool.query.mockResolvedValue({
      rows: [
        { id: 1, room_url: 'r1', elapsed_seconds: 120 },
        { id: 2, room_url: 'r2', elapsed_seconds: 90 },
      ],
      rowCount: 2,
    });

    await finalizeInterruptedSessions();

    // 事务边界
    expect(client.query.mock.calls[0][0]).toBe('BEGIN');
    expect(client.query.mock.calls[client.query.mock.calls.length - 1][0]).toBe('COMMIT');

    // 会话更新在事务内，且只改仍为 interrupted 的行，并 RETURNING id
    const sessionUpdate = client.query.mock.calls.find(([sql]) => /UPDATE recording_sessions/.test(sql));
    expect(sessionUpdate).toBeDefined();
    expect(sessionUpdate[0]).toContain("status = 'completed'");
    expect(sessionUpdate[0]).toContain("status = 'interrupted'");
    expect(sessionUpdate[0]).toContain('RETURNING id');
    expect(sessionUpdate[1][0]).toEqual([1, 2]);

    // 文件更新在同一事务内，且限定 interrupted
    const fileUpdate = client.query.mock.calls.find(([sql]) => /UPDATE recording_files/.test(sql));
    expect(fileUpdate).toBeDefined();
    expect(fileUpdate[0]).toContain("status = 'completed'");
    expect(fileUpdate[0]).toContain("status = 'interrupted'");
    expect(fileUpdate[0]).toContain('deleted_at IS NULL');
    expect(fileUpdate[1][0]).toEqual([1, 2]);

    expect(client.release).toHaveBeenCalled();
  });

  test('并发续播（会话已被改回 recording）：只更新 RETURNING 返回的 id，其文件不得被更新', async () => {
    DataService.getSetting.mockResolvedValue('60');
    // SELECT 命中 1、2；事务中 id=2 已变回 recording，UPDATE ... RETURNING 只返回 1
    const client = makeClient([1]);
    pool.connect.mockResolvedValue(client);
    pool.query.mockResolvedValue({
      rows: [
        { id: 1, room_url: 'r1', elapsed_seconds: 120 },
        { id: 2, room_url: 'r2', elapsed_seconds: 90 },
      ],
      rowCount: 2,
    });

    await finalizeInterruptedSessions();

    const fileUpdate = client.query.mock.calls.find(([sql]) => /UPDATE recording_files/.test(sql));
    expect(fileUpdate).toBeDefined();
    expect(fileUpdate[1][0]).toEqual([1]);
    expect(fileUpdate[1][0]).not.toContain(2);
  });

  test('所有候选会话都已续播：不执行文件更新', async () => {
    DataService.getSetting.mockResolvedValue('60');
    const client = makeClient([]); // UPDATE ... RETURNING 无行
    pool.connect.mockResolvedValue(client);
    pool.query.mockResolvedValue({
      rows: [{ id: 5, room_url: 'r5', elapsed_seconds: 120 }],
      rowCount: 1,
    });

    await finalizeInterruptedSessions();

    const fileUpdate = client.query.mock.calls.find(([sql]) => /UPDATE recording_files/.test(sql));
    expect(fileUpdate).toBeUndefined();
    const calls = client.query.mock.calls.map(([sql]) => sql);
    expect(calls).toContain('COMMIT');
  });

  test('未到 delay 的会话不更新，也不开启事务', async () => {
    DataService.getSetting.mockResolvedValue('60');
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await finalizeInterruptedSessions();

    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('事务失败时 ROLLBACK 并释放连接', async () => {
    DataService.getSetting.mockResolvedValue('60');
    const client = { query: jest.fn(), release: jest.fn() };
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockRejectedValueOnce(new Error('boom')); // session UPDATE
    pool.connect.mockResolvedValue(client);
    pool.query.mockResolvedValue({
      rows: [{ id: 4, room_url: 'r4', elapsed_seconds: 120 }],
      rowCount: 1,
    });

    await finalizeInterruptedSessions();

    const calls = client.query.mock.calls.map(([sql]) => sql);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
});
