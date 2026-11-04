// ADR-021 Phase 1：录制目标解析（host_user_id 归并 / 场次字段写入 / 下播清理）
jest.mock('../server/db/index', () => ({ query: jest.fn() }));

const pool = require('../server/db/index');
const RoomTargetService = require('../server/services/RoomTargetService');

const PROFILE_URL = 'https://www.xiaohongshu.com/user/profile/66c164b6aaaa';
const LIVE_URL = 'https://www.xiaohongshu.com/livestream/570523582342626238';
const RAW_LIVE_URL = `${LIVE_URL}?host_id=66c164b6aaaa&xsec_token=t`;

function roomRow(overrides = {}) {
  return {
    id: 12,
    room_url: PROFILE_URL,
    room_name: '主播',
    polling_platform: 'xiaohongshu',
    host_user_id: '66c164b6aaaa',
    live_room_id: '',
    live_url: '',
    deleted_at: null,
    ...overrides,
  };
}

describe('RoomTargetService.resolve', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('带 host_id 的直播间链接落到个人主页目标并写入本场字段', async () => {
    const created = roomRow({ live_room_id: '570523582342626238', live_url: LIVE_URL });
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // 活跃目标（按 host）
      .mockResolvedValueOnce({ rows: [] }) // 含软删目标（按 host）
      .mockResolvedValueOnce({ rows: [] }) // 按目标 URL
      .mockResolvedValueOnce({ rows: [created] }); // INSERT

    const room = await RoomTargetService.resolve({
      roomUrl: RAW_LIVE_URL,
      roomName: '主播',
    });

    expect(room).toBe(created);
    const insertCall = pool.query.mock.calls[3];
    expect(insertCall[0]).toContain('INSERT INTO rooms');
    expect(insertCall[1]).toEqual([PROFILE_URL, '主播', 'xiaohongshu', '66c164b6aaaa', '570523582342626238', LIVE_URL]);
  });

  test('已存在主播目标时复用并只补充本场字段，不新建房间', async () => {
    const existing = roomRow();
    const updated = roomRow({ live_room_id: '570523582342626238', live_url: LIVE_URL });
    pool.query.mockResolvedValueOnce({ rows: [existing] }).mockResolvedValueOnce({ rows: [updated] });

    const room = await RoomTargetService.resolve({
      roomUrl: RAW_LIVE_URL,
      roomName: '主播',
    });

    expect(room).toBe(updated);
    expect(pool.query).toHaveBeenCalledTimes(2);
    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toContain('UPDATE rooms');
    expect(sql).toContain('live_room_id');
    expect(sql).toContain('live_url');
    expect(params).toContain('570523582342626238');
    expect(params).toContain(LIVE_URL);
    expect(pool.query.mock.calls.some(([q]) => q.includes('INSERT INTO rooms'))).toBe(false);
  });

  test('请求不带 host_user_id 时按本场 live_room_id 归并到已有主播目标', async () => {
    const stableTarget = roomRow({
      id: 26,
      room_url: 'https://www.xiaohongshu.com/user/profile/5c2f2f8c000000000701d3dd',
      host_user_id: '5c2f2f8c000000000701d3dd',
      live_room_id: '570523582342626238',
      live_url: LIVE_URL,
    });
    pool.query.mockResolvedValueOnce({ rows: [stableTarget] });

    // 手动录制链路只带直播间地址，无法从 URL 反推 host（无 host_id 参数）
    const room = await RoomTargetService.resolve({
      roomUrl: LIVE_URL,
      roomName: '主播',
    });

    expect(room).toBe(stableTarget);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('live_room_id = $1');
    expect(sql).toContain("host_user_id <> ''");
    expect(params).toEqual(['570523582342626238']);
    expect(pool.query.mock.calls.some(([q]) => q.includes('INSERT INTO rooms'))).toBe(false);
  });

  test('非小红书平台继续以规范化 URL 为身份', async () => {
    const created = {
      id: 3,
      room_url: 'https://live.bilibili.com/999',
      room_name: 'B站',
      polling_platform: 'bilibili',
      host_user_id: '',
      live_room_id: '',
      live_url: '',
      deleted_at: null,
    };
    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [created] });

    const room = await RoomTargetService.resolve({
      roomUrl: 'https://live.bilibili.com/999?spm=abc',
      roomName: 'B站',
    });

    expect(room).toBe(created);
    const insertCall = pool.query.mock.calls[1];
    expect(insertCall[1]).toEqual(['https://live.bilibili.com/999', 'B站', 'bilibili', '', '', '']);
  });
});

describe('RoomTargetService.clearLiveState', () => {
  beforeEach(() => jest.clearAllMocks());

  test('下播后只清场次字段，不触碰目标配置', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    await RoomTargetService.clearLiveState(12);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("live_room_id = '', live_url = ''");
    expect(sql).not.toContain('deleted_at');
    expect(params).toEqual([12]);
  });

  test('roomId 为空时跳过数据库操作', async () => {
    await RoomTargetService.clearLiveState(null);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
