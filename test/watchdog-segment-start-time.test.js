// v1.14.5：watchdog scanActiveSegments 补登记分段时，started_at 必须取文件名里的
// strftime 时间戳，而不是当时发现文件的 NOW()（会让时间轴整体右移一个稳定期）。
jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/services/DataService', () => ({ getSetting: jest.fn() }));
jest.mock('../server/services/UploadService', () => ({ scanPendingAutoUpload: jest.fn() }));
jest.mock('../server/lib/core/downloaders/DownloaderFactory', () => ({ getActiveDownloader: jest.fn() }));
jest.mock('../server/lib/core/scan-files', () => ({ scanRecordingFiles: jest.fn() }));
jest.mock('../server/lib/core/TranscodeQueue', () => ({ enqueue: jest.fn() }));
jest.mock('../server/lib/core/hls-generator', () => ({ generateForRecording: jest.fn() }));
jest.mock('../server/lib/core/logger', () => ({
  createModuleLogger: jest.fn(() => ({
    info: jest.fn(),
    important: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));
jest.mock('child_process', () => ({ spawn: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const pool = require('../server/db/index');
const DataService = require('../server/services/DataService');
const { scanActiveSegments } = require('../server/lib/core/watchdog');

const DIR = '/data/video_downloads/99';
const SEG_NAME = 'room_20261105_224306.ts';
const SEG_PATH = path.join(DIR, SEG_NAME);
const MTIME_MS = Date.parse('2026-11-05T22:44:00Z');
// 固定「现在」为 mtime 之后 1 分钟，确保通过 20 秒稳定期判断，
// 同时不受 jest 环境把系统时间冻结到某一天的影响。
const NOW_MS = MTIME_MS + 60 * 1000;

function mockFfprobe() {
  spawn.mockImplementation(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    process.nextTick(() => {
      proc.stdout.emit('data', JSON.stringify({ format: { duration: '3600' } }));
      proc.emit('close', 0);
    });
    return proc;
  });
}

describe('watchdog scanActiveSegments — 补登记 started_at', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readdirSync').mockReturnValue([SEG_NAME]);
    jest.spyOn(fs, 'statSync').mockReturnValue({
      size: 20 * 1024 * 1024,
      mtimeMs: MTIME_MS,
      isFile: () => true,
    });

    // 阈值 0：parseInt('0') || 10 会回落到 10MB，但 20MB 文件仍通过，知足测试需要
    DataService.getSetting.mockResolvedValue('0');
    mockFfprobe();

    pool.query.mockImplementation(async (sql) => {
      if (/FROM recording_sessions rs/.test(sql)) {
        return {
          rows: [
            {
              session_id: 99,
              total_segments: 0,
              output_dir: DIR,
              ended_at: null,
              room_id: 1,
              room_url: 'https://example.com/room',
              room_name: 'test',
              output_path: SEG_PATH,
            },
          ],
        };
      }
      if (/SELECT id, file_size FROM recording_files/.test(sql)) return { rows: [] };
      if (/FROM managed_files/.test(sql)) return { rows: [] };
      if (/INSERT INTO recording_files/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('INSERT 的 started_at 取文件名时间戳，不是发现时刻', async () => {
    await scanActiveSegments();

    const insert = pool.query.mock.calls.find(([sql]) => /INSERT INTO recording_files/.test(sql));
    expect(insert).toBeDefined();
    // 参数顺序: session_id, room_url, file_path, file_name, size, started_at, segIndex, durationSec
    const startedAt = insert[1][5];
    expect(startedAt).toBeInstanceOf(Date);
    expect(startedAt.getFullYear()).toBe(2026);
    expect(startedAt.getMonth()).toBe(10);
    expect(startedAt.getDate()).toBe(5);
    expect(startedAt.getHours()).toBe(22);
    expect(startedAt.getMinutes()).toBe(43);
    expect(startedAt.getSeconds()).toBe(6);
    // 不是 mtime / NOW（22:44 / 22:45）
    expect(startedAt.getTime()).not.toBe(MTIME_MS);
    expect(startedAt.getTime()).not.toBe(NOW_MS);
  });
});
