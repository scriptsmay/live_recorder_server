// I-R3：reaper 与 finishSession 交错——会话终态、文件状态、转码入队三者必须一致。
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
}));
jest.mock('../server/lib/core/notify', () => ({
  recordingComplete: jest.fn(),
  recordingStart: jest.fn(),
  send: jest.fn(),
}));
jest.mock('../server/lib/core/danmaku/DanmakuRecorder', () => ({
  startCapture: jest.fn(),
  stopCapture: jest.fn(async () => ({ captureId: null, eventCount: 0 })),
  getSession: jest.fn(),
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

const DIR = '/data/video_downloads/91';
const MB20 = 20 * 1024 * 1024;

describe('I-R3 — reaper 与 finishSession 交错', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readdirSync').mockReturnValue(['seg1.flv', 'seg2.flv']);
    jest.spyOn(fs, 'statSync').mockReturnValue({ size: MB20, isFile: () => true });
    jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    DataService.getSetting.mockResolvedValue('10');
    DataService.getSession.mockResolvedValue({
      room_url: 'https://example.com/room',
      started_at: new Date(),
      output_path: `${DIR}/seg1.flv`,
    });
    DataService.getRoomByUrl.mockResolvedValue({
      id: 7,
      room_url: 'https://example.com/room',
      room_name: 'r',
      polling_platform: 'kuaishou',
    });
    DataService.getRecordingFiles.mockResolvedValue({
      rows: [{ file_path: `${DIR}/seg1.flv`, segment_index: 0 }],
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('状态读取时仍为 recording，但写入窗口内被 reaper 置 interrupted：文件回退 interrupted 且不入队', async () => {
    // 第一次 SELECT status 返回 recording（close 认为自己是写者）；
    // 随后 reaper 在窗口内先写入 interrupted，导致 close 的条件 UPDATE 落空。
    let statusSelects = 0;
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT status FROM recording_sessions/.test(sql)) {
        statusSelects++;
        if (statusSelects === 1) return { rows: [{ status: 'recording' }], rowCount: 1 };
        return { rows: [{ status: 'interrupted' }], rowCount: 1 };
      }
      if (/SELECT output_dir, room_url, started_at/.test(sql)) {
        return { rows: [{ output_dir: DIR, room_url: 'https://example.com/room', started_at: new Date() }] };
      }
      if (/INSERT INTO recording_files/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
      if (/UPDATE recording_sessions/.test(sql) && /status = 'recording'/.test(sql)) {
        return { rows: [], rowCount: 0 }; // reaper 已抢先
      }
      return { rows: [], rowCount: 1 };
    });

    await RecorderService._handleSessionFinish({
      sessionId: 91,
      code: 0,
      signal: null,
      isManualStop: false,
      unexpectedExit: false,
    });

    // 文件先按 completed 写过，随后被对齐回 interrupted
    const align = pool.query.mock.calls.find(
      ([sql]) => /UPDATE recording_files/.test(sql) && /WHERE session_id = \$2 AND file_path = ANY/.test(sql)
    );
    expect(align).toBeDefined();
    expect(align[1][0]).toBe('interrupted');
    expect(align[1][2]).toEqual([`${DIR}/seg1.flv`, `${DIR}/seg2.flv`]);

    // 会话实际状态为 interrupted，绝不能入队转码
    expect(RecordingManager.addTranscodeQueue).not.toHaveBeenCalled();
  });

  test('写入成功（本次赢得终态）：文件保持 completed 并在落库后入队', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT status FROM recording_sessions/.test(sql)) return { rows: [{ status: 'recording' }], rowCount: 1 };
      if (/SELECT output_dir, room_url, started_at/.test(sql)) {
        return { rows: [{ output_dir: DIR, room_url: 'https://example.com/room', started_at: new Date() }] };
      }
      if (/INSERT INTO recording_files/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
      if (/UPDATE recording_sessions/.test(sql) && /status = 'recording'/.test(sql)) {
        return { rows: [{ status: 'completed' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await RecorderService._handleSessionFinish({
      sessionId: 91,
      code: 0,
      signal: null,
      isManualStop: false,
      unexpectedExit: false,
    });

    // 两个文件都入队
    expect(RecordingManager.addTranscodeQueue).toHaveBeenCalledWith(91, `${DIR}/seg1.flv`);
    expect(RecordingManager.addTranscodeQueue).toHaveBeenCalledWith(91, `${DIR}/seg2.flv`);
    // 没有触发回退对齐
    expect(
      pool.query.mock.calls.some(([sql]) => /UPDATE recording_files/.test(sql) && /file_path = ANY/.test(sql))
    ).toBe(false);
  });

  test('写入失败且实际状态为 completed（另一路径完成）：不重复入队', async () => {
    let statusSelects = 0;
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT status FROM recording_sessions/.test(sql)) {
        statusSelects++;
        if (statusSelects === 1) return { rows: [{ status: 'recording' }], rowCount: 1 };
        return { rows: [{ status: 'completed' }], rowCount: 1 };
      }
      if (/SELECT output_dir, room_url, started_at/.test(sql)) {
        return { rows: [{ output_dir: DIR, room_url: 'https://example.com/room', started_at: new Date() }] };
      }
      if (/INSERT INTO recording_files/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
      if (/UPDATE recording_sessions/.test(sql) && /status = 'recording'/.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });

    await RecorderService._handleSessionFinish({
      sessionId: 91,
      code: 0,
      signal: null,
      isManualStop: false,
      unexpectedExit: false,
    });

    // 文件保持 completed（不触发 interrupted 对齐），本次不入队，避免与对方路径重复
    expect(
      pool.query.mock.calls.some(([sql]) => /UPDATE recording_files/.test(sql) && /file_path = ANY/.test(sql))
    ).toBe(false);
    expect(RecordingManager.addTranscodeQueue).not.toHaveBeenCalled();
  });
});
