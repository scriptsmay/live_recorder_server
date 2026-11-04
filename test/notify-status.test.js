// GET /api/notify/status 的 URL 规范化回退测试
// 背景：Chrome 扩展推送的直播间 URL 常带追踪参数，而 rooms.room_url 入库时已规范化。
// 路由必须先按规范化地址查询，再回退原始入参（兼容历史上非规范形式落库的房间）。
jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({
  get: jest.fn(),
  setEx: jest.fn(),
  del: jest.fn(),
  ping: jest.fn(),
}));
jest.mock('../server/services/DataService', () => ({ getRoomByUrl: jest.fn() }));
jest.mock('../server/services/RecorderService', () => ({ startRecording: jest.fn() }));
jest.mock('../server/lib/core/downloaders/DownloaderFactory', () => ({
  getActiveDownloader: jest.fn(() => ({ name: 'ffmpeg' })),
}));
jest.mock('../server/lib/core/TranscodeQueue', () => ({}));
jest.mock('../server/lib/core/danmaku/DanmakuRecorder', () => ({}));
jest.mock('../server/lib/core/ReplayProcessQueue', () => ({}));
jest.mock('../server/lib/core/polling/PollingManager', () => ({}));
jest.mock('../server/lib/core/scan-files', () => ({ scanRecordingFiles: jest.fn() }));
jest.mock('../server/lib/core/hls-generator', () => ({}));
jest.mock('../server/services/HLSCleanupService', () => ({}));

const express = require('express');
const request = require('supertest');
const pool = require('../server/db/index');
const DataService = require('../server/services/DataService');
const { router: apiRouter } = require('../server/router/api');

const CANONICAL_URL = 'https://www.xiaohongshu.com/livestream/570523582342626238';
const RAW_URL = `${CANONICAL_URL}?xsec_token=abc&track_id=live_a2a_chat`;

const ROOM = {
  id: 7,
  room_url: CANONICAL_URL,
  room_name: '小红书直播间',
  monitoring_enabled: true,
  status: 'idle',
  polling_platform: 'xiaohongshu',
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  return app;
}

