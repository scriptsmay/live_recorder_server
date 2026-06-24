'use strict';

jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({ get: jest.fn(), set: jest.fn(), del: jest.fn() }));
jest.mock('../server/services/ReplayService', () => ({
  getRecordWorkDir: jest.fn(() => '/tmp/replay/work'),
}));

const path = require('path');
const EventEmitter = require('events');

describe('video-processor', () => {
  let videoProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    // Mock child_process and fs before requiring the module
    jest.mock('child_process', () => ({
      spawn: jest.fn(),
    }));
    jest.mock('fs', () => {
      const actual = jest.requireActual('fs');
      return {
        ...actual,
        existsSync: jest.fn(() => true),
        statSync: jest.fn(() => ({ size: 1024 })),
        readdirSync: jest.fn(() => []),
        mkdirSync: jest.fn(),
      };
    });
    jest.doMock('../server/lib/core/replay/KuaishouReplayClient', () => ({
      extractM3u8: jest.fn().mockResolvedValue({
        success: true,
        m3u8Url: 'https://example.com/new.m3u8',
      }),
    }));
    videoProcessor = require('../server/lib/core/replay/video-processor');
  });

  afterEach(() => {
    delete process.env.YTDLP_TEMP_DIR;
  });

  describe('ensureInside', () => {
    test('允许合法路径', () => {
      const base = '/tmp/replay/work';
      const target = '/tmp/replay/work/output.mp4';
      expect(videoProcessor.ensureInside(base, target)).toBe(target);
    });

    test('拒绝路径穿越攻击', () => {
      const base = '/tmp/replay/work';
      const target = '/etc/passwd';
      expect(() => videoProcessor.ensureInside(base, target)).toThrow('非法输出路径');
    });

    test('允许 base 目录本身', () => {
      const base = '/tmp/replay/work';
      expect(videoProcessor.ensureInside(base, base)).toBe(path.resolve(base));
    });
  });

  describe('extract', () => {
    test('已有 m3u8_url 时直接返回', async () => {
      const record = { id: 1, m3u8_url: 'https://example.com/a.m3u8' };
      const result = await videoProcessor.extract(record);
      expect(result.success).toBe(true);
      expect(result.m3u8Url).toBe('https://example.com/a.m3u8');
    });

    test('force=true 时忽略已有 m3u8_url 并重新提取', async () => {
      const client = require('../server/lib/core/replay/KuaishouReplayClient');
      const record = {
        id: 1,
        replay_id: 'r1',
        m3u8_url: 'https://example.com/old.m3u8',
      };

      const result = await videoProcessor.extract(record, { force: true });

      expect(result.success).toBe(true);
      expect(result.m3u8Url).toBe('https://example.com/new.m3u8');
      expect(client.extractM3u8).toHaveBeenCalledWith(
        record,
        expect.objectContaining({
          force: true,
        })
      );
    });

    test('缺少 replay_id 和 play_url 时失败', async () => {
      const record = { id: 1 };
      const result = await videoProcessor.extract(record);
      expect(result.success).toBe(false);
      expect(result.error).toContain('缺少');
    });
  });

  describe('fix', () => {
    test('cut_file_paths JSON 解析失败时安全返回错误', async () => {
      const record = { id: 1, cut_file_paths: 'invalid json{' };
      const result = await videoProcessor.fix(record);
      expect(result.success).toBe(false);
      expect(result.error).toContain('JSON 解析失败');
    });

    test('空 cut_file_paths 时返回错误', async () => {
      const record = { id: 1, cut_file_paths: '[]' };
      const result = await videoProcessor.fix(record);
      expect(result.success).toBe(false);
      expect(result.error).toContain('缺少切割产物');
    });

    test('null cut_file_paths 时返回错误', async () => {
      const record = { id: 1, cut_file_paths: null };
      const result = await videoProcessor.fix(record);
      expect(result.success).toBe(false);
      expect(result.error).toContain('缺少切割产物');
    });
  });

  describe('download', () => {
    test('缺少 m3u8_url 时失败', async () => {
      const record = { id: 1 };
      const result = await videoProcessor.download(record);
      expect(result.success).toBe(false);
      expect(result.error).toContain('缺少 m3u8_url');
    });

    test('配置 YTDLP_TEMP_DIR 时传递 yt-dlp temp 路径', async () => {
      const { spawn } = require('child_process');
      const fs = require('fs');
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      spawn.mockImplementation(() => {
        setImmediate(() => proc.emit('close', 0));
        return proc;
      });
      process.env.YTDLP_TEMP_DIR = '/tmp/yt_dlp_cache';

      const result = await videoProcessor.download({
        id: 1,
        replay_id: 'r1',
        m3u8_url: 'https://example.com/a.m3u8',
        video_file_name: '回放',
      });

      expect(result.success).toBe(true);
      expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/yt_dlp_cache', { recursive: true });
      const args = spawn.mock.calls[0][1];
      expect(args).toContain('--paths');
      expect(args).toContain('temp:/tmp/yt_dlp_cache');
      expect(args[args.length - 1]).toBe('https://example.com/a.m3u8');
    });
  });

  describe('cut', () => {
    test('原始文件不存在时失败', async () => {
      const fs = require('fs');
      fs.existsSync.mockReturnValue(false);
      const record = { id: 1, raw_file_path: '/tmp/nonexistent.mp4' };
      const result = await videoProcessor.cut(record);
      expect(result.success).toBe(false);
      expect(result.error).toContain('不存在');
    });

    test('raw_file_path 为空时失败', async () => {
      const record = { id: 1, raw_file_path: '' };
      const result = await videoProcessor.cut(record);
      expect(result.success).toBe(false);
      expect(result.error).toContain('不存在');
    });
  });
});
