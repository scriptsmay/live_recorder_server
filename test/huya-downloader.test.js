const { spawn } = require('child_process');
const { Readable } = require('stream');
const FFmpegDownloader = require('../server/lib/core/downloaders/FFmpegDownloader');
const DownloaderFactory = require('../server/lib/core/downloaders/DownloaderFactory');

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

describe('FFmpeg Downloader Module', () => {
  describe('FFmpegDownloader', () => {
    let downloader;

    beforeEach(() => {
      jest.clearAllMocks();
      downloader = new FFmpegDownloader();
    });

    describe('基本属性', () => {
      it('should have correct name', () => {
        expect(downloader.name).toBe('ffmpeg');
      });

      it('should return correct extension', () => {
        expect(downloader.getExtension()).toBe('.ts');
      });

      it('should support segment recording', () => {
        expect(downloader.isSegment()).toBe(true);
      });
    });

    describe('buildArgs', () => {
      it('should build basic args correctly for non-segment recording', () => {
        const url = 'http://example.com/stream.flv';
        const outputPath = '/tmp/test.ts';

        const args = downloader.buildArgs(url, outputPath);

        expect(args).toContain('-y');
        expect(args).toContain('-user_agent');
        expect(args.some((arg) => arg.startsWith('Mozilla/5.0'))).toBe(true);
        expect(args).toContain('-protocol_whitelist');
        expect(args).toContain('rtmp,crypto,file,http,https,tcp,tls,udp,rtp,httpproxy');
        expect(args).toContain('-i');
        expect(args).toContain(url);
        expect(args).toContain('-c');
        expect(args).toContain('copy');
        expect(args).toContain('-f');
        expect(args).toContain('mpegts');
        expect(args).toContain(outputPath);
      });

      it('should build args correctly for segment recording', () => {
        const url = 'http://example.com/stream.flv';
        const outputPath = '/tmp/test_%Y%m%d_%H%M%S.ts';

        const args = downloader.buildArgs(url, outputPath, { segmentDuration: 3600 });

        expect(args).toContain('-f');
        expect(args).toContain('segment');
        expect(args).toContain('-segment_time');
        expect(args).toContain('3600');
        expect(args).toContain('-strftime');
        expect(args).toContain('1');
      });

      it('should include segment list path when specified', () => {
        const url = 'http://example.com/stream.flv';
        const outputPath = '/tmp/test_%Y%m%d_%H%M%S.ts';
        const segmentListPath = '/tmp/playlist.m3u8';

        const args = downloader.buildArgs(url, outputPath, { segmentDuration: 3600, segmentListPath });

        expect(args).toContain('-segment_list');
        expect(args).toContain(segmentListPath);
      });

      it('should include reconnection and timeout parameters', () => {
        const url = 'http://example.com/stream.flv';
        const outputPath = '/tmp/test.ts';

        const args = downloader.buildArgs(url, outputPath);

        expect(args).toContain('-rw_timeout');
        expect(args).toContain('30000000');
        expect(args).toContain('-reconnect');
        expect(args).toContain('1');
        expect(args).toContain('-reconnect_delay_max');
        expect(args).toContain('60');
      });

      it('should include error tolerance and timestamp correction flags', () => {
        const url = 'http://example.com/stream.flv';
        const outputPath = '/tmp/test.ts';

        const args = downloader.buildArgs(url, outputPath);

        expect(args).toContain('-fflags');
        expect(args).toContain('+genpts+igndts+discardcorrupt');
        expect(args).toContain('-correct_ts_overflow');
        expect(args).toContain('1');
        expect(args).toContain('-avoid_negative_ts');
        expect(args).toContain('1');
      });
    });

    describe('spawn', () => {
      it('should call spawn with correct arguments', () => {
        const mockStderr = new Readable();
        mockStderr._read = jest.fn();
        const mockProcess = {
          stderr: mockStderr,
          stdio: ['ignore', 'ignore', 'pipe'],
          pid: 12345,
        };

        spawn.mockReturnValue(mockProcess);

        const args = ['-i', 'test', '-c', 'copy', 'output.ts'];
        const result = downloader.spawn(args);

        expect(spawn).toHaveBeenCalledWith('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
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

      it('should parse partial progress information', () => {
        const line = 'time=00:01:23.45';
        const progress = downloader.parseProgress(line);

        expect(progress).toEqual({ timeSeconds: 83.45 });
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
          reconnect: true,
          reconnectDelayMax: 120,
          timeout: 30,
          streamType: 'flv',
        });
      });
    });

    describe('流类型检测', () => {
      describe('_detectStreamTypeByUrl', () => {
        it('should detect HLS from .m3u8 URL', () => {
          expect(downloader._detectStreamTypeByUrl('http://example.com/live/stream.m3u8')).toBe('hls');
        });

        it('should detect HLS from /hls/ path', () => {
          expect(downloader._detectStreamTypeByUrl('http://example.com/hls/live/stream')).toBe('hls');
        });

        it('should detect HLS from playlist URL', () => {
          expect(downloader._detectStreamTypeByUrl('http://example.com/playlist.m3u8')).toBe('hls');
        });

        it('should detect FLV from .flv URL', () => {
          expect(downloader._detectStreamTypeByUrl('http://example.com/live/stream.flv')).toBe('flv');
        });

        it('should detect FLV from /flv/ path', () => {
          expect(downloader._detectStreamTypeByUrl('http://example.com/flv/live/stream')).toBe('flv');
        });

        it('should return unknown for unrecognized URLs', () => {
          expect(downloader._detectStreamTypeByUrl('http://example.com/live/stream')).toBe('unknown');
        });

        it('should be case insensitive', () => {
          expect(downloader._detectStreamTypeByUrl('http://example.com/live/stream.M3U8')).toBe('hls');
          expect(downloader._detectStreamTypeByUrl('http://example.com/live/stream.FLV')).toBe('flv');
        });
      });

      describe('detectStreamType', () => {
        it('should return url type when URL matches', async () => {
          const result = await downloader.detectStreamType('http://example.com/stream.m3u8');
          expect(result).toEqual({ type: 'hls', metadata: { source: 'url' } });
        });

        it('should fall back to header detection for unknown URLs', async () => {
          global.fetch = jest.fn().mockResolvedValue({
            headers: { get: () => 'application/vnd.apple.mpegurl' },
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
          });

          const result = await downloader.detectStreamType('http://example.com/live/stream');
          expect(result).toEqual({ type: 'hls', metadata: { source: 'header' } });

          delete global.fetch;
        });

        it('should default to flv on detection failure', async () => {
          global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

          const result = await downloader.detectStreamType('http://example.com/live/stream');
          expect(result).toEqual({ type: 'flv', metadata: { source: 'header' } });

          delete global.fetch;
        });
      });
    });

    describe('HLS 参数构建', () => {
      it('should build HLS args with correct protocol whitelist', () => {
        const url = 'http://example.com/stream.m3u8';
        const outputPath = '/tmp/test.ts';
        const args = downloader.buildArgs(url, outputPath, { streamType: 'hls' });

        expect(args).toContain('-protocol_whitelist');
        const whitelistIndex = args.indexOf('-protocol_whitelist');
        expect(args[whitelistIndex + 1]).toContain('hls');
      });

      it('should build HLS args with live_start_index', () => {
        const url = 'http://example.com/stream.m3u8';
        const outputPath = '/tmp/test.ts';
        const args = downloader.buildArgs(url, outputPath, { streamType: 'hls' });

        expect(args).toContain('-live_start_index');
        expect(args).toContain('-1');
      });

      it('should build HLS args with longer timeout', () => {
        const url = 'http://example.com/stream.m3u8';
        const outputPath = '/tmp/test.ts';
        const args = downloader.buildArgs(url, outputPath, { streamType: 'hls' });

        expect(args).toContain('-rw_timeout');
        const timeoutIndex = args.indexOf('-rw_timeout');
        expect(args[timeoutIndex + 1]).toBe('60000000');
      });

      it('should build HLS args with make_zero avoid_negative_ts', () => {
        const url = 'http://example.com/stream.m3u8';
        const outputPath = '/tmp/test.ts';
        const args = downloader.buildArgs(url, outputPath, { streamType: 'hls' });

        const tsIndex = args.indexOf('-avoid_negative_ts');
        expect(args[tsIndex + 1]).toBe('make_zero');
      });

      it('should default to standard args when streamType is flv', () => {
        const url = 'http://example.com/stream.flv';
        const outputPath = '/tmp/test.ts';
        const args = downloader.buildArgs(url, outputPath, { streamType: 'flv' });

        const whitelistIndex = args.indexOf('-protocol_whitelist');
        expect(args[whitelistIndex + 1]).not.toContain('hls');
      });

      it('should default to standard args when streamType not specified', () => {
        const url = 'http://example.com/stream';
        const outputPath = '/tmp/test.ts';
        const args = downloader.buildArgs(url, outputPath);

        const whitelistIndex = args.indexOf('-protocol_whitelist');
        expect(args[whitelistIndex + 1]).not.toContain('hls');
      });
    });

    describe('stop', () => {
      it('should call process.kill with SIGTERM', () => {
        const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {});

        downloader.stop(12345);

        expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
        killSpy.mockRestore();
      });

      it('should not throw error when process does not exist', () => {
        const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
          throw new Error('process not found');
        });

        expect(() => downloader.stop(99999)).not.toThrow();
        killSpy.mockRestore();
      });
    });

    describe('pause', () => {
      it('should call process.kill with SIGSTOP', () => {
        const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {});

        downloader.pause(12345);

        expect(killSpy).toHaveBeenCalledWith(12345, 'SIGSTOP');
        killSpy.mockRestore();
      });

      it('should not throw error when process does not exist', () => {
        const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
          throw new Error('process not found');
        });

        expect(() => downloader.pause(99999)).not.toThrow();
        killSpy.mockRestore();
      });
    });

    describe('resume', () => {
      it('should call process.kill with SIGCONT', () => {
        const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {});

        downloader.resume(12345);

        expect(killSpy).toHaveBeenCalledWith(12345, 'SIGCONT');
        killSpy.mockRestore();
      });

      it('should not throw error when process does not exist', () => {
        const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
          throw new Error('process not found');
        });

        expect(() => downloader.resume(99999)).not.toThrow();
        killSpy.mockRestore();
      });
    });

    describe('isRunning', () => {
      it('should return true when process exists', () => {
        const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {});

        const result = downloader.isRunning(12345);

        expect(killSpy).toHaveBeenCalledWith(12345, 0);
        expect(result).toBe(true);
        killSpy.mockRestore();
      });

      it('should return false when process does not exist', () => {
        const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
          throw new Error('process not found');
        });

        const result = downloader.isRunning(99999);

        expect(result).toBe(false);
        killSpy.mockRestore();
      });
    });
  });

  describe('DownloaderFactory', () => {
    describe('getActiveDownloader', () => {
      it('should return FFmpegDownloader for any platform', () => {
        const downloader = DownloaderFactory.getActiveDownloader('huya');

        expect(downloader.name).toBe('ffmpeg');
        expect(downloader.constructor.name).toBe('FFmpegDownloader');
      });

      it('should return FFmpegDownloader for other platforms', () => {
        const downloader = DownloaderFactory.getActiveDownloader('bilibili');

        expect(downloader.name).toBe('ffmpeg');
        expect(downloader.constructor.name).toBe('FFmpegDownloader');
      });

      it('should return FFmpegDownloader when no platform specified', () => {
        const downloader = DownloaderFactory.getActiveDownloader();

        expect(downloader.name).toBe('ffmpeg');
      });

      it('should return singleton instance', () => {
        const downloader1 = DownloaderFactory.getActiveDownloader('huya');
        const downloader2 = DownloaderFactory.getActiveDownloader('bilibili');

        expect(downloader1).toBe(downloader2);
      });
    });
  });
});
