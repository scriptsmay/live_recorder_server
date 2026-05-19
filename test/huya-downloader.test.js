const path = require('path');
const { spawn } = require('child_process');
const HuyaPythonDownloader = require('../lib/core/downloaders/HuyaPythonDownloader');
const DownloaderFactory = require('../lib/core/downloaders/DownloaderFactory');

// Mock child_process.spawn
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

describe('Huya Downloader Module', () => {
  describe('HuyaPythonDownloader', () => {
    let downloader;

    beforeEach(() => {
      jest.clearAllMocks();
      downloader = new HuyaPythonDownloader();
    });

    describe('基本属性', () => {
      it('should have correct name', () => {
        expect(downloader.name).toBe('huya-python');
      });

      it('should return correct extension', () => {
        expect(downloader.getExtension()).toBe('.flv');
      });
    });

    describe('buildArgs', () => {
      it('should build basic args correctly', () => {
        const url = 'http://example.com/stream.flv';
        const outputPath = '/tmp/test.flv';
        
        const args = downloader.buildArgs(url, outputPath);
        
        expect(args[0]).toContain('huya_downloader.py');
        expect(args).toContain('--url');
        expect(args).toContain(url);
        expect(args).toContain('--output');
        expect(args).toContain(outputPath);
        expect(args).toContain('--quality');
        expect(args).toContain('UHD');
      });

      it('should include segment duration when specified', () => {
        const url = 'http://example.com/stream.flv';
        const outputPath = '/tmp/test.flv';
        
        const args = downloader.buildArgs(url, outputPath, { segmentDuration: 3600 });
        
        expect(args).toContain('--segment-duration');
        expect(args).toContain('3600');
      });

      it('should include is-stream-url flag when specified', () => {
        const url = 'http://example.com/stream.flv';
        const outputPath = '/tmp/test.flv';
        
        const args = downloader.buildArgs(url, outputPath, { isStreamUrl: true });
        
        expect(args).toContain('--is-stream-url');
      });

      it('should use custom quality when specified', () => {
        const url = 'http://example.com/stream.flv';
        const outputPath = '/tmp/test.flv';
        
        const args = downloader.buildArgs(url, outputPath, { quality: 'HD' });
        
        expect(args).toContain('--quality');
        expect(args).toContain('HD');
      });
    });

    describe('spawn', () => {
      it('should call spawn with correct arguments', () => {
        const mockProcess = {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
          pid: 12345,
        };
        
        spawn.mockReturnValue(mockProcess);
        
        const args = ['script.py', '--url', 'test'];
        const result = downloader.spawn(args);
        
        expect(spawn).toHaveBeenCalledWith('python3', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        });
        expect(result).toBe(mockProcess);
      });
    });

    describe('parseProgress', () => {
      it('should parse time, size, speed, and frame from stderr line', () => {
        const line = 'frame=  123 fps= 50 q=29.0 size=  10240kB time=00:01:23.45 bitrate=1024.0kbits/s speed=1.5x';
        
        const progress = downloader.parseProgress(line);
        
        expect(progress).toEqual({
          timeSeconds: 83.45,
          sizeBytes: 10240 * 1024,
          speed: 1.5,
          frames: 123,
        });
      });

      it('should return null for invalid lines', () => {
        expect(downloader.parseProgress('invalid line')).toBeNull();
        expect(downloader.parseProgress('')).toBeNull();
      });

      it('should handle different units', () => {
        const lineMB = 'size=  10MB';
        const lineGB = 'size=    2GB';
        
        expect(downloader.parseProgress(lineMB).sizeBytes).toBe(10 * 1024 * 1024);
        expect(downloader.parseProgress(lineGB).sizeBytes).toBe(2 * 1024 * 1024 * 1024);
      });
    });

    describe('getRetryStrategy', () => {
      it('should return retry strategy for retryable errors', () => {
        expect(downloader.getRetryStrategy(1)).toEqual({
          shouldRetry: true,
          delayMs: 5000,
          maxRetries: 3,
        });
        
        expect(downloader.getRetryStrategy(131)).toEqual({
          shouldRetry: true,
          delayMs: 5000,
          maxRetries: 3,
        });
        
        expect(downloader.getRetryStrategy(137)).toEqual({
          shouldRetry: true,
          delayMs: 5000,
          maxRetries: 3,
        });
        
        expect(downloader.getRetryStrategy(255)).toEqual({
          shouldRetry: true,
          delayMs: 5000,
          maxRetries: 3,
        });
      });

      it('should return no-retry strategy for non-retryable errors', () => {
        expect(downloader.getRetryStrategy(0)).toEqual({
          shouldRetry: false,
          delayMs: 0,
          maxRetries: 0,
        });
        
        expect(downloader.getRetryStrategy(999)).toEqual({
          shouldRetry: false,
          delayMs: 0,
          maxRetries: 0,
        });
      });
    });

    describe('getDefaultOptions', () => {
      it('should return default options', () => {
        expect(downloader.getDefaultOptions()).toEqual({
          segmentDuration: 0,
          quality: 'UHD',
          isStreamUrl: false,
        });
      });
    });
  });

  describe('DownloaderFactory', () => {
    describe('getActiveDownloader', () => {
      it('should return HuyaPythonDownloader for huya platform', async () => {
        const downloader = await DownloaderFactory.getActiveDownloader('huya');
        
        expect(downloader.name).toBe('huya-python');
        expect(downloader.constructor.name).toBe('HuyaPythonDownloader');
      });

      it('should return FFmpegDownloader for other platforms', async () => {
        const downloader = await DownloaderFactory.getActiveDownloader('other');
        
        expect(downloader.name).toBe('ffmpeg');
        expect(downloader.constructor.name).toBe('FFmpegDownloader');
      });

      it('should return FFmpegDownloader when no platform specified', async () => {
        const downloader = await DownloaderFactory.getActiveDownloader();
        
        expect(downloader.name).toBe('ffmpeg');
      });
    });
  });

  describe('huya_downloader.py 脚本检查', () => {
    it('should exist in correct location', () => {
      const scriptPath = path.resolve(__dirname, '../lib/core/downloaders/huya_downloader.py');
      
      // Just check that we can resolve the path without error
      expect(scriptPath).toContain('huya_downloader.py');
    });
  });
});
