// I-R2：_handleDanmakuFinish 端到端（不 mock stopCapture）——
// 录制会话 ID 与弹幕采集记录 ID 不同，停止请求必须按录制会话 ID 校验身份。
jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({
  get: jest.fn(),
  set: jest.fn(async () => 'OK'),
  setEx: jest.fn(async () => 'OK'),
  del: jest.fn(async () => 1),
  exists: jest.fn(async () => 0),
  keys: jest.fn(async () => []),
}));
jest.mock('../server/services/DataService', () => ({
  getSetting: jest.fn(),
  getSession: jest.fn(),
  getRoomByUrl: jest.fn(),
  getRecordingFiles: jest.fn(),
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
jest.mock('../server/lib/core/polling/checkers', () => ({ fetchRoomCoverByUrl: jest.fn() }));

const fs = require('fs');
const pool = require('../server/db/index');
const DataService = require('../server/services/DataService');
const RecorderService = require('../server/services/RecorderService');
const DanmakuRecorder = require('../server/lib/core/danmaku/DanmakuRecorder');

const ROOM = 'https://live.kuaishou.com/u/finish';
const SESSION_A = 31001; // 录制会话 ID
const CAPTURE_A = 88001; // 弹幕采集记录 ID（刻意与录制会话 ID 不同）
const STARTED_AT = new Date('2026-02-01T00:00:00Z');

describe('I-R2 — _handleDanmakuFinish 以录制会话 ID 校验身份', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VIDEO_DOWNLOAD_DIR = '/tmp/danmaku-finish-test';
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    jest.spyOn(fs, 'openSync').mockImplementation(() => 21);
    jest.spyOn(fs, 'writeSync').mockImplementation(() => 0);
    jest.spyOn(fs, 'closeSync').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    DataService.getSetting.mockResolvedValue('true');
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  afterEach(() => {
    DanmakuRecorder.activeSessions.clear();
    DanmakuRecorder._roomQueues.clear();
    delete process.env.VIDEO_DOWNLOAD_DIR;
    jest.restoreAllMocks();
  });

  const seedActive = (sessionId, captureId, overrides = {}) =>
    DanmakuRecorder.activeSessions.set(ROOM, {
      sessionId,
      captureId,
      fd: 21,
      recordingStartedAt: STARTED_AT.getTime(),
      startedAt: STARTED_AT.getTime(),
      eventCount: 12,
      rawPath: `/tmp/danmaku/${sessionId}.jsonl`,
      ...overrides,
    });

  test('会话 ID 与采集记录 ID 不同：停止成功、fd 关闭、写回累计计数、活跃会话移除', async () => {
    seedActive(SESSION_A, CAPTURE_A);

    await RecorderService._handleDanmakuFinish(SESSION_A, ROOM);

    // fd 关闭（未被身份校验误拦）
    expect(fs.closeSync).toHaveBeenCalledWith(21);

    // 采集记录按 captureId 完成，写入会话累积的 event_count
    const update = pool.query.mock.calls.find(([sql]) => /UPDATE danmaku_capture_records/.test(sql));
    expect(update).toBeDefined();
    expect(update[0]).toContain("status = 'completed'");
    expect(update[1]).toEqual([12, CAPTURE_A]);

    // 活跃会话被移除
    expect(DanmakuRecorder.activeSessions.has(ROOM)).toBe(false);
  });

  test('续播接管后：旧会话的收口不得关闭新 fd，也不得把复用行直接完成', async () => {
    // 新录制会话 B 已接管该房间；采集记录复用 A 的行（captureId 相同）
    seedActive(31002, CAPTURE_A, { fd: 33, eventCount: 4 });

    // 旧会话 A 的 close 回调迟到
    await RecorderService._handleDanmakuFinish(SESSION_A, ROOM);

    expect(fs.closeSync).not.toHaveBeenCalled();
    // 不得把 B 正在使用的复用行置为 completed
    expect(pool.query.mock.calls.some(([sql]) => /UPDATE danmaku_capture_records/.test(sql))).toBe(false);
    // 新会话仍在采集中
    const active = DanmakuRecorder.activeSessions.get(ROOM);
    expect(active).toBeDefined();
    expect(active.sessionId).toBe(31002);
  });

  test('续播复用行：startCapture 把行改回 recording，随后旧会话来收口不覆盖', async () => {
    // 复用路径：同 session_id + raw_path 命中既有行
    pool.query.mockImplementation(async (sql) => {
      if (/FROM danmaku_capture_records/.test(sql)) return { rows: [{ id: CAPTURE_A, event_count: 6 }] };
      if (/FROM recording_sessions/.test(sql)) return { rows: [{ started_ms: String(STARTED_AT.getTime()) }] };
      return { rows: [], rowCount: 1 };
    });

    const captureId = await DanmakuRecorder.startCapture({
      sessionId: 31003,
      roomId: 7,
      roomUrl: ROOM,
      platform: 'kuaishou',
      recordingStartedAt: STARTED_AT.getTime() + 60_000,
    });
    expect(captureId).toBe(CAPTURE_A);

    const reuseUpdate = pool.query.mock.calls.find(
      ([sql]) => /UPDATE danmaku_capture_records/.test(sql) && /status = 'recording'/.test(sql)
    );
    expect(reuseUpdate[1]).toEqual([CAPTURE_A]);

    // 旧会话的迟到收口不得完成该行
    await RecorderService._handleDanmakuFinish(SESSION_A, ROOM);
    const completed = pool.query.mock.calls.filter(
      ([sql]) => /UPDATE danmaku_capture_records/.test(sql) && /status = 'completed'/.test(sql)
    );
    expect(completed).toHaveLength(0);
  });
});
