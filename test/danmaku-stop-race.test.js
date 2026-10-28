// S3：续播期间 start/stop 竞态——旧的 stopCapture 不得收口/驱逐新会话
jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/services/DataService', () => ({ getSetting: jest.fn() }));

const fs = require('fs');
const pool = require('../server/db/index');
const DataService = require('../server/services/DataService');
const DanmakuRecorder = require('../server/lib/core/danmaku/DanmakuRecorder');

const ROOM = 'https://live.kuaishou.com/u/race';
const ORIGINAL_STARTED_AT = new Date('2026-01-01T00:00:00Z');

describe('S3 — 弹幕 start/stop 串行与身份校验', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VIDEO_DOWNLOAD_DIR = '/tmp/danmaku-race-test';
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    jest.spyOn(fs, 'openSync').mockImplementation(() => 11);
    jest.spyOn(fs, 'writeSync').mockImplementation(() => 0);
    jest.spyOn(fs, 'closeSync').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    DataService.getSetting.mockResolvedValue('true');
  });

  afterEach(() => {
    DanmakuRecorder.activeSessions.clear();
    DanmakuRecorder._roomQueues.clear();
    delete process.env.VIDEO_DOWNLOAD_DIR;
    jest.restoreAllMocks();
  });

  test('旧 stop（captureId 不匹配新会话）不关闭 fd、不写库、不驱逐新会话', async () => {
    // 新会话已占用该 roomUrl
    const newSession = {
      sessionId: 100,
      captureId: 500,
      fd: 99,
      startedAt: ORIGINAL_STARTED_AT.getTime(),
      eventCount: 3,
      rawPath: '/tmp/new.jsonl',
    };
    DanmakuRecorder.activeSessions.set(ROOM, newSession);
    const closeSpy = jest.spyOn(fs, 'closeSync');

    // 旧会话（captureId=400）的 stop 迟到
    const result = await DanmakuRecorder.stopCapture(ROOM, { captureId: 400 });

    expect(result).toEqual({ captureId: null, eventCount: 0 });
    expect(closeSpy).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    // 新会话仍在，未被驱逐
    expect(DanmakuRecorder.activeSessions.get(ROOM)).toBe(newSession);
  });

  test('captureId 匹配时正常收口并写回累计计数', async () => {
    const session = {
      sessionId: 100,
      captureId: 500,
      fd: 99,
      startedAt: ORIGINAL_STARTED_AT.getTime(),
      eventCount: 7,
      rawPath: '/tmp/new.jsonl',
    };
    DanmakuRecorder.activeSessions.set(ROOM, session);
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const result = await DanmakuRecorder.stopCapture(ROOM, { captureId: 500 });

    expect(result).toEqual({ captureId: 500, eventCount: 7 });
    expect(DanmakuRecorder.activeSessions.has(ROOM)).toBe(false);
    const update = pool.query.mock.calls.find(([sql]) => /UPDATE danmaku_capture_records/.test(sql));
    expect(update[1]).toEqual([7, 500]);
  });

  test('并发 start/stop 严格串行：start 不会被旧 stop 驱逐', async () => {
    // 旧会话已在采集中
    const oldSession = {
      sessionId: 100,
      captureId: 400,
      fd: 11,
      startedAt: ORIGINAL_STARTED_AT.getTime(),
      eventCount: 2,
      rawPath: '/tmp/100.jsonl',
    };
    DanmakuRecorder.activeSessions.set(ROOM, oldSession);

    // 数据库：复用同一条记录
    pool.query.mockImplementation(async (sql) => {
      if (/FROM danmaku_capture_records/.test(sql)) return { rows: [{ id: 400, event_count: 2 }] };
      if (/FROM recording_sessions/.test(sql)) return { rows: [{ started_ms: String(ORIGINAL_STARTED_AT.getTime()) }] };
      return { rows: [], rowCount: 1 };
    });

    // 模拟：先发起 stop（旧会话），紧接着发起 start（续播新 leg）
    const stopPromise = DanmakuRecorder.stopCapture(ROOM, { captureId: 400 });
    const startPromise = DanmakuRecorder.startCapture({
      sessionId: 100,
      roomId: 7,
      roomUrl: ROOM,
      platform: 'kuaishou',
      recordingStartedAt: ORIGINAL_STARTED_AT.getTime() + 5000,
    });

    const [stopped, started] = await Promise.all([stopPromise, startPromise]);

    expect(stopped).toEqual({ captureId: 400, eventCount: 2 });
    expect(started).toBe(400);
    // start 在 stop 之后执行，新会话应存在且计数继承
    const active = DanmakuRecorder.activeSessions.get(ROOM);
    expect(active).toBeDefined();
    expect(active.captureId).toBe(400);
    expect(active.eventCount).toBe(2);
    // 串行：close 在 start 打开新 fd 之前完成
    expect(fs.closeSync).toHaveBeenCalledWith(11);
  });

  test('start 与 stop 批次交错时，stop 按队列顺序先完成，start 后建立会话', async () => {
    const order = [];
    const origStart = DanmakuRecorder._startCapture.bind(DanmakuRecorder);
    const origStop = DanmakuRecorder._stopCapture.bind(DanmakuRecorder);
    jest.spyOn(DanmakuRecorder, '_startCapture').mockImplementation(async (p) => {
      order.push('start');
      return origStart(p);
    });
    jest.spyOn(DanmakuRecorder, '_stopCapture').mockImplementation(async (room, opts) => {
      order.push('stop');
      return origStop(room, opts);
    });
    pool.query.mockImplementation(async (sql) => {
      if (/FROM danmaku_capture_records/.test(sql)) return { rows: [] };
      if (/FROM recording_sessions/.test(sql)) return { rows: [{ started_ms: String(ORIGINAL_STARTED_AT.getTime()) }] };
      if (/INSERT INTO danmaku_capture_records/.test(sql)) return { rows: [{ id: 900 }] };
      return { rows: [], rowCount: 1 };
    });

    // 空队列时 stop 先入队（无活跃会话 → 立即返回），start 后入队
    const p1 = DanmakuRecorder.stopCapture(ROOM, { captureId: 1 });
    const p2 = DanmakuRecorder.startCapture({
      sessionId: 101,
      roomId: 7,
      roomUrl: ROOM,
      platform: 'kuaishou',
    });
    await Promise.all([p1, p2]);

    expect(order).toEqual(['stop', 'start']);
  });
});
