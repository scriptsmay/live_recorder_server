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
const RoomTargetService = require('../server/services/RoomTargetService');
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

describe('RecorderService._deriveBackupUrls', () => {
  it('小红书 _hcv HEVC FLV 主流派生出同 CDN 与主节点的 m3u8 及去掉 _hcv 的 H.264 FLV 备份流', () => {
    const urls = RecorderService._deriveBackupUrls(
      'https://live-source-play-hw.xhscdn.com/live/570528044501046832_hcv540.flv?userId=abc&abr_pts=-3000'
    );

    expect(urls).toEqual([
      'http://live-source-play-hw.xhscdn.com/live/570528044501046832.m3u8',
      'http://live-source-play.xhscdn.com/live/570528044501046832.m3u8',
      'http://live-source-play-hw.xhscdn.com/live/570528044501046832.flv',
      'http://live-source-play.xhscdn.com/live/570528044501046832.flv',
    ]);
  });

  it('普通 FLV 主流（含大写 .FLV）派生同 CDN 与主节点的 m3u8 备份流', () => {
    const urls = RecorderService._deriveBackupUrls('http://live-source-play-hw.xhscdn.com/live/570528044501046832.FLV');

    expect(urls).toEqual([
      'http://live-source-play-hw.xhscdn.com/live/570528044501046832.m3u8',
      'http://live-source-play.xhscdn.com/live/570528044501046832.m3u8',
    ]);
  });

  it('非小红书 CDN 地址返回空数组', () => {
    expect(RecorderService._deriveBackupUrls('http://example.com/live/abc.flv')).toEqual([]);
    expect(RecorderService._deriveBackupUrls('')).toEqual([]);
  });
});

describe('RecorderService.startRecording FLV HEVC 预检与兜底', () => {
  beforeEach(() => {
    jest.spyOn(RoomTargetService, 'resolve').mockResolvedValue({
      id: 42,
      room_url: 'https://live.kuaishou.com/u/test_user',
      room_name: '测试直播间',
      monitoring_enabled: true,
      status: 'idle',
    });
    jest.spyOn(RecorderService, 'isActiveTask').mockResolvedValue(false);
    jest.spyOn(RecorderService, 'getPoolSize').mockResolvedValue(5);
    jest.spyOn(RecorderService, 'getActiveTasksCount').mockResolvedValue(0);
    jest.spyOn(RecorderService, 'startRoomRecording').mockResolvedValue({ status: 200, code: 0 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('flv-hevc-unrecordable（FFmpeg 9.0+ 可识别视频轨）且无可用降级流时，兜底继续录制主流而非误拒', async () => {
    jest.spyOn(transcoder, 'probeVideoTrack').mockResolvedValue({
      hasVideo: true,
      videoCodec: 'hevc',
      error: 'flv-hevc-unrecordable',
    });

    await RecorderService.startRecording({
      url: 'https://pull.kuaishou.com/live/stream_hevc.flv',
      room_url: 'https://live.kuaishou.com/u/test_user',
      title: '测试直播间',
      caption: '标题',
    });

    expect(RecorderService.startRoomRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 42,
        url: 'https://pull.kuaishou.com/live/stream_hevc.flv',
      })
    );
  });

  it('flv-hevc-not-implemented（旧版 FFmpeg 丢弃视频轨）且无可用降级流时，拒绝录制', async () => {
    jest.spyOn(transcoder, 'probeVideoTrack').mockResolvedValue({
      hasVideo: false,
      videoCodec: null,
      error: 'flv-hevc-not-implemented',
    });

    const res = await RecorderService.startRecording({
      url: 'https://pull.kuaishou.com/live/stream_hevc.flv',
      room_url: 'https://live.kuaishou.com/u/test_user',
      title: '测试直播间',
      caption: '标题',
    });

    expect(res).toEqual(
      expect.objectContaining({
        error: true,
        status_str: 'Unsupported codec',
      })
    );
    expect(RecorderService.startRoomRecording).not.toHaveBeenCalled();
  });
});
