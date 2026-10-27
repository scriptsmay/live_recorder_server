// finishSession / _handleSessionFinish 增量补录与退出判定测试
// 文件系统与数据库全部 mock，避免真实 IO 与单例定时器。
jest.mock('../server/db/index', () => ({ query: jest.fn() }));
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
  createSession: jest.fn(),
  registerSession: jest.fn(),
  startRecordingProcess: jest.fn(),
  heartbeat: jest.fn(),
  updateSessionPidToDatabase: jest.fn(),
  updateSessionOutputPath: jest.fn(),
  updateSessionCover: jest.fn(),
}));
jest.mock('../server/lib/core/notify', () => ({
  recordingComplete: jest.fn(),
  recordingStart: jest.fn(),
  send: jest.fn(),
}));
jest.mock('../server/lib/core/danmaku/DanmakuRecorder', () => ({
  startCapture: jest.fn(),
  stopCapture: jest.fn(async () => ({ captureId: null, eventCount: 0 })),
}));
jest.mock('../server/lib/core/polling/checkers', () => ({ fetchRoomCoverByUrl: jest.fn() }));
jest.mock('../server/services/DataService', () => ({
  getSetting: jest.fn(),
  getSession: jest.fn(),
  getRoomByUrl: jest.fn(),
  getRecordingFiles: jest.fn(),
}));

const fs = require('fs');
const pool = require('../server/db/index');
const DataService = require('../server/services/DataService');
const RecordingManager = require('../server/lib/core/RecordingManager');
const RecorderService = require('../server/services/RecorderService');

const DIR = '/data/video_downloads/42';
const MB20 = 20 * 1024 * 1024;
const STARTED_AT = new Date('2026-01-01T00:00:00Z');

