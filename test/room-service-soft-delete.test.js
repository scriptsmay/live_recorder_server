// v1.12.0：RoomService 软删除语义回归
// - deleteRoom 打标记而非物理删除，连带会话软删，房间缓存与活跃任务键一并失效
// - 已软删房间二次删除返回 404，且不再 process.kill 残留 ffmpeg_pid（PID 可能已被复用）
// - upsertRoom 对软删同名房间走复活语义（rooms.room_url 有外键依赖，保留全表唯一约束）
jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({
  del: jest.fn().mockResolvedValue(),
  get: jest.fn(),
  setEx: jest.fn(),
}));
jest.mock('../server/services/DataService', () => ({ getRoomByUrl: jest.fn() }));
jest.mock('../server/lib/core/scan-files', () => ({ scanRecordingFiles: jest.fn() }));

const RoomService = require('../server/services/RoomService');
const pool = require('../server/db/index');
const redis = require('../server/db/redis');

const ROOM_URL = 'https://www.huya.com/123';

function mockRoomRow(overrides = {}) {
  return { id: 7, room_url: ROOM_URL, room_name: '测试房间', ffmpeg_pid: null, ...overrides };
}

describe('RoomService.deleteRoom 软删除（v1.12.0）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.log.mockRestore();
    console.error.mockRestore();
  });

  test('软删房间 + 连带会话软删 + 双缓存失效', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [mockRoomRow()] }) // 初查（过滤软删行）
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE rooms SET deleted_at
      .mockResolvedValueOnce({ rowCount: 3 }); // UPDATE recording_sessions SET deleted_at

    const result = await RoomService.deleteRoom(7);

    expect(result).toEqual({ success: true, message: '直播间已删除' });
    const calls = pool.query.mock.calls.map(([sql]) => sql);
    expect(calls[0]).toBe('SELECT * FROM rooms WHERE id = $1 AND deleted_at IS NULL');
    expect(calls[1]).toContain('UPDATE rooms SET deleted_at = NOW()');
    expect(calls[1]).not.toContain('DELETE FROM');
    expect(calls[2]).toContain('UPDATE recording_sessions SET deleted_at = NOW()');
    expect(calls.some((sql) => sql.includes('DELETE FROM'))).toBe(false);
    // 房间缓存与活跃任务键都失效（缓存陈旧会让 getOrCreateRoom 继续用已删房间录制）
    expect(redis.del).toHaveBeenCalledWith(`room:${ROOM_URL}`);
    expect(redis.del).toHaveBeenCalledWith(`active_task:${ROOM_URL}`);
  });

  test('录制中的房间先 SIGTERM 再软删', async () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {});
    pool.query
      .mockResolvedValueOnce({ rows: [mockRoomRow({ ffmpeg_pid: 4321 })] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });

    await RoomService.deleteRoom(7);

    expect(killSpy).toHaveBeenCalledWith(4321, 'SIGTERM');
    killSpy.mockRestore();
  });

  test('已软删房间二次删除返回不存在，且不再 kill 残留 PID', async () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {});
    pool.query.mockResolvedValueOnce({ rows: [] }); // 初查过滤软删行 → 查不到

    const result = await RoomService.deleteRoom(7);

    expect(result).toEqual({ success: false, message: '直播间不存在' });
    expect(killSpy).not.toHaveBeenCalled();
    expect(pool.query.mock.calls).toHaveLength(1);
    killSpy.mockRestore();
  });
});

describe('RoomService.upsertRoom 复活语义（v1.12.0）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('同名软删房间被复活（清 deleted_at）而非报唯一冲突', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [mockRoomRow({ deleted_at: new Date('2026-10-14T10:00:00Z') })] })
      .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE rooms SET deleted_at = NULL

    const room = await RoomService.upsertRoom(ROOM_URL, '新名字');

    expect(room.id).toBe(7);
    expect(room.deleted_at).toBeNull();
    const calls = pool.query.mock.calls.map(([sql]) => sql);
    expect(calls[0]).toBe('SELECT * FROM rooms WHERE room_url = $1'); // 不过滤——要找到软删行
    expect(calls[1]).toContain('deleted_at = NULL');
    expect(redis.del).toHaveBeenCalledWith(`room:${ROOM_URL}`);
  });

  test('全新 URL 走 INSERT 建行', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [mockRoomRow({ room_name: '新房' })] });

    const room = await RoomService.upsertRoom('https://live.bilibili.com/999', '新房');

    expect(room.room_name).toBe('新房');
    const calls = pool.query.mock.calls.map(([sql]) => sql);
    expect(calls[1]).toContain('INSERT INTO rooms');
  });

  test('存活同名房间仅按需更新名称，不清 deleted_at', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [mockRoomRow({ room_name: '旧名' })] })
      .mockResolvedValueOnce({ rowCount: 1 });

    await RoomService.upsertRoom(ROOM_URL, '新名');

    const calls = pool.query.mock.calls.map(([sql]) => sql);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('SET room_name = $1');
    expect(calls[1]).not.toContain('deleted_at');
  });
});
