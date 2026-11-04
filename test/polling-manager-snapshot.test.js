jest.mock('../server/db/index', () => ({
  query: jest.fn(),
}));

jest.mock('../server/db/redis', () => ({
  get: jest.fn(),
  setEx: jest.fn(),
}));

jest.mock('../server/lib/core/polling/checkers', () => ({}));
jest.mock('../server/services/RecorderService', () => ({
  startRecording: jest.fn(),
}));
jest.mock('../server/lib/core/notify', () => ({
  liveStart: jest.fn(),
  liveEnd: jest.fn(),
}));

const pool = require('../server/db/index');
const redis = require('../server/db/redis');
const pollingManager = require('../server/lib/core/polling/PollingManager');

describe('PollingManager dashboard snapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pollingManager.timers.clear();
    pollingManager.roomLiveStatus.clear();
    pollingManager.roomPollingMeta.clear();
    pollingManager._totalRooms = 0;
  });

  test('从内存 Map 生成平台轮询概览', () => {
    pollingManager._totalRooms = 4;
    pollingManager.roomPollingMeta.set(1, {
      platform: 'huya',
      roomName: '虎牙房间',
      roomUrl: 'https://www.huya.com/1',
    });
    pollingManager.roomPollingMeta.set(2, {
      platform: 'bilibili',
      roomName: 'B站房间',
      roomUrl: 'https://live.bilibili.com/2',
    });
    pollingManager.roomPollingMeta.set(3, {
      platform: 'huya',
      roomName: '虎牙房间2',
      roomUrl: 'https://www.huya.com/3',
    });
    pollingManager.roomLiveStatus.set(1, true);
    pollingManager.roomLiveStatus.set(2, false);
    pollingManager.roomLiveStatus.set(3, true);

    expect(pollingManager.getPollingSnapshot()).toEqual({
      total_polled: 3,
      total_rooms: 4,
      currently_live: 2,
      platform_breakdown: {
        huya: { total: 2, live: 2 },
        bilibili: { total: 1, live: 0 },
      },
    });
  });

  test('停止轮询时清理房间元数据', async () => {
    const timer = setInterval(() => {}, 1000);
    jest.spyOn(global, 'clearInterval');

    pollingManager.timers.set('room:9', timer);
    pollingManager.roomPollingMeta.set(9, {
      platform: 'douyu',
      roomName: '斗鱼房间',
      roomUrl: 'https://www.douyu.com/9',
    });

    await pollingManager.stopRoomPolling(9);

    expect(global.clearInterval).toHaveBeenCalledWith(timer);
    expect(pollingManager.timers.has('room:9')).toBe(false);
    expect(pollingManager.roomPollingMeta.has(9)).toBe(false);
  });

  test('加载轮询房间时恢复 Redis 直播状态并记录总数', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, room_url: 'https://www.huya.com/1', polling_platform: 'huya' },
        { id: 2, room_url: 'https://live.bilibili.com/2', polling_platform: 'bilibili' },
      ],
    });
    redis.get.mockImplementation(async (key) => {
      if (key === 'polling:live_status:1') {
        return JSON.stringify({ isLive: true });
      }
      return null;
    });

    const rooms = await pollingManager.loadPollingRooms();

    expect(rooms).toHaveLength(2);
    expect(pollingManager._totalRooms).toBe(2);
    expect(pollingManager.roomLiveStatus.get(1)).toBe(true);
    expect(pollingManager.roomLiveStatus.has(2)).toBe(false);
  });

  test('加载轮询房间时过滤小红书个人主页房间并自愈关闭轮询开关', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          { id: 1, room_url: 'https://www.huya.com/1', polling_platform: 'huya' },
          {
            id: 2,
            room_url: 'https://www.xiaohongshu.com/user/profile/5f849379000000000101e56e',
            polling_platform: 'xiaohongshu',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    redis.get.mockResolvedValue(null);

    const rooms = await pollingManager.loadPollingRooms();

    expect(rooms).toHaveLength(1);
    expect(rooms[0].id).toBe(1);
    expect(pollingManager._totalRooms).toBe(1);
    expect(pool.query).toHaveBeenLastCalledWith(expect.stringContaining('UPDATE rooms SET polling_enabled = false'), [
      [2],
    ]);
  });

  test('小红书个人主页房间不会建立轮询定时器', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    jest.spyOn(global, 'setInterval');

    await pollingManager.startRoomPolling({
      id: 7,
      room_url: 'https://www.xiaohongshu.com/user/profile/5f849379000000000101e56e',
      polling_platform: 'xiaohongshu',
      polling_interval: 60,
    });

    expect(global.setInterval).not.toHaveBeenCalled();
    expect(pollingManager.timers.has('room:7')).toBe(false);
    expect(pollingManager.roomPollingMeta.has(7)).toBe(false);
    expect(pool.query).toHaveBeenCalledWith('UPDATE rooms SET polling_enabled = false WHERE id = $1', [7]);
  });
});
