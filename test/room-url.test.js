jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({
  get: jest.fn(),
  setEx: jest.fn(),
  del: jest.fn(),
  exists: jest.fn(),
  keys: jest.fn(),
}));
jest.mock('../server/lib/core/RecordingManager', () => ({}));

const { normalizeRoomUrl } = require('../server/lib/utils/room-url');

describe('normalizeRoomUrl', () => {
  test('移除快手分享链接的 query string', () => {
    expect(
      normalizeRoomUrl(
        'https://live.kuaishou.com/u/3xhpa8nk4a7xdg6?cc=share_wxms&shareMethod=CARD&userId=5226586503'
      )
    ).toBe('https://live.kuaishou.com/u/3xhpa8nk4a7xdg6');
  });

  test('移除 fragment 并处理 fragment 在 query 前的地址', () => {
    expect(normalizeRoomUrl('https://www.huya.com/123#player?from=share')).toBe('https://www.huya.com/123');
  });

  test('保留无参数地址的原始路径并清理首尾空白', () => {
    expect(normalizeRoomUrl('  https://live.bilibili.com/456  ')).toBe('https://live.bilibili.com/456');
  });

  test('保留抖音 query-only 直播间的 web_rid 身份参数', () => {
    expect(normalizeRoomUrl('https://live.douyin.com/?web_rid=123456&from=share#player')).toBe(
      'https://live.douyin.com/?web_rid=123456'
    );
  });

  test('非字符串值保持不变', () => {
    expect(normalizeRoomUrl(null)).toBeNull();
  });
});

describe('RecorderService room URL normalization', () => {
  const originalDownloadDir = process.env.VIDEO_DOWNLOAD_DIR;
  let RecorderService;

  beforeAll(() => {
    process.env.VIDEO_DOWNLOAD_DIR = '/tmp';
    jest.resetModules();
    RecorderService = require('../server/services/RecorderService');
  });

  afterAll(() => {
    if (originalDownloadDir === undefined) {
      delete process.env.VIDEO_DOWNLOAD_DIR;
    } else {
      process.env.VIDEO_DOWNLOAD_DIR = originalDownloadDir;
    }
  });

  test('通知入口使用无 query 的地址检查活跃任务', async () => {
    const activeTaskSpy = jest.spyOn(RecorderService, 'isActiveTask').mockResolvedValue(true);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await RecorderService.startRecording({
      url: 'https://cdn.example/live.flv',
      title: '测试直播间',
      room_url: 'https://live.kuaishou.com/u/3xhpa8nk4a7xdg6?cc=share_wxms&shareMethod=CARD',
    });

    expect(activeTaskSpy).toHaveBeenCalledWith('https://live.kuaishou.com/u/3xhpa8nk4a7xdg6');
    expect(result).toMatchObject({ error: true, status_str: 'Already recording' });

    activeTaskSpy.mockRestore();
    logSpy.mockRestore();
  });
});
