jest.mock('../server/db/index', () => ({
  query: jest.fn(),
}));

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

const fs = require('fs');
const pool = require('../server/db/index');
const hlsGenerator = require('../server/lib/core/hls-generator');

describe('HLSGenerator', () => {
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
    expect(pool.query.mock.calls[2][1]).toEqual(['/data/video_downloads/2/20/hls_segment/playlist.m3u8', 7]);
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