describe('GET /api/notify/status URL 规范化回退', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    // 精确命中但不在录制的房间会再查一次 live_url 索引，默认无候选
    pool.query.mockResolvedValue({ rows: [] });
    app = createApp();
  });

  test('带追踪参数的 URL 按规范化地址命中房间', async () => {
    DataService.getRoomByUrl.mockResolvedValueOnce(ROOM);

    const res = await request(app).get('/api/notify/status').query({ url: RAW_URL });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      exists: true,
      data: {
        room: { id: 7, room_url: CANONICAL_URL },
        downloader: 'ffmpeg',
        status: 'idle',
      },
    });
    expect(DataService.getRoomByUrl).toHaveBeenCalledTimes(1);
    expect(DataService.getRoomByUrl).toHaveBeenCalledWith(CANONICAL_URL);
  });

  test('规范化地址查不到时回退到原始入参（兼容历史非规范落库）', async () => {
    const legacyRoom = { ...ROOM, room_url: 'https://www.xiaohongshu.com/livestream/dynpathX/570523582342626238' };
    DataService.getRoomByUrl.mockResolvedValueOnce(null).mockResolvedValueOnce(legacyRoom);

    const res = await request(app).get('/api/notify/status').query({ url: RAW_URL });

    expect(res.body.exists).toBe(true);
    expect(DataService.getRoomByUrl).toHaveBeenNthCalledWith(1, CANONICAL_URL);
    expect(DataService.getRoomByUrl).toHaveBeenNthCalledWith(2, RAW_URL);
  });

  test('精确命中历史一次性直播间但稳定目标正在录制时，优先返回稳定目标', async () => {
    const legacyRoom = {
      ...ROOM,
      id: 25,
      room_url: CANONICAL_URL,
      room_name: '历史一次性房间',
      status: 'idle',
    };
    const stableRoom = {
      ...ROOM,
      id: 28,
      room_url: 'https://www.xiaohongshu.com/user/profile/66c164b6aaaa',
      room_name: '稳定目标',
      live_url: CANONICAL_URL,
      status: 'recording',
    };
    DataService.getRoomByUrl.mockResolvedValueOnce(legacyRoom);
    pool.query.mockResolvedValueOnce({ rows: [stableRoom] });

    const res = await request(app).get('/api/notify/status').query({ url: CANONICAL_URL });

    expect(res.body.exists).toBe(true);
    expect(res.body.data.room.id).toBe(28);
    expect(res.body.data.room.target_room_url).toBe(stableRoom.room_url);
    expect(res.body.data.status).toBe('recording');
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('live_url = $1'), [CANONICAL_URL]);
  });

  test('入参已是规范地址时只查一次房间，再回退本场 live_url 索引', async () => {
    DataService.getRoomByUrl.mockResolvedValueOnce(null);
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/notify/status').query({ url: CANONICAL_URL });

    expect(res.body).toEqual({ exists: false });
    expect(DataService.getRoomByUrl).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('live_url = $1'), [CANONICAL_URL]);
  });

  test('GET /api/notify/status?active=true 仅返回开启了 extension_danmaku_enabled 的快手/小红书在播房间', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 25,
          room_url: CANONICAL_URL,
          room_name: '王者荣耀女子公开赛',
          polling_platform: 'xiaohongshu',
          status: 'recording',
          extension_danmaku_enabled: true,
          session_id: 71,
          started_at: '2026-11-04T05:56:44.677Z',
        },
        {
          id: 22,
          room_url: 'https://www.huya.com/721931',
          room_name: '虎牙房间',
          polling_platform: 'huya',
          status: 'recording',
          extension_danmaku_enabled: true,
          session_id: 72,
          started_at: '2026-11-04T05:57:00.000Z',
        },
      ],
    });

    const res = await request(app).get('/api/notify/status').query({ active: 'true' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.rooms).toHaveLength(1);
    expect(res.body.data.rooms[0]).toMatchObject({
      id: 25,
      room_url: CANONICAL_URL,
      platform: 'xiaohongshu',
      status: 'recording',
      extension_danmaku_enabled: true,
      session_id: 71,
    });
  });

  test('active=true&include_all=true 返回全部平台活跃录制，且不再过滤弹幕开关', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 25,
          room_url: CANONICAL_URL,
          room_name: '王者荣耀女子公开赛',
          avatar_url: 'https://avatar/xhs.jpg',
          polling_platform: 'xiaohongshu',
          status: 'recording',
          extension_danmaku_enabled: false,
          live_room_id: '570523582342626238',
          live_url: CANONICAL_URL,
          session_id: 71,
          started_at: '2026-11-04T05:56:44.677Z',
        },
        {
          id: 22,
          room_url: 'https://www.huya.com/721931',
          room_name: '虎牙房间',
          polling_platform: 'huya',
          status: 'paused',
          extension_danmaku_enabled: false,
          session_id: 72,
          started_at: '2026-11-04T05:57:00.000Z',
        },
      ],
    });

    const res = await request(app).get('/api/notify/status').query({ active: 'true', include_all: 'true' });

    expect(res.status).toBe(200);
    expect(res.body.data.rooms).toHaveLength(2);
    expect(res.body.data.rooms[0]).toMatchObject({
      id: 25,
      platform: 'xiaohongshu',
      avatar_url: 'https://avatar/xhs.jpg',
      live_room_id: '570523582342626238',
      extension_danmaku_enabled: false,
    });
    expect(res.body.data.rooms[1]).toMatchObject({
      id: 22,
      platform: 'huya',
      status: 'paused',
    });
    const sql = pool.query.mock.calls[0][0];
    expect(sql).not.toContain('extension_danmaku_enabled = TRUE');
  });
});
