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
const RecordingManager = require('../server/lib/core/RecordingManager');
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
    // C-R1：paused 房间的会话仍在录制（FFmpeg 只是 SIGSTOP），不得当作孤儿回收
    expect(sessionSql).toContain("r.status NOT IN ('recording', 'paused')");
    expect(sessionSql).not.toContain("r.status <> 'recording'");
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

  test('C-R1：paused 房间连续多个 tick 均不产生会话/文件写入', async () => {
    // paused 房间在 reaper 谓词中不匹配 → 真实数据库返回空集。连续 3 个 tick
    // 都不得出现任何 recording_sessions / recording_files 写语句。
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    for (let tick = 0; tick < 3; tick++) {
      await reapOrphanedRecordingSessions();
    }

    const sqls = pool.query.mock.calls.map(([sql]) => sql);
    expect(sqls.every((sql) => /UPDATE recording_sessions rs/.test(sql))).toBe(true);
    // 只发出被谓词保护的 UPDATE，paused 不在匹配集合内
    for (const sql of sqls) {
      expect(sql).toContain("r.status NOT IN ('recording', 'paused')");
    }
    expect(sqls.some((sql) => /UPDATE recording_files/.test(sql))).toBe(false);
  });

  test('I-R5：_handleSessionFinish 在文件循环前抛错时，终态兜底同步收敛遗留文件并入队转码', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT status FROM recording_sessions/.test(sql)) return { rows: [{ status: 'recording' }], rowCount: 1 };
      if (/SELECT output_dir, room_url, started_at/.test(sql)) return { rows: [] };
      if (/UPDATE recording_sessions/.test(sql) && /COALESCE\(ended_at, NOW\(\)\)/.test(sql)) {
        return { rows: [{ id: 77 }], rowCount: 1 };
      }
      if (/UPDATE recording_files/.test(sql) && /status = \$1/.test(sql) && /status = 'recording'/.test(sql)) {
        return { rows: [], rowCount: 2 };
      }
      if (/FROM recording_files rf/.test(sql) && /NOT EXISTS/.test(sql)) {
        return { rows: [{ file_path: '/data/x/a.flv' }, { file_path: '/data/x/b.flv' }], rowCount: 2 };
      }
      return { rows: [], rowCount: 1 };
    });

    // 模拟文件循环尚未执行就抛错（例如查询 settings 后 DB 抖动）
    const spy = jest.spyOn(RecorderService, '_handleSessionFinish').mockRejectedValueOnce(new Error('boom'));

    await RecorderService.finishSession({ code: 0, signal: null, sessionId: 77 });

    const fileUpdate = pool.query.mock.calls.find(
      ([sql]) => /UPDATE recording_files/.test(sql) && /status = \$1/.test(sql) && /status = 'recording'/.test(sql)
    );
    expect(fileUpdate).toBeDefined();
    expect(fileUpdate[1][0]).toBe('completed');
    // 遗留文件进入转码可处理状态：正常路径应即时入队
    expect(RecordingManager.addTranscodeQueue).toHaveBeenCalledWith(77, '/data/x/a.flv');
    expect(RecordingManager.addTranscodeQueue).toHaveBeenCalledWith(77, '/data/x/b.flv');
    spy.mockRestore();
  });

  test('I-R4：房间在录制期间被删除，finishSession 仍收敛会话且不产生未处理 rejection', async () => {
    DataService.getRoomByUrl.mockResolvedValue(null);
    DataService.getRecordingFiles.mockResolvedValue({ rows: [] });
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT status FROM recording_sessions/.test(sql)) return { rows: [{ status: 'recording' }], rowCount: 1 };
      if (/SELECT output_dir, room_url, started_at/.test(sql)) return { rows: [] };
      return { rows: [], rowCount: 1 };
    });

    const rejections = [];
    const onRejection = (err) => rejections.push(err);
    process.on('unhandledRejection', onRejection);
    try {
      await expect(
        RecorderService.finishSession({ code: 0, signal: null, sessionId: 78, isManualStop: false })
      ).resolves.toBeUndefined();
      await new Promise((r) => setImmediate(r));

      expect(rejections).toEqual([]);
      const sessionUpdate = pool.query.mock.calls.find(
        ([sql]) => /UPDATE recording_sessions/.test(sql) && /status = \$1/.test(sql)
      );
      expect(sessionUpdate[1][0]).toBe('completed');
      // 房间已不存在时不写 rooms 行
      expect(pool.query.mock.calls.some(([sql]) => /UPDATE rooms SET status = 'idle'/.test(sql))).toBe(false);
    } finally {
      process.removeListener('unhandledRejection', onRejection);
    }
  });
});
