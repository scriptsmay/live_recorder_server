// S4：会话终态必达 + 悬挂会话回收 + 自动投稿阻断可见化
jest.mock('../server/db/index', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../server/db/redis', () => ({
  get: jest.fn(),
  set: jest.fn(async () => 'OK'),
  setEx: jest.fn(async () => 'OK'),
  del: jest.fn(async () => 1),
  exists: jest.fn(async () => 0),
  keys: jest.fn(async () => []),
}));
jest.mock('../server/lib/core/RecordingManager', () => ({
  finalizeSession: jest.fn(async () => []),
  addTranscodeQueue: jest.fn(async () => {}),
}));
jest.mock('../server/lib/core/notify', () => ({
  recordingComplete: jest.fn(),
  recordingStart: jest.fn(),
  send: jest.fn(),
}));
jest.mock('../server/lib/core/danmaku/DanmakuRecorder', () => ({
  stopCapture: jest.fn(async () => ({ captureId: null, eventCount: 0 })),
  startCapture: jest.fn(),
}));
jest.mock('../server/lib/core/polling/checkers', () => ({ fetchRoomCoverByUrl: jest.fn() }));
jest.mock('../server/services/DataService', () => ({
  getSetting: jest.fn(),
  getSession: jest.fn(),
  getRoomByUrl: jest.fn(),
  getRecordingFiles: jest.fn(),
}));
jest.mock('../server/services/UploadService', () => ({ scanPendingAutoUpload: jest.fn() }));
jest.mock('../server/lib/core/downloaders/DownloaderFactory', () => ({ getActiveDownloader: jest.fn() }));
jest.mock('../server/lib/core/scan-files', () => ({ scanRecordingFiles: jest.fn() }));
jest.mock('../server/lib/core/TranscodeQueue', () => ({ enqueue: jest.fn() }));
jest.mock('../server/lib/core/hls-generator', () => ({ generateForRecording: jest.fn() }));
jest.mock('../server/services/DanmakuAnalysisService', () => ({ requestAnalysis: jest.fn() }));
jest.mock('../server/lib/core/logger', () => ({
  createModuleLogger: jest.fn(() => ({
    info: jest.fn(),
    important: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

const fs = require('fs');
const pool = require('../server/db/index');
const DataService = require('../server/services/DataService');
const RecorderService = require('../server/services/RecorderService');
const { reapOrphanedRecordingSessions } = require('../server/lib/core/watchdog');
const { getActiveDownloader } = require('../server/lib/core/downloaders/DownloaderFactory');

describe('S4 — 会话终态必达', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readdirSync').mockReturnValue([]);

    DataService.getSetting.mockResolvedValue('10');
    DataService.getSession.mockResolvedValue({
      room_url: 'https://example.com/room',
      started_at: new Date(),
      output_path: '/data/x/seg.flv',
    });
    DataService.getRoomByUrl.mockResolvedValue({
      id: 7,
      room_url: 'https://example.com/room',
      room_name: 'r',
      polling_platform: 'kuaishou',
    });
    DataService.getRecordingFiles.mockResolvedValue({ rows: [] });
    getActiveDownloader.mockReturnValue({ name: 'ffmpeg' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('_handleSessionFinish 抛错时 finishSession 仍把会话收敛为终态', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT status FROM recording_sessions/.test(sql)) return { rows: [{ status: 'recording' }] };
      if (/SELECT output_dir, room_url, started_at/.test(sql)) return { rows: [] };
      // 让初次会话状态 UPDATE 之前的路径正常，但 trigger 一个异常：模拟 settings 查询后的写入失败
      if (/UPDATE recording_sessions/.test(sql) && sql.includes('total_segments')) {
        throw new Error('db down');
      }
      return { rows: [], rowCount: 1 };
    });

    // 强制 _handleSessionFinish 抛错
    const spy = jest.spyOn(RecorderService, '_handleSessionFinish').mockRejectedValueOnce(new Error('boom'));

    await RecorderService.finishSession({ code: 1, signal: null, sessionId: 55, isManualStop: false });

    // finally 兜底：会话被置为 interrupted（非预期退出）
    const terminal = pool.query.mock.calls.find(
      ([sql]) => /UPDATE recording_sessions/.test(sql) && /COALESCE\(ended_at, NOW\(\)\)/.test(sql)
    );
    expect(terminal).toBeDefined();
    expect(terminal[0]).toContain('status = $1');
    expect(terminal[0]).toContain("status = 'recording'");
    expect(terminal[1]).toEqual(['interrupted', 55]);
    spy.mockRestore();
  });

  test('正常结束时兜底不覆盖已写入的 completed', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT status FROM recording_sessions/.test(sql)) return { rows: [{ status: 'recording' }] };
      if (/SELECT output_dir, room_url, started_at/.test(sql)) return { rows: [] };
      return { rows: [], rowCount: sql.includes('COALESCE') ? 0 : 1 };
    });

    await RecorderService.finishSession({ code: 0, signal: null, sessionId: 56 });

    const terminal = pool.query.mock.calls.find(
      ([sql]) => /UPDATE recording_sessions/.test(sql) && /COALESCE\(ended_at, NOW\(\)\)/.test(sql)
    );
    // 兜底语句总会执行，但仅匹配仍为 recording 的行；已 completed 的行不受影响
    expect(terminal[0]).toContain("status = 'recording'");
    expect(terminal[1][0]).toBe('completed');
  });

  test('reapOrphanedRecordingSessions：房间已停止的 recording 会话置 interrupted', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 61 }, { id: 62 }], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 });

    await reapOrphanedRecordingSessions();

    const [sessionSql] = pool.query.mock.calls[0];
    expect(sessionSql).toContain("SET status = 'interrupted'");
    expect(sessionSql).toContain("r.status <> 'recording'");
    expect(sessionSql).toContain('RETURNING rs.id');

    const [fileSql, fileParams] = pool.query.mock.calls[1];
    expect(fileSql).toContain("status = 'interrupted'");
    expect(fileParams[0]).toEqual([61, 62]);
  });

  test('reapOrphanedRecordingSessions：无悬挂行时不更新文件', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await reapOrphanedRecordingSessions();

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
