// DELETE /api/rooms/:id 回归测试：删除直播间必须同步停止内存轮询定时器（v1.10.2）
// 背景：v1.10.1 及以前，DELETE 路由只调 RoomService.deleteRoom()，不触碰 PollingManager。
// 2026-08-31 冒烟清理 DELETE /api/rooms/18 后定时器泄漏成"幽灵轮询器"，
// 2026-09-01 检测到斗鱼 12451579 开播并误启动录制（会话 62）。
// 修复：删除成功后调用 pollingManager.reloadRoom(id)——行已不存在时走
// stopRoomPolling 分支清除定时器与元数据，天然幂等。
jest.mock('../server/services/RoomService', () => ({
  deleteRoom: jest.fn(),
}));
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

const express = require('express');
const request = require('supertest');
const RoomService = require('../server/services/RoomService');
const pool = require('../server/db/index');
const roomsRouter = require('../server/router/rooms');
const pollingManager = require('../server/lib/core/polling/PollingManager');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', roomsRouter);
  return app;
}

describe('DELETE /api/rooms/:id 轮询定时器同步', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    // 模拟泄漏现场：定时器与元数据已注册（幽灵状态）
    pollingManager.timers.clear();
    pollingManager.roomPollingMeta.clear();
    pollingManager.roomLiveStatus.clear();
    app = createApp();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
    pollingManager.timers.clear();
    pollingManager.roomPollingMeta.clear();
    pollingManager.roomLiveStatus.clear();
  });

  test('删除带轮询的房间后，reloadRoom 清除内存定时器与元数据', async () => {
    const leakedTimer = setInterval(() => {}, 10 ** 6);
    pollingManager.timers.set('room:18', leakedTimer);
    pollingManager.roomPollingMeta.set(18, {
      platform: 'douyu',
      roomName: '【冒烟】斗鱼12451579',
      roomUrl: 'https://www.douyu.com/12451579',
    });
    pollingManager.roomLiveStatus.set(18, false);

    RoomService.deleteRoom.mockResolvedValue({ success: true, message: '删除成功' });
    // reloadRoom 查询 rooms 表：行已删除，返回空
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete('/api/rooms/18');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', message: '删除成功' });
    expect(RoomService.deleteRoom).toHaveBeenCalledWith('18');
    // reloadRoom 按数值 id 查库确认行已不存在 → stopRoomPolling 清理
    expect(pool.query).toHaveBeenCalledWith('SELECT * FROM rooms WHERE id = $1', [18]);
    expect(pollingManager.timers.has('room:18')).toBe(false);
    expect(pollingManager.roomPollingMeta.has(18)).toBe(false);
  });

  test('房间不存在返回 404，不触发 reloadRoom', async () => {
    RoomService.deleteRoom.mockResolvedValue({ success: false, message: '直播间不存在' });

    const res = await request(app).delete('/api/rooms/999');

    expect(res.status).toBe(404);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pollingManager.timers.size).toBe(0);
  });

  test('删除抛错返回 500，不触发 reloadRoom', async () => {
    RoomService.deleteRoom.mockRejectedValue(new Error('db down'));

    const res = await request(app).delete('/api/rooms/18');

    expect(res.status).toBe(500);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