describe('RecorderService._handleSessionFinish — 增量补录与状态', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'statSync').mockImplementation((p) => ({
      size: MB20,
      // hls_ 前缀目录不是文件，应被补录逻辑跳过
      isFile: () => !String(p).includes('hls_'),
    }));
    jest.spyOn(fs, 'readdirSync').mockReturnValue(['seg1.ts', 'seg2.ts', 'cover.jpg', 'hls_seg1.ts', '.segments_0']);
    jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    DataService.getSetting.mockResolvedValue('10');
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT output_dir, room_url, started_at/.test(sql)) {
        return { rows: [{ output_dir: DIR, room_url: 'https://example.com/room', started_at: STARTED_AT }] };
      }
      if (/INSERT INTO recording_files/.test(sql)) {
        return { rows: [{ id: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const insertedPaths = () =>
    pool.query.mock.calls.filter(([sql]) => /INSERT INTO recording_files/.test(sql)).map(([, params]) => params[2]);

  test('已登记文件不重复插入，新文件被增量补录并计数', async () => {
    DataService.getRecordingFiles.mockResolvedValue({
      rows: [{ file_path: `${DIR}/seg1.ts`, segment_index: 0 }],
    });

    const result = await RecorderService._handleSessionFinish({
      sessionId: 42,
      code: 0,
      signal: null,
      isManualStop: false,
    });

    expect(insertedPaths()).toEqual([`${DIR}/seg2.ts`]);
    // seg1（既有）+ seg2（新增）；cover.jpg / hls_* / .segments_* 不参与
    expect(result.fileCount).toBe(2);
    expect(result.fileSize).toBe(MB20 * 2);
    // 正常退出：既有与新增文件均入转码队列
    expect(RecordingManager.addTranscodeQueue).toHaveBeenCalledTimes(2);
    expect(RecordingManager.addTranscodeQueue).toHaveBeenCalledWith(42, `${DIR}/seg1.ts`);
    expect(RecordingManager.addTranscodeQueue).toHaveBeenCalledWith(42, `${DIR}/seg2.ts`);
    // 新补录行状态为 completed
    const insertParams = pool.query.mock.calls.find(([sql]) => /INSERT INTO recording_files/.test(sql))[1];
    expect(insertParams[5]).toBe('completed');
  });

  test('非预期退出：文件写 interrupted 且跳过即时转码，会话标 interrupted', async () => {
    DataService.getRecordingFiles.mockResolvedValue({
      rows: [{ file_path: `${DIR}/seg1.ts`, segment_index: 0 }],
    });

    await RecorderService._handleSessionFinish({
      sessionId: 42,
      code: 1,
      signal: null,
      isManualStop: false,
    });

    const fileUpdates = pool.query.mock.calls.filter(([sql]) => /UPDATE recording_files/.test(sql));
    expect(fileUpdates.length).toBeGreaterThan(0);
    for (const [, params] of fileUpdates) {
      expect(params[1]).toBe('interrupted');
    }
    const insertParams = pool.query.mock.calls.find(([sql]) => /INSERT INTO recording_files/.test(sql))[1];
    expect(insertParams[5]).toBe('interrupted');
    expect(RecordingManager.addTranscodeQueue).not.toHaveBeenCalled();

    const sessionUpdate = pool.query.mock.calls.find(([sql]) => /UPDATE recording_sessions/.test(sql));
    expect(sessionUpdate[1][0]).toBe('interrupted');
    expect(sessionUpdate[1][1]).toBe(2); // fileCount 计入既有 + 新增
  });

  test('人工停止（超时兜底 SIGKILL）：completed 路径，文件入转码队列', async () => {
    DataService.getRecordingFiles.mockResolvedValue({
      rows: [{ file_path: `${DIR}/seg1.ts`, segment_index: 0 }],
    });

    await RecorderService._handleSessionFinish({
      sessionId: 42,
      code: null,
      signal: 'SIGKILL',
      isManualStop: true,
    });

    const sessionUpdate = pool.query.mock.calls.find(([sql]) => /UPDATE recording_sessions/.test(sql));
    expect(sessionUpdate[1][0]).toBe('completed');
    expect(RecordingManager.addTranscodeQueue).toHaveBeenCalledWith(42, `${DIR}/seg1.ts`);
    expect(RecordingManager.addTranscodeQueue).toHaveBeenCalledWith(42, `${DIR}/seg2.ts`);
  });

  test('ON CONFLICT 命中的补录不重复计数、不入队', async () => {
    DataService.getRecordingFiles.mockResolvedValue({ rows: [] });
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT output_dir, room_url, started_at/.test(sql)) {
        return { rows: [{ output_dir: DIR, room_url: 'https://example.com/room', started_at: STARTED_AT }] };
      }
      if (/INSERT INTO recording_files/.test(sql)) {
        return { rows: [], rowCount: 0 }; // 并发路径已登记
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await RecorderService._handleSessionFinish({
      sessionId: 42,
      code: 0,
      signal: null,
      isManualStop: false,
    });

    expect(result.fileCount).toBe(0);
    expect(RecordingManager.addTranscodeQueue).not.toHaveBeenCalled();
  });

  test('低于阈值的新文件不补录', async () => {
    DataService.getRecordingFiles.mockResolvedValue({ rows: [] });
    fs.statSync.mockReturnValue({ size: 1024, isFile: () => true });

    const result = await RecorderService._handleSessionFinish({
      sessionId: 42,
      code: 0,
      signal: null,
      isManualStop: false,
    });

    expect(insertedPaths()).toEqual([]);
    expect(result.fileCount).toBe(0);
  });
});

describe('RecorderService.finishSession — code/signal/isManualStop 贯穿', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readdirSync').mockReturnValue([]);
    jest.spyOn(fs, 'statSync').mockReturnValue({ size: MB20, isFile: () => true });

    DataService.getSetting.mockResolvedValue('10');
    DataService.getSession.mockResolvedValue({
      room_url: 'https://example.com/room',
      started_at: STARTED_AT,
      output_path: `${DIR}/seg.ts`,
    });
    DataService.getRoomByUrl.mockResolvedValue({
      id: 7,
      room_url: 'https://example.com/room',
      room_name: 'test',
      polling_platform: 'kuaishou',
    });
    DataService.getRecordingFiles.mockResolvedValue({ rows: [] });
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('外部 SIGKILL 且非人工停止：会话 interrupted', async () => {
    await RecorderService.finishSession({ code: null, signal: 'SIGKILL', sessionId: 42, isManualStop: false });

    const sessionUpdate = pool.query.mock.calls.find(([sql]) => /UPDATE recording_sessions/.test(sql));
    expect(sessionUpdate[1][0]).toBe('interrupted');
  });

  test('人工停止标记下 SIGKILL 兜底：会话 completed', async () => {
    await RecorderService.finishSession({ code: null, signal: 'SIGKILL', sessionId: 42, isManualStop: true });

    const sessionUpdate = pool.query.mock.calls.find(([sql]) => /UPDATE recording_sessions/.test(sql));
    expect(sessionUpdate[1][0]).toBe('completed');
  });

  test('正常退出 code=0 signal=null：会话 completed', async () => {
    await RecorderService.finishSession({ code: 0, signal: null, sessionId: 42 });

    const sessionUpdate = pool.query.mock.calls.find(([sql]) => /UPDATE recording_sessions/.test(sql));
    expect(sessionUpdate[1][0]).toBe('completed');
  });
});
