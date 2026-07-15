jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/services/DataService', () => ({ getSetting: jest.fn() }));
jest.mock('../server/services/UploadService', () => ({ scanPendingAutoUpload: jest.fn() }));
jest.mock('../server/lib/core/downloaders/DownloaderFactory', () => ({ getActiveDownloader: jest.fn() }));
jest.mock('../server/lib/core/scan-files', () => ({ scanRecordingFiles: jest.fn() }));
jest.mock('../server/lib/core/TranscodeQueue', () => ({ enqueue: jest.fn() }));
jest.mock('../server/lib/core/hls-generator', () => ({ generateForRecording: jest.fn() }));

const fs = require('fs');
const pool = require('../server/db/index');
const DataService = require('../server/services/DataService');
const hlsGenerator = require('../server/lib/core/hls-generator');
const { checkSessionHLS } = require('../server/lib/core/watchdog');

describe('watchdog HLS lifecycle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('只查询 pending/ready；ready 丢失标记 missing，pending 才自动生成', async () => {
    DataService.getSetting.mockResolvedValue('true');
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            file_path: '/data/video_downloads/ready.mp4',
            hls_playlist_path: '/data/video_downloads/hls_ready/playlist.m3u8',
            hls_status: 'ready',
          },
          {
            id: 2,
            file_path: '/data/video_downloads/pending.mp4',
            hls_playlist_path: null,
            hls_status: 'pending',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    jest.spyOn(fs, 'existsSync').mockReturnValueOnce(false).mockReturnValueOnce(true);
    hlsGenerator.generateForRecording.mockResolvedValue({ success: true });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});

    await checkSessionHLS();

    expect(pool.query.mock.calls[0][0]).toContain("rf.hls_status IN ('pending', 'ready')");
    expect(pool.query.mock.calls[1][0]).toContain("hls_status = 'missing'");
    expect(hlsGenerator.generateForRecording).toHaveBeenCalledTimes(1);
    expect(hlsGenerator.generateForRecording).toHaveBeenCalledWith(2);
  });
});
