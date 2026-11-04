// ADR-021：小红书稳定身份（个人主页 / host_id）与单场 room_id 解析
const {
  parseXiaohongshuIdentity,
  buildXiaohongshuProfileUrl,
  buildXiaohongshuLiveUrl,
} = require('../server/lib/utils/room-identity');

describe('parseXiaohongshuIdentity', () => {
  test('个人主页解析出稳定 host_user_id', () => {
    const identity = parseXiaohongshuIdentity(
      'https://www.xiaohongshu.com/user/profile/5f849379000000000101e56e?xsec_token=x'
    );

    expect(identity).toEqual({
      hostUserId: '5f849379000000000101e56e',
      liveRoomId: null,
      isProfile: true,
      profileUrl: 'https://www.xiaohongshu.com/user/profile/5f849379000000000101e56e',
      liveUrl: null,
    });
  });

  test('直播间链接带 host_id 时同时得到目标与场次', () => {
    const identity = parseXiaohongshuIdentity(
      'https://www.xiaohongshu.com/livestream/570523582342626238?host_id=66c164b6aaaa&xsec_token=t'
    );

    expect(identity).toMatchObject({
      hostUserId: '66c164b6aaaa',
      liveRoomId: '570523582342626238',
      isProfile: false,
      liveUrl: 'https://www.xiaohongshu.com/livestream/570523582342626238',
    });
  });

  test('dynpath 直播间与 redelight 域名可解析', () => {
    expect(
      parseXiaohongshuIdentity('https://www.xiaohongshu.com/livestream/dynpathB/570523582342626238?hostId=h1')
    ).toMatchObject({ hostUserId: 'h1', liveRoomId: '570523582342626238' });

    expect(parseXiaohongshuIdentity('https://www.redelight.cn/livestream/570523582342626238')).toMatchObject({
      liveRoomId: '570523582342626238',
      hostUserId: null,
    });
  });

  test('分享文本中提取首个链接', () => {
    const identity = parseXiaohongshuIdentity(
      '看看这个直播 https://www.xiaohongshu.com/livestream/570523582342626238?host_id=abc 复制打开'
    );
    expect(identity).toMatchObject({ hostUserId: 'abc', liveRoomId: '570523582342626238' });
  });

  test('非小红书或无身份字段返回 null', () => {
    expect(parseXiaohongshuIdentity('https://www.huya.com/123')).toBeNull();
    expect(parseXiaohongshuIdentity('https://www.xiaohongshu.com/explore')).toBeNull();
    expect(parseXiaohongshuIdentity(null)).toBeNull();
  });
});

describe('小红书地址构造', () => {
  test('profile / live 地址与解析结果互逆', () => {
    const profileUrl = buildXiaohongshuProfileUrl('u1');
    const liveUrl = buildXiaohongshuLiveUrl('r1');

    expect(profileUrl).toBe('https://www.xiaohongshu.com/user/profile/u1');
    expect(liveUrl).toBe('https://www.xiaohongshu.com/livestream/r1');
    expect(parseXiaohongshuIdentity(profileUrl)).toMatchObject({ hostUserId: 'u1', profileUrl });
    expect(parseXiaohongshuIdentity(liveUrl)).toMatchObject({ liveRoomId: 'r1', liveUrl });
  });
});
