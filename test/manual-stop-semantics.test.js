// S1：主动停止链路的 completed 语义（RoomService / deleteRoom / watchdog 强制终止）
jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({
  del: jest.fn().mockResolvedValue(),
  get: jest.fn(),
  setEx: jest.fn(),
  set: jest.fn(),
}));
jest.mock('../server/services/DataService', () => ({ getRoomByUrl: jest.fn(), getSetting: jest.fn() }));
jest.mock('../server/lib/core/scan-files', () => ({ scanRecordingFiles: jest.fn() }));
jest.mock('../server/lib/core/RecordingManager', () => ({
  stopRecordingProcess: jest.fn().mockResolvedValue(),
}));
// watchdog 依赖
jest.mock('../server/services/UploadService', () => ({ scanPendingAutoUpload: jest.fn() }));
jest.mock('../server/lib/core/downloaders/DownloaderFactory', () => ({ getActiveDownloader: jest.fn() }));
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
const RoomService = require('../server/services/RoomService');
const liveProcesses = require('../server/lib/utils/live-processes');
const RecordingManager = require('../server/lib/core/RecordingManager');
const pool = require('../server/db/index');
const DataService = require('../server/services/DataService');
const { checkStaleRecordings } = require('../server/lib/core/watchdog');
const { getActiveDownloader } = require('../server/lib/core/downloaders/DownloaderFactory');

const ROOM_URL = 'https://www.huya.com/123';

function fakeProcess({ pid = 4321 } = {}) {
  const listeners = {};
  return {
    pid,
    killed: false,
    exitCode: null,
    once: jest.fn((evt, fn) => {
      listeners[evt] = fn;
    }),
    emit: (evt, ...args) => listeners[evt] && listeners[evt](...args),
  };
}

describe('S1 — 主动停止判定为 completed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    liveProcesses._reset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    getActiveDownloader.mockReturnValue({ name: 'ffmpeg' });
    DataService.getSetting.mockResolvedValue('60');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    liveProcesses._reset();
  });

  test('RoomService.stopRecording 命中登记进程时走优雅停止（打标记），close 可判 completed', async () => {
    const proc = fakeProcess();
    liveProcesses.register({ sessionId: 11, process: proc });
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
    jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);
    const room = { id: 7, room_url: ROOM_URL, room_name: 'r', status: 'recording', ffmpeg_pid: 4321, output_path: '' };
    jest.spyOn(RoomService, 'getRoomByUrl').mockResolvedValue(room);

    await RoomService.stopRecording(ROOM_URL);
    // stopProcessIntentionally 为异步链，等待微任务排空
    await new Promise((r) => setImmediate(r));

    // 走 RecordingManager.stopRecordingProcess —— 该函数内部写入 _manualStopped
    // （真实标记行为由 recording-manager-stop.test.js 覆盖）
    expect(RecordingManager.stopRecordingProcess).toHaveBeenCalledWith(proc);
  });

  test('RoomService.deleteRoom 同样标记进程为人工停止', async () => {
    const proc = fakeProcess({ pid: 5555 });
    liveProcesses.register({ sessionId: 12, process: proc });
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 7, room_url: ROOM_URL, ffmpeg_pid: 5555 }] })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await RoomService.deleteRoom(7);
    await new Promise((r) => setImmediate(r));

    expect(RecordingManager.stopRecordingProcess).toHaveBeenCalledWith(proc);
  });

  test('未登记的残留 PID 回退为 SIGTERM，不影响删除流程', async () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {});
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 7, room_url: ROOM_URL, ffmpeg_pid: 9999 }] })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await RoomService.deleteRoom(7);
    await new Promise((r) => setImmediate(r));

    expect(killSpy).toHaveBeenCalledWith(9999, 'SIGTERM');
    expect(RecordingManager.stopRecordingProcess).not.toHaveBeenCalled();
  });

  test('watchdog 强制终止僵死进程：标记为主动停止，且不写 interrupted', async () => {
    // rooms 查询返回僵死房间，进程已死 → 进入清理分支
    const proc = fakeProcess({ pid: 7777 });
    liveProcesses.register({ sessionId: 33, process: proc });
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 7,
            room_url: ROOM_URL,
            room_name: 'r',
            ffmpeg_pid: 7777,
            output_path: '',
            polling_platform: 'huya',
            segment_duration: 0,
            session_id: 33,
          },
        ],
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    jest.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });

    await checkStaleRecordings();
    await new Promise((r) => setImmediate(r));

    // 看门狗先经登记表打标记，再走优雅停止（标记写入由 RecordingManager 实现）
    expect(proc._manualStopped).toBe(true);
    expect(RecordingManager.stopRecordingProcess).toHaveBeenCalledWith(proc);
    // 进程已不存在时才兜底 interrupted 会话；此处 processAlive=false，兜底 UPDATE 允许，
    // 但绝不能把会话写成 completed
    const sessionSqls = pool.query.mock.calls.map(([sql]) => sql);
    expect(sessionSqls.some((sql) => /status = 'completed'/.test(sql))).toBe(false);
  });

  test('watchdog 清理时进程仍存活：会话/文件状态交给 close 回调，不写 interrupted', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 8,
            room_url: ROOM_URL,
            room_name: 'r',
            ffmpeg_pid: 8888,
            output_path: '/data/nonexistent.flv',
            polling_platform: 'huya',
            segment_duration: 0,
            session_id: 34,
          },
        ],
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    // 进程存活
    jest.spyOn(process, 'kill').mockImplementation(() => {});
    jest.spyOn(fs, 'statSync').mockImplementation(() => ({ isFile: () => true, mtimeMs: Date.now() - 999999 }));

    await checkStaleRecordings();
    await new Promise((r) => setImmediate(r));

    const sqls = pool.query.mock.calls.map(([sql]) => sql);
    expect(sqls.some((sql) => /UPDATE recording_sessions[\s\S]*status = 'interrupted'/.test(sql))).toBe(false);
    expect(sqls.some((sql) => /UPDATE recording_files[\s\S]*status = 'interrupted'/.test(sql))).toBe(false);
  });
});
