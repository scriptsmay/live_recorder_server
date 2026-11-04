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
const { detectPlatform, extractFirstUrlFromText } = require('../server/lib/utils/platform-detector');

describe('normalizeRoomUrl', () => {
  test('移除快手分享链接的 query string', () => {
    expect(
      normalizeRoomUrl('https://live.kuaishou.com/u/3xhpa8nk4a7xdg6?cc=share_wxms&shareMethod=CARD&userId=5226586503')
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

  test('支持从小红书分享口令文本提取短链并规范化', () => {
    const shareText =
      '小红书，你的生活指南#KPL王者荣耀职业联赛正在直播，来和我一起支持ta吧。 https://xhslink.com/o/6SoiafhhH6N 复制本条信息，打开【小红书】，直接观看直播！';
    expect(extractFirstUrlFromText(shareText)).toBe('https://xhslink.com/o/6SoiafhhH6N');
    expect(detectPlatform(shareText)).toBe('xiaohongshu');
    expect(normalizeRoomUrl(shareText)).toBe('https://xhslink.com/o/6SoiafhhH6N');
  });

  test('规范化小红书带 dynpath 防封段与 host_id 的直播间长链', () => {
    const longUrl =
      'https://www.xiaohongshu.com/livestream/dynpathxYjf2eb8/570523767964993440?timestamp=1793721783836&host_id=5f849379000000000101e56e&xsec_token=abc';
    expect(normalizeRoomUrl(longUrl)).toBe(
      'https://www.xiaohongshu.com/livestream/570523767964993440?host_id=5f849379000000000101e56e'
    );
  });

  test('规范化小红书个人主页链接并去除多余参数', () => {
    const profileUrl =
      'https://www.xiaohongshu.com/user/profile/5f849379000000000101e56e?xsec_token=abc&xsec_source=app_share';
    expect(normalizeRoomUrl(profileUrl)).toBe('https://www.xiaohongshu.com/user/profile/5f849379000000000101e56e');
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
