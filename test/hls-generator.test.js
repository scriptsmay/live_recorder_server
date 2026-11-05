// HLS 生成：HEVC 输入重编码 H.264（避免 hls.js 无法解码导致播放黑屏）
jest.mock('../server/db/index', () => ({
  query: jest.fn(),
}));

jest.mock('child_process', () => ({ spawn: jest.fn() }));

jest.mock('../server/lib/utils/proc-log', () => ({
  createProcLog: jest.fn(() => ({
    stream: { write: jest.fn() },
    logPath: '/tmp/hls.log',
    destroy: jest.fn(),
  })),
}));

jest.mock('../server/lib/utils/directory-stats', () => ({
  getDirectoryStats: jest.fn().mockResolvedValue({ size: 4096, mtime: new Date('2026-07-16T00:00:00Z') }),
}));

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const pool = require('../server/db/index');
const hlsGenerator = require('../server/lib/core/hls-generator');

function makeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

describe('HLSGenerator.generate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    jest.spyOn(fs, 'statSync').mockReturnValue({ size: 1024 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** mock ffprobe（探测 codec）+ ffmpeg（HLS 生成，退出码 0）。 */
  function mockSpawn({ codec = 'h264', probeCode = 0, ffmpegCode = 0 } = {}) {
    const probeChild = makeChild();
    const ffmpegChild = makeChild();
    spawn.mockImplementation((cmd) => {
      if (cmd === 'ffprobe') {
        setImmediate(() => {
          if (probeCode === 0) {
            probeChild.stdout.emit('data', JSON.stringify({ streams: [{ codec_name: codec }] }));
          }
          probeChild.emit('close', probeCode);
        });
        return probeChild;
      }
      setImmediate(() => ffmpegChild.emit('close', ffmpegCode));
      return ffmpegChild;
    });
    return { probeChild, ffmpegChild };
  }

  test('H.264 输入用 -c copy 无损切片', async () => {
    mockSpawn({ codec: 'h264' });

    const result = await hlsGenerator.generate('/data/videos/seg.ts', '/data/videos', 1);

    expect(result.success).toBe(true);
    const args = spawn.mock.calls.find((c) => c[0] === 'ffmpeg')[1];
    expect(args).toContain('-c');
    expect(args).toContain('copy');
    expect(args).not.toContain('libx264');
  });

  test('HEVC 输入重编码为 H.264（libx264），保证浏览器 hls.js 可播', async () => {
    mockSpawn({ codec: 'hevc' });

    const result = await hlsGenerator.generate('/data/videos/hevc_seg.ts', '/data/videos', 1);

    expect(result.success).toBe(true);
    const args = spawn.mock.calls.find((c) => c[0] === 'ffmpeg')[1];
    expect(args).toContain('-c:v');
    expect(args).toContain('libx264');
    expect(args).toContain('hls');
    expect(args).not.toContain('copy');
  });

  test('编码探测失败（ffprobe 非零退出）回退到 copy，不误伤正常录制', async () => {
    mockSpawn({ codec: 'hevc', probeCode: 1 });

    const result = await hlsGenerator.generate('/data/videos/seg.ts', '/data/videos', 1);

    expect(result.success).toBe(true);
    const args = spawn.mock.calls.find((c) => c[0] === 'ffmpeg')[1];
    expect(args).toContain('copy');
  });
});

describe('HLSGenerator.generateForRecording', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('generateForRecording 使用 recording.session_id 生成日志标识并更新状态', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            file_path: '/data/video_downloads/2/20/segment.ts',
            is_hls_ready: false,
            hls_playlist_path: '',
            hls_status: 'pending',
            session_id: 20,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ session_id: 20 }] })
      .mockResolvedValueOnce({ rows: [] });
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const generateSpy = jest.spyOn(hlsGenerator, 'generate').mockResolvedValue({
      success: true,
      playlistPath: '/data/video_downloads/2/20/hls_segment/playlist.m3u8',
    });

    const result = await hlsGenerator.generateForRecording(7);

    expect(result.success).toBe(true);
    expect(generateSpy).toHaveBeenCalledWith('/data/video_downloads/2/20/segment.ts', '/data/video_downloads/2/20', 20);
    expect(pool.query.mock.calls[1][0]).toContain("hls_status = 'generating'");
    expect(pool.query.mock.calls[2][0]).toContain("hls_status = 'ready'");
  });

  test('手动生成允许 expired 状态恢复为 ready', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            file_path: '/data/video_downloads/20/segment.ts',
            is_hls_ready: false,
            hls_playlist_path: null,
            hls_status: 'expired',
            session_id: 20,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 8 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ session_id: 20 }] })
      .mockResolvedValueOnce({ rows: [] });
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(hlsGenerator, 'generate').mockResolvedValue({
      success: true,
      playlistPath: '/data/video_downloads/20/hls_segment/playlist.m3u8',
    });

    const result = await hlsGenerator.generateForRecording(8, { manual: true });

    expect(result.success).toBe(true);
    expect(pool.query.mock.calls[1][1][1]).toContain('expired');
    expect(pool.query.mock.calls[2][0]).toContain("hls_status = 'ready'");
  });
});
