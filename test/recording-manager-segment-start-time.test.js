// v1.14.5：recordSegment 登记 recording_files 时，started_at 必须与
// watchdog / finishSession / scan-files 一致，取分段文件名里的 strftime 时间戳。
// 单例构造会启动 5 分钟清理定时器，用假定时器避免打开句柄。
jest.useFakeTimers();
jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({ del: jest.fn(), setEx: jest.fn() }));
jest.mock('../server/services/DataService', () => ({ getSetting: jest.fn() }));
jest.mock('../server/lib/core/TranscodeQueue', () => ({ enqueue: jest.fn() }));
jest.mock('../server/lib/core/segmenter', () => ({ segmentAndTranscode: jest.fn() }));

const pool = require('../server/db/index');
const RecordingManager = require('../server/lib/core/RecordingManager');

const SESSION_ID = 88;
const SEG_PATH = '/data/video_downloads/88/room_20261105_224306.ts';
const SESSION_START_MS = Date.parse('2026-11-05T21:43:03Z');

describe('RecordingManager.recordSegment — started_at 时间轴口径', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
    RecordingManager.activeSegments.clear();
    RecordingManager.registerSession(SESSION_ID, SESSION_START_MS, { roomUrl: 'https://example.com/room' });
  });

  afterEach(() => {
    RecordingManager.activeSegments.delete(SESSION_ID);
    jest.clearAllTimers();
    jest.restoreAllMocks();
  });

  test('INSERT 的 started_at 取文件名时间戳，不是收到 segment 事件的时刻', async () => {
    // 模拟 1 小时后才收到该分段的 Opening 事件（elapsedMs 会明显晚于文件名时间戳）
    RecordingManager.recordSegment(SESSION_ID, SEG_PATH, 3600 * 1000);
    await Promise.resolve(); // 刷新 fire-and-forget 的 pool.query

    const insert = pool.query.mock.calls.find(([sql]) => /INSERT INTO recording_files/.test(sql));
    expect(insert).toBeDefined();
    // 参数顺序: sessionId, roomUrl, filePath, fileName, startedAt, segIndex
    const startedAt = insert[1][4];
    expect(startedAt).toBeInstanceOf(Date);
    expect(startedAt.getFullYear()).toBe(2026);
    expect(startedAt.getMonth()).toBe(10);
    expect(startedAt.getDate()).toBe(5);
    expect(startedAt.getHours()).toBe(22);
    expect(startedAt.getMinutes()).toBe(43);
    expect(startedAt.getSeconds()).toBe(6);
    // 不是 sessionStart + elapsed（22:43:03）
    expect(startedAt.getTime()).not.toBe(SESSION_START_MS + 3600 * 1000);
  });

  test('无时间戳的固定文件名回退到事件时刻，行为保持不变', async () => {
    const fixedPath = '/data/video_downloads/88/room_fixed.ts';
    const elapsed = 5 * 60 * 1000;
    RecordingManager.recordSegment(SESSION_ID, fixedPath, elapsed);
    await Promise.resolve();

    const insert = pool.query.mock.calls.find(([sql]) => /INSERT INTO recording_files/.test(sql));
    expect(insert[1][4].getTime()).toBe(SESSION_START_MS + elapsed);
  });

  test('段索引按 Opening 事件顺序递增', () => {
    RecordingManager.recordSegment(SESSION_ID, '/d/a_20261105_214304.ts', 0);
    RecordingManager.recordSegment(SESSION_ID, SEG_PATH, 3600 * 1000);

    expect(pool.query.mock.calls[0][1][5]).toBe(0);
    expect(pool.query.mock.calls[1][1][5]).toBe(1);
  });
});
