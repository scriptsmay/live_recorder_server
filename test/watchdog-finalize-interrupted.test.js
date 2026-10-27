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

function makeClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: jest.fn() };
}

describe('watchdog.finalizeInterruptedSessions — 会话与文件同事务完成', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('超时会话与其 interrupted 文件在同一事务中原子更新为 completed', async () => {
    DataService.getSetting.mockResolvedValue('60');
    const client = makeClient();
    pool.connect.mockResolvedValue(client);
    pool.query.mockResolvedValue({
      rows: [
        { id: 1, room_url: 'r1', ended_at: new Date(Date.now() - 120000) },
        { id: 2, room_url: 'r2', ended_at: new Date(Date.now() - 90000) },
      ],
      rowCount: 2,
    });

    await finalizeInterruptedSessions();

    // 事务边界
    expect(client.query.mock.calls[0][0]).toBe('BEGIN');
    expect(client.query.mock.calls[client.query.mock.calls.length - 1][0]).toBe('COMMIT');

    // 会话更新在事务内，且只改仍为 interrupted 的行
    const sessionUpdate = client.query.mock.calls.find(([sql]) => /UPDATE recording_sessions/.test(sql));
    expect(sessionUpdate).toBeDefined();
    expect(sessionUpdate[0]).toContain("status = 'completed'");
    expect(sessionUpdate[0]).toContain("status = 'interrupted'");
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

  test('未到 delay 的会话不更新，也不开启事务', async () => {
    DataService.getSetting.mockResolvedValue('60');
    pool.query.mockResolvedValue({
      rows: [{ id: 3, room_url: 'r3', ended_at: new Date(Date.now() - 10000) }],
      rowCount: 1,
    });

    await finalizeInterruptedSessions();

    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('事务失败时 ROLLBACK 并释放连接', async () => {
    DataService.getSetting.mockResolvedValue('60');
    const client = makeClient();
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockRejectedValueOnce(new Error('boom')); // session UPDATE
    pool.connect.mockResolvedValue(client);
    pool.query.mockResolvedValue({
      rows: [{ id: 4, room_url: 'r4', ended_at: new Date(Date.now() - 120000) }],
      rowCount: 1,
    });

    await finalizeInterruptedSessions();

    const calls = client.query.mock.calls.map(([sql]) => sql);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
});
