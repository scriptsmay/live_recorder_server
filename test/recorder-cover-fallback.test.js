// 只测封面解析兜底（_resolveRecordingCover），RecorderService 的重依赖全部 mock 掉
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
const { fetchRoomCoverByUrl } = require('../server/lib/core/polling/checkers');

describe('RecorderService._resolveRecordingCover', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('调用方已带封面时不触发自取（轮询路径零开销）', async () => {
    const cover = await RecorderService._resolveRecordingCover({
      roomCover: 'https://huya-img.msstatic.com/livecover.jpg',
      roomUrl: 'https://www.huya.com/721931',
    });

    expect(cover).toBe('https://huya-img.msstatic.com/livecover.jpg');
    expect(fetchRoomCoverByUrl).not.toHaveBeenCalled();
  });

  it('API 触发无 cover_url 时按房间 URL 自取', async () => {
    fetchRoomCoverByUrl.mockResolvedValueOnce('https://huya-img.msstatic.com/fallback.jpg');

    const cover = await RecorderService._resolveRecordingCover({
      roomCover: '',
      roomUrl: 'https://www.huya.com/721931',
    });

    expect(fetchRoomCoverByUrl).toHaveBeenCalledWith('https://www.huya.com/721931');
    expect(cover).toBe('https://huya-img.msstatic.com/fallback.jpg');
  });

  it('自取失败返回空串，不抛错、不影响录制启动', async () => {
    fetchRoomCoverByUrl.mockResolvedValueOnce('');

    const cover = await RecorderService._resolveRecordingCover({
      roomCover: '',
      roomUrl: 'https://www.kuaishou.com/abc',
    });

    expect(cover).toBe('');
  });
});
