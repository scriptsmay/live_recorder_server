// DELETE /api/rooms/:id 回归测试：删除直播间必须同步停止内存轮询定时器（v1.10.2）
// 背景：v1.10.1 及以前，DELETE 路由只调 RoomService.deleteRoom()，不触碰 PollingManager。
// 2026-08-31 冒烟清理 DELETE /api/rooms/18 后定时器泄漏成"幽灵轮询器"，
// 2026-09-01 检测到斗鱼 12451579 开播并误启动录制（会话 62）。
// 修复：删除成功后调用 pollingManager.reloadRoom(id)——v1.12.0 起房间为软删除，
// reloadRoom 的查询过滤软删行后返回空，同样走 stopRoomPolling 分支清除定时器与元数据，天然幂等。
jest.mock('../server/services/RoomService', () => ({
  deleteRoom: jest.fn(),
}));
jest.mock('../server/db/index', () => ({
  query: jest.fn(),
}));
jest.mock('../server/db/redis', () => ({
  get: jest.fn(),
  setEx: jest.fn(),
  del: jest.fn(() => Promise.resolve(1)),
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
    // reloadRoom 查询 rooms 表：v1.12.0 软删行被过滤，返回空
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete('/api/rooms/18');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', message: '删除成功' });
    expect(RoomService.deleteRoom).toHaveBeenCalledWith('18');
    // reloadRoom 按数值 id 查库（过滤软删行）确认行不存在 → stopRoomPolling 清理
    expect(pool.query).toHaveBeenCalledWith('SELECT * FROM rooms WHERE id = $1 AND deleted_at IS NULL', [18]);
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

  test('POST /api/rooms 添加小红书分享口令短链时自动 302 还原并在未开轮询时立即触发一次 checkRoom', async () => {
    const XiaohongshuChecker = require('../server/lib/core/polling/XiaohongshuChecker');
    const resolveSpy = jest
      .spyOn(XiaohongshuChecker, 'resolveShortUrl')
      .mockResolvedValueOnce(
        'https://www.xiaohongshu.com/livestream/dynpathxYjf2eb8/570523767964993440?host_id=5f849379000000000101e56e&xsec_token=abc'
      );
    const checkRoomSpy = jest.spyOn(pollingManager, 'checkRoom').mockResolvedValueOnce(undefined);

    const canonicalUrl = 'https://www.xiaohongshu.com/livestream/570523767964993440';
    const profileUrl = 'https://www.xiaohongshu.com/user/profile/5f849379000000000101e56e';
    const createdRow = {
      id: 99,
      room_url: profileUrl,
      room_name: '',
      notification_enabled: true,
      monitoring_enabled: true,
      polling_enabled: false,
      polling_platform: 'xiaohongshu',
      polling_interval: 90,
      host_user_id: '5f849379000000000101e56e',
      live_room_id: '570523767964993440',
      live_url: canonicalUrl,
    };

    pool.query
      .mockResolvedValueOnce({ rows: [] }) // SELECT * FROM rooms WHERE room_url = $1
      .mockResolvedValueOnce({ rows: [createdRow] }); // INSERT INTO rooms ... RETURNING *

    const res = await request(app).post('/api/rooms').send({
      room_url:
        '小红书，你的生活指南#KPL正在直播 https://xhslink.com/o/6SoiafhhH6N 复制本条信息，打开【小红书】，直接观看直播！',
      polling_enabled: false,
      monitoring_enabled: true,
    });

    expect(res.status).toBe(200);
    // 带 host_id 的直播间链接归并到稳定的个人主页目标（ADR-021）
    expect(res.body.data.room_url).toBe(profileUrl);
    expect(res.body.data.polling_platform).toBe('xiaohongshu');
    expect(resolveSpy).toHaveBeenCalledWith('https://xhslink.com/o/6SoiafhhH6N');
    // 首次检测仍使用本场直播地址，否则 checker 会把主页当成不可开播目标
    expect(checkRoomSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 99,
        room_url: canonicalUrl,
        live_url: canonicalUrl,
        live_room_id: '570523767964993440',
        host_user_id: '5f849379000000000101e56e',
      })
    );

    resolveSpy.mockRestore();
    checkRoomSpy.mockRestore();
  });

  test('pollingManager.checkRoom 自动回填 room_name 与 avatar_url', async () => {
    const checkers = require('../server/lib/core/polling/checkers');
    const redis = require('../server/db/redis');
    redis.setEx.mockResolvedValue('OK');
    redis.get.mockResolvedValue(null);

    checkers.xiaohongshu = class {
      async checkStatus() {
        return {
          isLive: false,
          recordable: false,
          roomName: '成都AG超玩会染详',
          avatarUrl: 'https://sns-avatar-qc.xhscdn.com/avatar/ag.jpg',
          roomCover: 'https://sns-avatar-qc.xhscdn.com/avatar/ag.jpg',
          error: null,
        };
      }
    };

    pool.query
      .mockResolvedValueOnce({ rows: [] }) // UPDATE rooms SET room_name
      .mockResolvedValueOnce({ rows: [] }) // UPDATE rooms SET avatar_url
      .mockResolvedValueOnce({ rows: [{ status: 'idle', ffmpeg_pid: null }] });

    const room = {
      id: 24,
      room_url: 'https://www.xiaohongshu.com/user/profile/635639e10000000018028e12',
      room_name: '',
      avatar_url: '',
      polling_platform: 'xiaohongshu',
      polling_interval: 60,
      status: 'idle',
    };

    await pollingManager.checkRoom(room);

    expect(pool.query).toHaveBeenCalledWith('UPDATE rooms SET room_name = $1 WHERE id = $2', ['成都AG超玩会染详', 24]);
    expect(pool.query).toHaveBeenCalledWith('UPDATE rooms SET avatar_url = $1 WHERE id = $2', [
      'https://sns-avatar-qc.xhscdn.com/avatar/ag.jpg',
      24,
    ]);
    expect(room.room_name).toBe('成都AG超玩会染详');
    expect(room.avatar_url).toBe('https://sns-avatar-qc.xhscdn.com/avatar/ag.jpg');

    delete checkers.xiaohongshu;
  });

  test('PUT /api/rooms/:id 录制中允许切换 extension_danmaku_enabled 并自动补建弹幕采集会话', async () => {
    const danmakuRecorder = require('../server/lib/core/danmaku/DanmakuRecorder');
    const isCapturingSpy = jest.spyOn(danmakuRecorder, 'isCapturing').mockReturnValue(false);
    const startCaptureSpy = jest.spyOn(danmakuRecorder, 'startCapture').mockResolvedValue(46);

    const updatedRow = {
      id: 25,
      room_url: 'https://www.xiaohongshu.com/livestream/570523582342626238',
      room_name: '王者荣耀女子公开赛',
      status: 'recording',
      polling_platform: 'xiaohongshu',
      extension_danmaku_enabled: true,
    };

    pool.query
      .mockResolvedValueOnce({
        rows: [{ status: 'recording', room_url: 'https://www.xiaohongshu.com/livestream/570523582342626238' }],
      }) // SELECT status, room_url
      .mockResolvedValueOnce({ rows: [updatedRow] }) // UPDATE rooms ... RETURNING *
      .mockResolvedValueOnce({ rows: [{ id: 71, started_ms: 1700000000000 }] }); // SELECT active recording_session

    const res = await request(app).put('/api/rooms/25').send({
      extension_danmaku_enabled: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.extension_danmaku_enabled).toBe(true);
    expect(startCaptureSpy).toHaveBeenCalledWith({
      sessionId: 71,
      roomId: 25,
      roomUrl: 'https://www.xiaohongshu.com/livestream/570523582342626238',
      platform: 'xiaohongshu',
      recordingStartedAt: 1700000000000,
      extensionDanmakuEnabled: true,
    });

    isCapturingSpy.mockRestore();
    startCaptureSpy.mockRestore();
  });
});
