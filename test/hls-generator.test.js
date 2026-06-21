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
            session_id: 20,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const generateSpy = jest.spyOn(hlsGenerator, 'generate').mockResolvedValue({
      success: true,
      playlistPath: '/data/video_downloads/2/20/hls_segment/playlist.m3u8',
    });

    const result = await hlsGenerator.generateForRecording(7);

    expect(result.success).toBe(true);
    expect(generateSpy).toHaveBeenCalledWith('/data/video_downloads/2/20/segment.ts', '/data/video_downloads/2/20', 20);
    expect(pool.query.mock.calls[1][0]).toContain('UPDATE recording_files SET is_hls_ready = TRUE');
    expect(pool.query.mock.calls[1][1]).toEqual(['/data/video_downloads/2/20/hls_segment/playlist.m3u8', 7]);
  });
});
