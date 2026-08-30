const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

jest.mock('../server/db/index', () => ({
  query: jest.fn(),
}));
jest.mock('axios', () => ({
  get: jest.fn(),
}));
jest.mock('../server/services/DataService', () => ({
  getSetting: jest.fn().mockResolvedValue('true'),
}));

const pool = require('../server/db/index');
const DanmakuRecorder = require('../server/lib/core/danmaku/DanmakuRecorder');
const axios = require('axios');
const {
  buildPacket,
  buildAuthPacket,
  OP,
} = require('../server/lib/core/danmaku/client/platforms/bilibili');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-bili-'));
let wss;
let wssPort;
let connections = [];
let received = [];

const ROOM = 'https://live.bilibili.com/23058';

const flush = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  process.env.VIDEO_DOWNLOAD_DIR = TMP_DIR;
  await new Promise((resolve) => {
    wss = new WebSocketServer({ port: 0 }, resolve);
  });
  wssPort = wss.address().port;
  wss.on('connection', (ws) => {
    connections.push(ws);
    ws.on('message', (data) => received.push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
  });
});

afterAll(async () => {
  delete process.env.DANMAKU_NATIVE_PLATFORMS;
  delete process.env.BILIBILI_DANMAKU_WS_URL;
  await new Promise((r) => wss.close(r));
});

beforeEach(() => {
  jest.clearAllMocks();
  connections = [];
  received = [];
  process.env.BILIBILI_DANMAKU_WS_URL = `ws://127.0.0.1:${wssPort}`;
  process.env.DANMAKU_NATIVE_PLATFORMS = 'bilibili';
  axios.get.mockImplementation((url) => {
    if (url.startsWith('https://api.bilibili.com/x/web-interface/nav')) {
      return Promise.resolve({
        data: {
          data: {
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
            },
          },
        },
      });
    }
    if (url.includes('/room_init')) {
      return Promise.resolve({ data: { code: 0, data: { room_id: 6210028 } } });
    }
    if (url.includes('getDanmuInfo')) {
      return Promise.resolve({
        data: {
          code: 0,
          data: {
            token: 'tok-mock',
            host_list: [{ host: '127.0.0.1', wss_port: wssPort }],
          },
        },
      });
    }
    return Promise.reject(new Error(`unexpected url: ${url}`));
  });
  pool.query.mockImplementation((sql) => {
    if (sql.includes('INSERT INTO danmaku_capture_records')) {
      return Promise.resolve({ rows: [{ id: 88 }], rowCount: 1 });
    }
    if (sql.includes('UPDATE danmaku_capture_records')) {
      return Promise.resolve({ rows: [{ id: 88 }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
});

afterEach(async () => {
  for (const roomUrl of [...DanmakuRecorder.activeSessions.keys()]) {
    await DanmakuRecorder.stopCapture(roomUrl);
  }
});

describe('端到端：B站原生弹幕链路', () => {
  test('startCapture → room_init/getDanmuInfo(WBI) → mock WS 认证 → DANMU_MSG/SEND_GIFT 落 JSONL', async () => {
    const recordingStartedAt = Date.now() - 2000;
    const captureId = await DanmakuRecorder.startCapture({
      sessionId: 301,
      roomId: 30,
      roomUrl: ROOM,
      platform: 'bilibili',
      recordingStartedAt,
    });
    expect(captureId).toBe(88);

    await flush(500);
    // WBI 签名链路被调用
    const danmuInfoCall = axios.get.mock.calls.find((c) => c[0].includes('getDanmuInfo'));
    expect(danmuInfoCall).toBeTruthy();
    expect(danmuInfoCall[0]).toContain('w_rid=');
    expect(danmuInfoCall[0]).toContain('wts=');
    expect(danmuInfoCall[0]).toContain('id=6210028');

    // 认证包（op=7）已发送且 roomid 为真实房间号
    expect(received.length).toBeGreaterThanOrEqual(1);
    const authPacket = received[0];
    expect(authPacket.readUInt32BE(8)).toBe(OP.AUTH);
    const auth = JSON.parse(authPacket.subarray(16).toString());
    expect(auth.roomid).toBe(6210028);
    expect(auth.uid).toBe(0);
    expect(auth.protover).toBe(3);

    const ws = connections.find((c) => c.readyState === 1);
    // 认证响应
    ws.send(buildPacket(Buffer.from(JSON.stringify({ cmd: 'AUTH_REPLY' })), OP.AUTH_REPLY));
    // 弹幕 + 礼物
    ws.send(
      buildPacket(
        Buffer.from(
          JSON.stringify({
            cmd: 'DANMU_MSG:4:0:2:2:2:0',
            info: [[0, 1, 25, 16777215], 'B站弹幕测试', [555, 'B站用户']],
          })
        ),
        OP.NOTIFICATION
      )
    );
    ws.send(
      buildPacket(
        Buffer.from(
          JSON.stringify({
            cmd: 'SEND_GIFT',
            data: { uname: 'B站礼物哥', uid: 556, giftName: '小花花', num: 2 },
          })
        ),
        OP.NOTIFICATION
      )
    );

    await flush(900); // 攒批窗口
    const session = DanmakuRecorder.getSession(ROOM);
    const lines = fs.readFileSync(session.rawPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: 'comment', username: 'B站用户', user_id: '555', text: 'B站弹幕测试' });
    // gift 分支被激活
    expect(lines[1]).toMatchObject({ type: 'gift', username: 'B站礼物哥', user_id: '556', gift_name: '小花花', count: 2 });
    for (const line of lines) {
      expect(line.ts_ms).toBeGreaterThanOrEqual(1900);
    }

    const stopped = await DanmakuRecorder.stopCapture(ROOM);
    expect(stopped.eventCount).toBe(2);
  }, 15000);

  test('getDanmuInfo 风控（code=-352）→ 降级默认地址链路仍可建连（认证包空 token）', async () => {
    axios.get.mockImplementation((url) => {
      if (url.startsWith('https://api.bilibili.com/x/web-interface/nav')) {
        return Promise.resolve({
          data: { data: { wbi_img: { img_url: 'https://x/aaa.png', sub_url: 'https://x/bbb.png' } } },
        });
      }
      if (url.includes('/room_init')) {
        return Promise.resolve({ data: { code: 0, data: { room_id: 42 } } });
      }
      if (url.includes('getDanmuInfo')) {
        return Promise.resolve({ data: { code: -352, message: '请求被拦截' } });
      }
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });

    const captureId = await DanmakuRecorder.startCapture({
      sessionId: 302,
      roomId: 31,
      roomUrl: ROOM + '-risk',
      platform: 'bilibili',
      recordingStartedAt: Date.now(),
    });
    expect(captureId).toBe(88); // 录制主流程不受风控影响

    await flush(500);
    // 最终连接仍指向 mock server（BILIBILI_DANMAKU_WS_URL 覆盖默认地址），token 为空
    const authPacket = received.find((b) => b.readUInt32BE(8) === OP.AUTH);
    expect(authPacket).toBeTruthy();
    const auth = JSON.parse(authPacket.subarray(16).toString());
    expect(auth.key).toBe('');
    await DanmakuRecorder.stopCapture(ROOM + '-risk');
  }, 15000);
});

// 防止未使用告警
void buildAuthPacket;
