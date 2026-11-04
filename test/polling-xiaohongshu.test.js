'use strict';

const PlatformChecker = require('../server/lib/core/polling/PlatformChecker');
const XiaohongshuChecker = require('../server/lib/core/polling/XiaohongshuChecker');

describe('XiaohongshuChecker', () => {
  const originalFetch = global.fetch;
  const originalEnabled = process.env.XIAOHONGSHU_CHECKER_ENABLED;

  beforeEach(() => {
    jest.restoreAllMocks();
    delete process.env.XIAOHONGSHU_CHECKER_ENABLED;
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (originalEnabled === undefined) {
      delete process.env.XIAOHONGSHU_CHECKER_ENABLED;
    } else {
      process.env.XIAOHONGSHU_CHECKER_ENABLED = originalEnabled;
    }
  });

  test('canHandleUrl 识别小红书主站、短链、口令文本与 redelight', () => {
    expect(XiaohongshuChecker.getPlatformId()).toBe('xiaohongshu');
    expect(XiaohongshuChecker.canHandleUrl('https://www.xiaohongshu.com/livestream/570523767964993440')).toBe(true);
    expect(XiaohongshuChecker.canHandleUrl('https://xhslink.com/o/6SoiafhhH6N')).toBe(true);
    expect(
      XiaohongshuChecker.canHandleUrl('小红书，你的生活指南#KPL正在直播 https://xhslink.com/o/6SoiafhhH6N 复制本条信息')
    ).toBe(true);
    expect(XiaohongshuChecker.canHandleUrl('https://www.redelight.cn/hina/livestream/570523767964993440')).toBe(true);
    expect(XiaohongshuChecker.canHandleUrl('https://live.bilibili.com/123')).toBe(false);
    expect(XiaohongshuChecker.canHandleUrl('')).toBe(false);
  });

  test('parseUrlIdentifiers 解析 dynpath 直播间链接与个人主页链接', () => {
    const liveParsed = XiaohongshuChecker.parseUrlIdentifiers(
      'https://www.xiaohongshu.com/livestream/dynpathxYjf2eb8/570523767964993440?host_id=5f849379000000000101e56e&xsec_token=abc'
    );
    expect(liveParsed).toEqual({
      roomId: '570523767964993440',
      hostId: '5f849379000000000101e56e',
      isProfileUrl: false,
      canonicalUrl: 'https://www.xiaohongshu.com/livestream/570523767964993440',
    });

    const profileParsed = XiaohongshuChecker.parseUrlIdentifiers(
      'https://www.xiaohongshu.com/user/profile/5f849379000000000101e56e?xsec_token=xyz'
    );
    expect(profileParsed).toEqual({
      roomId: null,
      hostId: '5f849379000000000101e56e',
      isProfileUrl: true,
      canonicalUrl: 'https://www.xiaohongshu.com/user/profile/5f849379000000000101e56e',
    });
  });

  test('resolveShortUrl 使用 GET manual 跟随 xhslink 302 跳转', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      status: 302,
      headers: {
        get: (name) =>
          name.toLowerCase() === 'location'
            ? 'https://www.xiaohongshu.com/livestream/dynpathxYjf2eb8/570523767964993440?host_id=5f849379000000000101e56e'
            : null,
      },
    });

    const resolved = await XiaohongshuChecker.resolveShortUrl(
      '小红书，你的生活指南#KPL正在直播 https://xhslink.com/o/6SoiafhhH6N 复制本条信息'
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://xhslink.com/o/6SoiafhhH6N',
      expect.objectContaining({ method: 'GET', redirect: 'manual' })
    );
    expect(resolved).toBe(
      'https://www.xiaohongshu.com/livestream/dynpathxYjf2eb8/570523767964993440?host_id=5f849379000000000101e56e'
    );
  });

  test('checkStatus 在播时从 SSR __INITIAL_STATE__ 提取 FLV 主流、备流与主播信息', async () => {
    const ssrHtml = `<!DOCTYPE html><html><body><script>window.__INITIAL_STATE__={
      "liveStream": {
        "pageStatus": "success",
        "liveStatus": "success",
        "roomData": {
          "hostInfo": {
            "nickName": "KPL王者荣耀职业联赛",
            "avatar": "https://sns-avatar-qc.xhscdn.com/avatar/kpl.jpg"
          },
          "roomInfo": {
            "roomId": "570523767964993440",
            "roomTitle": "【重播】4日18点 TTG vs 狼队",
            "status": 2,
            "roomCover": "https://sns-na-i4.xhscdn.com/alpha_image/cover.webp",
            "pullConfig": JSON.stringify({
              "h265": [],
              "h264": [
                { "master_url": "http://live-source-play.xhscdn.com/live/570523767964993440.m3u8", "quality_type": "HD" },
                { "master_url": "http://live-source-play.xhscdn.com/live/570523767964993440.flv", "quality_type": "HD" },
                { "master_url": "http://live-source-play-bak-tx.xhscdn.com/live/570523767964993440.flv", "quality_type": "HD" }
              ],
              "width": 1920,
              "height": 1080
            }),
            "deeplink": "xhsdiscover://live_audience?room_id=570523767964993440&flvUrl=http%3A%2F%2Flive.xhscdn.com%2Flive%2F570523767964993440.flv&host_id=5f849379000000000101e56e"
          }
        }
      }
    }</script></body></html>`.replace(
      'JSON.stringify({\n              "h265": [],\n              "h264": [\n                { "master_url": "http://live-source-play.xhscdn.com/live/570523767964993440.m3u8", "quality_type": "HD" },\n                { "master_url": "http://live-source-play.xhscdn.com/live/570523767964993440.flv", "quality_type": "HD" },\n                { "master_url": "http://live-source-play-bak-tx.xhscdn.com/live/570523767964993440.flv", "quality_type": "HD" }\n              ],\n              "width": 1920,\n              "height": 1080\n            })',
      JSON.stringify(
        JSON.stringify({
          h265: [],
          h264: [
            { master_url: 'http://live-source-play.xhscdn.com/live/570523767964993440.m3u8', quality_type: 'HD' },
            { master_url: 'http://live-source-play.xhscdn.com/live/570523767964993440.flv', quality_type: 'HD' },
            {
              master_url: 'http://live-source-play-bak-tx.xhscdn.com/live/570523767964993440.flv',
              quality_type: 'HD',
            },
          ],
          width: 1920,
          height: 1080,
        })
      )
    );

    jest.spyOn(PlatformChecker, 'fetchText').mockResolvedValueOnce(ssrHtml);

    const checker = new XiaohongshuChecker('https://www.xiaohongshu.com/livestream/570523767964993440');
    const result = await checker.checkStatus();

    expect(result).toEqual({
      isLive: true,
      recordable: true,
      roomName: 'KPL王者荣耀职业联赛',
      roomTitle: '【重播】4日18点 TTG vs 狼队',
      roomCover: 'https://sns-na-i4.xhscdn.com/alpha_image/cover.webp',
      avatarUrl: 'https://sns-avatar-qc.xhscdn.com/avatar/kpl.jpg',
      streamUrl: 'http://live-source-play.xhscdn.com/live/570523767964993440.flv',
      streamInfo: {
        roomId: '570523767964993440',
        hostId: '5f849379000000000101e56e',
        backupUrls:
          'http://live-source-play-bak-tx.xhscdn.com/live/570523767964993440.flv,http://live-source-play.xhscdn.com/live/570523767964993440.m3u8',
      },
      error: null,
    });
  });

  test('checkStatus 下播时（liveStatus=end, status=5）返回 isLive=false 且忽略 nextRoomInfo', async () => {
    const endedHtml = `<!DOCTYPE html><html><body><script>window.__INITIAL_STATE__={
      "liveStream": {
        "pageStatus": "success",
        "liveStatus": "end",
        "roomData": {
          "hostInfo": { "nickName": "是恩呢" },
          "roomInfo": { "roomId": "569077534207413574", "roomTitle": "吃宵夜咯宝宝们", "status": 5 }
        },
        "nextRoomInfo": { "nickName": "其他随机主播", "roomId": "570525622383993812" }
      }
    }</script></body></html>`;

    jest.spyOn(PlatformChecker, 'fetchText').mockResolvedValueOnce(endedHtml);

    const checker = new XiaohongshuChecker('https://www.xiaohongshu.com/livestream/569077534207413574');
    const result = await checker.checkStatus();

    expect(result.isLive).toBe(false);
    expect(result.roomName).toBe('是恩呢');
    expect(result.streamUrl).toBeNull();
  });

  test('checkStatus 传入个人主页 URL 时提取主播昵称与头像并返回 isLive=false、recordable=false', async () => {
    const profileHtml = `<!DOCTYPE html><html><body><script>window.__INITIAL_STATE__={
      "user": {
        "userPageData": {
          "basicInfo": {
            "nickname": "成都AG超玩会染详",
            "images": "https://sns-avatar-qc.xhscdn.com/avatar/ag.jpg",
            "optional": undefined
          }
        }
      }
    }</script></body></html>`;

    jest.spyOn(XiaohongshuChecker, 'fetchProfileHtml').mockResolvedValueOnce(profileHtml);

    const checker = new XiaohongshuChecker('https://www.xiaohongshu.com/user/profile/635639e10000000018028e12');
    const result = await checker.checkStatus();

    expect(result).toEqual({
      isLive: false,
      recordable: false,
      roomName: '成都AG超玩会染详',
      roomTitle: '',
      roomCover: 'https://sns-avatar-qc.xhscdn.com/avatar/ag.jpg',
      avatarUrl: 'https://sns-avatar-qc.xhscdn.com/avatar/ag.jpg',
      streamUrl: null,
      streamInfo: {
        hostId: '635639e10000000018028e12',
        isProfileUrl: true,
        note: '小红书每次开播生成独立 room_id，个人主页链接仅用于预登记主播信息，无法免登录轮询开播状态；开播时请使用直播间分享链接（xhslink.com 或 /livestream/{room_id}）',
      },
      error: null,
    });
  });

  test('XIAOHONGSHU_CHECKER_ENABLED=false 时跳过网络请求', async () => {
    process.env.XIAOHONGSHU_CHECKER_ENABLED = 'false';
    const checker = new XiaohongshuChecker('https://www.xiaohongshu.com/livestream/570523767964993440');
    const result = await checker.checkStatus();
    expect(result.isLive).toBe(false);
    expect(result.recordable).toBe(false);
    expect(result.error).toMatch(/disabled/i);
  });
});
