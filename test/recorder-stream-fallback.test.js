// 测 FLV HEVC 主流的降级选流（_findRecordableStream），RecorderService 重依赖全部 mock 掉
jest.mock('../server/lib/core/polling/checkers', () => ({
  fetchRoomCoverByUrl: jest.fn(),
}));
jest.mock('../server/db/index', () => ({
  query: jest.fn(async () => ({ rows: [] })),
}));
jest.mock('../server/db/redis', () => ({
  get: jest.fn(),
  set: jest.fn(),
  setEx: jest.fn(),
  del: jest.fn(),
  exists: jest.fn(async () => 0),
  keys: jest.fn(async () => []),
}));
// RecordingManager 单例构造时会启动 5 分钟 setInterval，必须 mock 避免 jest 挂起
jest.mock('../server/lib/core/RecordingManager', () => ({ __mockedSingleton: true }));

const RecorderService = require('../server/services/RecorderService');
const transcoder = require('../server/lib/core/transcoder');

describe('RecorderService._findRecordableStream', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('backupUrls 为空返回 null', async () => {
    await expect(RecorderService._findRecordableStream(null)).resolves.toBeNull();
    await expect(RecorderService._findRecordableStream('')).resolves.toBeNull();
  });

  it('m3u8 优先：即使 flv 排在前面，也优先探测并返回 m3u8', async () => {
    const order = [];
    jest.spyOn(transcoder, 'probeVideoTrack').mockImplementation(async (u) => {
      order.push(u);
      return { hasVideo: true, videoCodec: 'hevc', error: null };
    });

    const result = await RecorderService._findRecordableStream('http://a/bak.flv,http://a/main.m3u8,http://a/bak2.flv');

    expect(result).toBe('http://a/main.m3u8');
    expect(order[0]).toBe('http://a/main.m3u8');
  });

  it('探测失败的候选跳过，返回下一个明确含视频轨的流', async () => {
    jest
      .spyOn(transcoder, 'probeVideoTrack')
      .mockResolvedValueOnce({ hasVideo: true, videoCodec: null, error: 'probe-timeout' })
      .mockResolvedValueOnce({ hasVideo: true, videoCodec: 'h264', error: null });

    const result = await RecorderService._findRecordableStream('http://a/bak.flv,http://a/main.m3u8');

    expect(result).toBe('http://a/bak.flv');
  });

  it('全部候选都无视频轨返回 null', async () => {
    jest
      .spyOn(transcoder, 'probeVideoTrack')
      .mockResolvedValue({ hasVideo: false, videoCodec: null, error: 'flv-hevc-not-implemented' });

    const result = await RecorderService._findRecordableStream('http://a/bak.flv,http://a/main.m3u8');

    expect(result).toBeNull();
  });

  it('兼容数组形式的 backupUrls', async () => {
    jest.spyOn(transcoder, 'probeVideoTrack').mockResolvedValue({
      hasVideo: true,
      videoCodec: 'h264',
      error: null,
    });

    const result = await RecorderService._findRecordableStream(['http://a/bak.flv', 'http://a/main.m3u8']);

    expect(result).toBe('http://a/main.m3u8');
  });
});
