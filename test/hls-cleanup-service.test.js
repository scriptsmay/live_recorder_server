jest.mock('../server/db/index', () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));
jest.mock('../server/services/DataService', () => ({
  getSetting: jest.fn(),
}));
jest.mock('../server/lib/utils/path-safety', () => ({
  resolveAndValidate: jest.fn(),
}));
jest.mock('../server/lib/utils/directory-stats', () => ({
  getDirectoryStats: jest.fn(),
}));

const fs = require('fs');
const pool = require('../server/db/index');
const DataService = require('../server/services/DataService');
const { resolveAndValidate } = require('../server/lib/utils/path-safety');
const { getDirectoryStats } = require('../server/lib/utils/directory-stats');
const { HLSCleanupService } = require('../server/services/HLSCleanupService');

function makeClient(overrides = {}) {
  const row = {
    id: 7,
    session_id: 20,
    recording_status: 'completed',
    hls_status: 'ready',
    hls_playlist_path: '/data/video_downloads/20/hls_segment/playlist.m3u8',
    session_status: 'completed',
    managed_file_id: 70,
    managed_file_size: '100',
    ...overrides,
  };
  return {
    query: jest.fn(async (sql) => {
      if (sql.includes('SELECT rf.id')) return { rows: [row] };
      return { rows: [], rowCount: 1 };
    }),
    release: jest.fn(),
  };
}

describe('HLSCleanupService', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new HLSCleanupService();
    resolveAndValidate.mockResolvedValue({ valid: true });
  });

  afterEach(() => {
    service.stop();
    jest.restoreAllMocks();
  });

  test('hls_cleanup_days=0 时不查询候选、不删除', async () => {
    DataService.getSetting.mockResolvedValue('0');

    const result = await service.cleanupExpired();

    expect(result.skipped).toBe(true);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('保留期只查询严格早于 cutoff 的 ready HLS', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });
    jest
      .spyOn(service, 'deleteForRecording')
      .mockResolvedValueOnce({ result: 'success', actual_release_size: 10 })
      .mockResolvedValueOnce({ result: 'success_noop', actual_release_size: 0 });
    const before = Date.now();

    const result = await service.cleanupExpired(10);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("hls_status = 'ready' AND hls_generated_at < $1");
    expect(params[0].getTime()).toBeGreaterThanOrEqual(before - 10 * 24 * 60 * 60 * 1000 - 100);
    expect(result).toMatchObject({ matched: 2, succeeded: 2, failed: 0, released_size: 10 });
    expect(service.deleteForRecording).toHaveBeenNthCalledWith(1, 1, 'retention', 'hls-retention-scheduler');
  });

  test('删除前切换 deleting，成功后落为 expired 并记录真实释放空间', async () => {
    const client = makeClient();
    pool.connect.mockResolvedValue(client);
    getDirectoryStats.mockResolvedValue({ size: 456, mtime: new Date() });
    jest.spyOn(fs.promises, 'rm').mockResolvedValue();

    const result = await service.deleteForRecording(7, 'retention', 'scheduler');

    expect(result).toMatchObject({ result: 'success', hls_status: 'expired', actual_release_size: 456 });
    expect(fs.promises.rm).toHaveBeenCalledWith('/data/video_downloads/20/hls_segment', {
      recursive: true,
      force: true,
    });
    expect(client.query.mock.calls.some((call) => call[0].includes("hls_status = 'deleting'"))).toBe(true);
    expect(client.query.mock.calls.some((call) => call[1]?.[0] === 'expired' && call[1]?.[1] === 7)).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  test('rm 失败时恢复 ready 并保留业务路径', async () => {
    const client = makeClient();
    pool.connect.mockResolvedValue(client);
    getDirectoryStats.mockResolvedValue({ size: 456, mtime: new Date() });
    jest.spyOn(fs.promises, 'rm').mockRejectedValue(Object.assign(new Error('I/O error'), { code: 'EIO' }));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await service.deleteForRecording(7, 'user', 'alice');

    expect(result).toMatchObject({ result: 'failed', error: 'I/O error' });
    expect(client.query.mock.calls.some((call) => call[0].includes("hls_status = 'ready'") && call[1]?.[0] === 7)).toBe(
      true
    );
    expect(client.query.mock.calls.some((call) => call[0].includes('hls_playlist_path = NULL'))).toBe(false);
  });

  test('ENOENT 按幂等成功收敛为 deleted', async () => {
    const client = makeClient();
    pool.connect.mockResolvedValue(client);
    getDirectoryStats.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const rmSpy = jest.spyOn(fs.promises, 'rm');

    const result = await service.deleteForRecording(7, 'user', 'alice');

    expect(result).toMatchObject({ result: 'success_noop', hls_status: 'deleted', actual_release_size: 0 });
    expect(rmSpy).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some((call) => call[1]?.[0] === 'deleted' && call[1]?.[1] === 7)).toBe(true);
  });
});
