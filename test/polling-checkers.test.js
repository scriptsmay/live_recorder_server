// 用轻量 mock 类替换五个真实 checker：保留各自的 canHandleUrl 模式，
// checkStatus 通过共享 jest.fn 控制，用于验证 resolveCheckerByUrl / fetchRoomCoverByUrl
function mockCheckerFactory(urlPattern) {
  const checkStatus = jest.fn();
  const CheckerClass = jest.fn().mockImplementation(function (_roomUrl) {
    this.checkStatus = checkStatus;
  });
  CheckerClass.canHandleUrl = (url) => urlPattern.test(url || '');
  CheckerClass._mockCheckStatus = checkStatus;
  return CheckerClass;
}

jest.mock('../server/lib/core/polling/HuyaChecker', () =>
  mockCheckerFactory(/huya\.com/i)
);
jest.mock('../server/lib/core/polling/BilibiliChecker', () =>
  mockCheckerFactory(/live\.bilibili\.com/i)
);
jest.mock('../server/lib/core/polling/DouyuChecker', () =>
  mockCheckerFactory(/douyu\.com/i)
);
jest.mock('../server/lib/core/polling/DouyinChecker', () =>
  mockCheckerFactory(/douyin\.com/i)
);
jest.mock('../server/lib/core/polling/KuaishouAPIChecker', () =>
  mockCheckerFactory(/(?:^|\.)kuaishou\.com/i)
);

const checkers = require('../server/lib/core/polling/checkers');
const HuyaChecker = require('../server/lib/core/polling/HuyaChecker');
const BilibiliChecker = require('../server/lib/core/polling/BilibiliChecker');
const DouyuChecker = require('../server/lib/core/polling/DouyuChecker');
const DouyinChecker = require('../server/lib/core/polling/DouyinChecker');
const KuaishouAPIChecker = require('../server/lib/core/polling/KuaishouAPIChecker');

describe('checkers.resolveCheckerByUrl', () => {
  it.each([
    ['https://www.huya.com/721931', HuyaChecker],
    ['https://live.bilibili.com/123', BilibiliChecker],
    ['https://www.douyu.com/456', DouyuChecker],
    ['https://live.douyin.com/789', DouyinChecker],
    ['https://www.kuaishou.com/abc', KuaishouAPIChecker],
  ])('should resolve %s', (url, Checker) => {
    expect(checkers.resolveCheckerByUrl(url)).toBe(Checker);
  });

  it('should return null for unsupported or empty URL', () => {
    expect(checkers.resolveCheckerByUrl('https://example.com/live')).toBeNull();
    expect(checkers.resolveCheckerByUrl('')).toBeNull();
    expect(checkers.resolveCheckerByUrl(null)).toBeNull();
  });
});

describe('checkers.fetchRoomCoverByUrl', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return roomCover from checker status', async () => {
    HuyaChecker._mockCheckStatus.mockResolvedValueOnce({
      isLive: true,
      roomCover: 'https://huya-img.msstatic.com/livecover.jpg',
    });

    const cover = await checkers.fetchRoomCoverByUrl('https://www.huya.com/721931');

    expect(cover).toBe('https://huya-img.msstatic.com/livecover.jpg');
    expect(HuyaChecker).toHaveBeenCalledWith('https://www.huya.com/721931');
  });

  it('should resolve checker by URL (API 触发无 cover_url 的自取路径)', async () => {
    KuaishouAPIChecker._mockCheckStatus.mockResolvedValueOnce({
      isLive: true,
      roomCover: 'https://p1-pro.a.kwimgs.com/cover.jpg',
    });

    const cover = await checkers.fetchRoomCoverByUrl('https://www.kuaishou.com/abc');

    expect(cover).toBe('https://p1-pro.a.kwimgs.com/cover.jpg');
  });

  it('should return empty string when checker throws (checker 挂，不阻塞调用方)', async () => {
    HuyaChecker._mockCheckStatus.mockRejectedValueOnce(new Error('Network error'));

    await expect(checkers.fetchRoomCoverByUrl('https://www.huya.com/721931')).resolves.toBe('');
  });

  it('should return empty string when status has no roomCover', async () => {
    HuyaChecker._mockCheckStatus.mockResolvedValueOnce({ isLive: true, roomCover: '' });

    const cover = await checkers.fetchRoomCoverByUrl('https://www.huya.com/721931');

    expect(cover).toBe('');
  });

  it('should return empty string when no checker matches', async () => {
    const cover = await checkers.fetchRoomCoverByUrl('https://example.com/live');

    expect(cover).toBe('');
    expect(HuyaChecker._mockCheckStatus).not.toHaveBeenCalled();
  });
});
