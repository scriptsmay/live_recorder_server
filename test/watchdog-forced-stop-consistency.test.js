// S2：看门狗强制停止后，close 回调是唯一写者——会话 interrupted 时不得入队转码、
// 文件不得被标 completed。
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
}));
jest.mock('../server/lib/core/polling/checkers', () => ({ fetchRoomCoverByUrl: jest.fn() }));
jest.mock('../server/services/DataService', () => ({
  getSetting: jest.fn(),
  getSession: jest.fn(),
  getRoomByUrl: jest.fn(),
  getRecordingFiles: jest.fn(),
}));

const fs = require('fs');
const DataService = require('../server/services/DataService');
const RecordingManager = require('../server/lib/core/RecordingManager');
const RecorderService = require('../server/services/RecorderService');
const pool = require('../server/db/index');

const DIR = '/data/video_downloads/77';
const MB20 = 20 * 1024 * 1024;

describe('S2 — 看门狗强制停止后的 close 收敛', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readdirSync').mockReturnValue(['seg1.flv']);
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
    // 默认：会话仍为 recording（未被他方终态化）
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT status FROM recording_sessions/.test(sql)) return { rows: [{ status: 'recording' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('会话已由看门狗置 interrupted、close 收到 SIGTERM：不标记 completed、不入队转码', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT status FROM recording_sessions/.test(sql)) return { rows: [{ status: 'interrupted' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    await RecorderService._handleSessionFinish({
      sessionId: 77,
      code: null,
      signal: 'SIGTERM',
      isManualStop: false,
    });

    // 已终态：文件状态跟随会话（interrupted），且不得入队转码
    const fileUpdates = pool.query.mock.calls.filter(([sql]) => /UPDATE recording_files/.test(sql));
    expect(fileUpdates.length).toBeGreaterThan(0);
    // 终态路径只更新文件大小（单参数），不改 status
    for (const [sql, params] of fileUpdates) {
      expect(sql).not.toContain('status = $2');
      expect(params.length).toBe(3);
    }
    expect(RecordingManager.addTranscodeQueue).not.toHaveBeenCalled();
    // 会话状态不被 close 覆盖
    const sessionUpdates = pool.query.mock.calls.filter(([sql]) => /UPDATE recording_sessions/.test(sql));
    expect(sessionUpdates).toHaveLength(1);
    expect(sessionUpdates[0][0]).not.toContain("status = 'completed'");
  });

  test('看门狗链路传 isManualStop=true：会话/文件/转码三者一致（completed + 入队）', async () => {
    await RecorderService.finishSession({
      code: null,
      signal: 'SIGKILL',
      sessionId: 77,
      isManualStop: true,
    });

    const sessionUpdate = pool.query.mock.calls.find(([sql]) => /UPDATE recording_sessions/.test(sql));
    expect(sessionUpdate[1][0]).toBe('completed');
    const fileUpdate = pool.query.mock.calls.find(([sql]) => /UPDATE recording_files/.test(sql));
    expect(fileUpdate[1][1]).toBe('completed');
    expect(RecordingManager.addTranscodeQueue).toHaveBeenCalledWith(77, `${DIR}/seg1.flv`);
  });

  test('非预期退出：会话与文件同为 interrupted，窗口内绝不入队转码', async () => {
    await RecorderService.finishSession({ code: 1, signal: null, sessionId: 77, isManualStop: false });

    const sessionUpdate = pool.query.mock.calls.find(([sql]) => /UPDATE recording_sessions/.test(sql));
    expect(sessionUpdate[1][0]).toBe('interrupted');
    const fileUpdate = pool.query.mock.calls.find(([sql]) => /UPDATE recording_files/.test(sql));
    expect(fileUpdate[1][1]).toBe('interrupted');
    expect(RecordingManager.addTranscodeQueue).not.toHaveBeenCalled();
  });
});
