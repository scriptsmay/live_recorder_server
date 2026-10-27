jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/services/DataService', () => ({ getSetting: jest.fn() }));

const fs = require('fs');
const pool = require('../server/db/index');
const DataService = require('../server/services/DataService');
const DanmakuRecorder = require('../server/lib/core/danmaku/DanmakuRecorder');

const ROOM = 'https://live.kuaishou.com/u/test';
const SESSION_ID = 42;
const ORIGINAL_STARTED_AT = new Date('2026-01-01T00:00:00Z');
const RESUME_FFMPEG_STARTED_AT = ORIGINAL_STARTED_AT.getTime() + 3600 * 1000; // 1 小时后续播

describe('DanmakuRecorder.startCapture/stopCapture — 采集记录复用与时间轴锚定', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VIDEO_DOWNLOAD_DIR = '/tmp/danmaku-reuse-test';
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    jest.spyOn(fs, 'openSync').mockReturnValue(11);
    jest.spyOn(fs, 'writeSync').mockImplementation(() => 0);
    jest.spyOn(fs, 'closeSync').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    DataService.getSetting.mockResolvedValue('true');
  });

  afterEach(() => {
    DanmakuRecorder.activeSessions.clear();
    delete process.env.VIDEO_DOWNLOAD_DIR;
    jest.restoreAllMocks();
  });

  test('无既有记录：INSERT 一条新记录，eventCount 从 0 开始', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/FROM danmaku_capture_records/.test(sql)) return { rows: [] };
      if (/INSERT INTO danmaku_capture_records/.test(sql)) return { rows: [{ id: 100 }] };
      return { rows: [] };
    });

    const captureId = await DanmakuRecorder.startCapture({
      sessionId: SESSION_ID,
      roomId: 7,
      roomUrl: ROOM,
      platform: 'kuaishou',
      recordingStartedAt: RESUME_FFMPEG_STARTED_AT,
    });

    expect(captureId).toBe(100);
    const inserts = pool.query.mock.calls.filter(([sql]) => /INSERT INTO danmaku_capture_records/.test(sql));
    expect(inserts).toHaveLength(1);

    const session = DanmakuRecorder.getSession(ROOM);
    expect(session.eventCount).toBe(0);
    expect(session.startedAt).toBe(RESUME_FFMPEG_STARTED_AT);
  });

  test('同 session_id + raw_path 已存在：复用记录，不重复 INSERT', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/FROM danmaku_capture_records/.test(sql)) return { rows: [{ id: 100, event_count: 5 }] };
      if (/FROM recording_sessions/.test(sql)) return { rows: [{ started_ms: String(ORIGINAL_STARTED_AT.getTime()) }] };
      return { rows: [] };
    });

    const captureId = await DanmakuRecorder.startCapture({
      sessionId: SESSION_ID,
      roomId: 7,
      roomUrl: ROOM,
      platform: 'kuaishou',
      recordingStartedAt: RESUME_FFMPEG_STARTED_AT,
    });

    expect(captureId).toBe(100);
    const inserts = pool.query.mock.calls.filter(([sql]) => /INSERT INTO danmaku_capture_records/.test(sql));
    expect(inserts).toHaveLength(0);

    // 复用记录改回 recording 并清空 ended_at
    const reuseUpdate = pool.query.mock.calls.find(([sql]) => /UPDATE danmaku_capture_records/.test(sql));
    expect(reuseUpdate[0]).toContain("status = 'recording'");
    expect(reuseUpdate[0]).toContain('ended_at = NULL');
    expect(reuseUpdate[1]).toEqual([100]);

    // 事件计数继承既有值
    expect(DanmakuRecorder.getSession(ROOM).eventCount).toBe(5);
  });

  test('复用记录时时间轴基准锚定 recording_sessions 初始 started_at，而非续播启动时间', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/FROM danmaku_capture_records/.test(sql)) return { rows: [{ id: 100, event_count: 2 }] };
      if (/FROM recording_sessions/.test(sql)) return { rows: [{ started_ms: String(ORIGINAL_STARTED_AT.getTime()) }] };
      return { rows: [] };
    });

    await DanmakuRecorder.startCapture({
      sessionId: SESSION_ID,
      roomId: 7,
      roomUrl: ROOM,
      platform: 'kuaishou',
      recordingStartedAt: RESUME_FFMPEG_STARTED_AT,
    });

    // started_at 的 epoch 必须在 SQL 内换算（时区安全），不在 Node 侧 new Date(row.started_at)
    const anchorQuery = pool.query.mock.calls.find(([sql]) => /FROM recording_sessions/.test(sql));
    expect(anchorQuery[0]).toContain('EXTRACT(EPOCH FROM (started_at AT TIME ZONE');
    expect(anchorQuery[0]).toContain("current_setting('TimeZone')");
    expect(anchorQuery[0]).toContain('AS started_ms');

    const session = DanmakuRecorder.getSession(ROOM);
    expect(session.startedAt).toBe(ORIGINAL_STARTED_AT.getTime());
    expect(session.startedAt).not.toBe(RESUME_FFMPEG_STARTED_AT);
  });

  test('续播后事件累加：stopCapture 写回全局总数', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/FROM danmaku_capture_records/.test(sql)) return { rows: [{ id: 100, event_count: 5 }] };
      if (/FROM recording_sessions/.test(sql)) return { rows: [{ started_ms: String(ORIGINAL_STARTED_AT.getTime()) }] };
      return { rows: [] };
    });

    await DanmakuRecorder.startCapture({
      sessionId: SESSION_ID,
      roomId: 7,
      roomUrl: ROOM,
      platform: 'kuaishou',
      recordingStartedAt: RESUME_FFMPEG_STARTED_AT,
    });

    // 续播期间新增 3 条弹幕（ts_ms 相对原会话启动时间）
    const result = await DanmakuRecorder.writeBatch(ROOM, [
      { ts_abs_ms: ORIGINAL_STARTED_AT.getTime() + 3600 * 1000 + 1000, type: 'comment', user: 'A', text: 'a' },
      { ts_abs_ms: ORIGINAL_STARTED_AT.getTime() + 3600 * 1000 + 2000, type: 'comment', user: 'B', text: 'b' },
      { ts_abs_ms: ORIGINAL_STARTED_AT.getTime() + 3600 * 1000 + 3000, type: 'comment', user: 'C', text: 'c' },
    ]);
    expect(result.written).toBe(3);
    expect(DanmakuRecorder.getSession(ROOM).eventCount).toBe(8);

    const stopped = await DanmakuRecorder.stopCapture(ROOM);
    expect(stopped).toEqual({ captureId: 100, eventCount: 8 });

    const countUpdate = pool.query.mock.calls.find(
      ([sql]) => /UPDATE danmaku_capture_records/.test(sql) && /event_count = \$1/.test(sql)
    );
    expect(countUpdate[1]).toEqual([8, 100]);
  });

  test('事件 ts_ms 以原会话 started_at 为基准（续播后仍单调对齐视频时间轴）', async () => {
    DanmakuRecorder.activeSessions.set(ROOM, {
      sessionId: SESSION_ID,
      captureId: 100,
      fd: 11,
      recordingStartedAt: ORIGINAL_STARTED_AT.getTime(),
      startedAt: ORIGINAL_STARTED_AT.getTime(),
      eventCount: 5,
      rawPath: '/tmp/x.jsonl',
    });

    const writeSpy = jest.spyOn(fs, 'writeSync').mockImplementation(() => 0);
    await DanmakuRecorder.writeBatch(ROOM, [
      { ts_abs_ms: ORIGINAL_STARTED_AT.getTime() + 3600 * 1000, type: 'comment', user: 'A', text: 'a' },
    ]);

    const line = JSON.parse(writeSpy.mock.calls[0][1].trim());
    expect(line.ts_ms).toBe(3600 * 1000);
  });
});
