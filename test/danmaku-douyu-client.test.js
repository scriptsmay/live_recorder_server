const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../server/db/index', () => ({
  query: jest.fn(),
}));
jest.mock('../server/services/DataService', () => ({
  getSetting: jest.fn().mockResolvedValue('true'),
}));

const pool = require('../server/db/index');
const DanmakuRecorder = require('../server/lib/core/danmaku/DanmakuRecorder');
const {
  decode: sttDecode,
  getStr,
  encodeString,
  decodeString,
} = require('../server/lib/core/danmaku/codec/stt');
const {
  DouyuDanmakuClient,
  extractRoomId,
  buildPacket,
  parseFrames,
  parseSttMessage,
  HEARTBEAT,
  MSG_TYPE,
} = require('../server/lib/core/danmaku/client/platforms/douyu');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-douyu-'));
const flush = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// STT 编解码（biliup stt.rs 测试用例转写）
// ============================================================
describe('STT 编解码', () => {
  test('简单键值对', () => {
    const result = sttDecode('type@=chatmsg/txt@=hello/');
    expect(getStr(result, 'type')).toBe('chatmsg');
    expect(getStr(result, 'txt')).toBe('hello');
  });

  test('转义字符 @A → @、@S → /', () => {
    const result = sttDecode('txt@=hello@Aworld@Stest/');
    expect(getStr(result, 'txt')).toBe('hello@world/test');
    expect(encodeString('hello@world/test')).toBe('hello@Aworld@Stest');
    expect(decodeString('hello@Aworld@Stest')).toBe('hello@world/test');
  });

  test('多字段嵌套', () => {
    const result = sttDecode('type@=chatmsg/nn@=user1/txt@=test message/col@=1/');
    expect(getStr(result, 'type')).toBe('chatmsg');
    expect(getStr(result, 'nn')).toBe('user1');
    expect(getStr(result, 'txt')).toBe('test message');
    expect(getStr(result, 'col')).toBe('1');
  });

  test('getStr 非 string 值返回 null', () => {
    expect(getStr('plain', 'k')).toBeNull();
    expect(getStr(sttDecode('type@=chatmsg/'), 'missing')).toBeNull();
  });
});

// ============================================================
// 帧构建与解析
// ============================================================
describe('douyu: 帧构建（固定字节向量，对齐 biliup build_packet 测试）', () => {
  test('type@=mrkl/ 心跳帧逐字段核对', () => {
    const packet = buildPacket('type@=mrkl/');
    expect(packet.subarray(0, 4).equals(Buffer.from([0x14, 0x00, 0x00, 0x00]))).toBe(true);
    expect(packet.subarray(4, 8).equals(Buffer.from([0x14, 0x00, 0x00, 0x00]))).toBe(true);
    expect(packet.subarray(8, 12).equals(Buffer.from([0xb1, 0x02, 0x00, 0x00]))).toBe(true);
    expect(packet.subarray(12, 23).toString()).toBe('type@=mrkl/');
    expect(packet[23]).toBe(0x00);
    expect(packet.equals(HEARTBEAT)).toBe(true); // 心跳常量与 buildPacket 产物一致
    expect(MSG_TYPE).toBe(689);
  });

  test('URL 提取房间号', () => {
    expect(extractRoomId('https://www.douyu.com/123456')).toBe('123456');
    expect(extractRoomId('https://douyu.com/789')).toBe('789');
    expect(extractRoomId('https://www.huya.com/1')).toBeNull();
  });
});

describe('douyu: 消息解析', () => {
  test('chatmsg → comment', () => {
    const event = parseSttMessage('type@=chatmsg/nn@=TestUser/txt@=Hello World/col@=1/uid@=888/');
    expect(event).toMatchObject({ type: 'comment', user: 'TestUser', userId: '888', text: 'Hello World' });
  });

  test('chatmsg 无内容丢弃', () => {
    expect(parseSttMessage('type@=chatmsg/nn@=u/')).toBeNull();
  });

  test('dgb → gift', () => {
    const event = parseSttMessage('type@=dgb/nn@=礼物哥/uid@=999/gfn@=火箭/gfcnt@=2/');
    expect(event).toMatchObject({ type: 'gift', user: '礼物哥', userId: '999', giftName: '火箭', count: 2 });
  });

  test('uenter 进场丢弃、loginres 忽略、未知类型忽略', () => {
    expect(parseSttMessage('type@=uenter/nn@=u/uid@=1/')).toBeNull();
    expect(parseSttMessage('type@=loginres/')).toBeNull();
    expect(parseSttMessage('type@=rss/rl@=1/')).toBeNull();
  });

  test('多帧粘包解析', () => {
    const chunk = Buffer.concat([
      buildPacket('type@=loginres/'),
      buildPacket('type@=chatmsg/nn@=a/txt@=m1/uid@=1/'),
      buildPacket('type@=chatmsg/nn@=b/txt@=m2/uid@=2/'),
    ]);
    const { events, rest } = parseFrames(chunk);
    expect(events).toHaveLength(2);
    expect(events[0].text).toBe('m1');
    expect(events[1].text).toBe('m2');
    expect(rest.length).toBe(0);
  });

  test('TCP 半帧分片：跨 chunk 的消息正确重组', () => {
    const full = buildPacket('type@=chatmsg/nn@=a/txt@=完整消息/uid@=1/');
    const cut = 8; // 在长度头中间切断
    const first = parseFrames(full.subarray(0, cut));
    expect(first.events).toHaveLength(0);
    const second = parseFrames(Buffer.concat([first.rest, full.subarray(cut)]));
    expect(second.events).toHaveLength(1);
    expect(second.events[0].text).toBe('完整消息');
  });

  test('声明长度非法（<16）：丢弃缓冲不解析', () => {
    const buf = Buffer.alloc(20);
    buf.writeUInt32LE(8, 0);
    const { events, rest } = parseFrames(buf);
    expect(events).toHaveLength(0);
    expect(rest.length).toBe(0);
  });
});

// ============================================================
// 客户端与端到端
// ============================================================
describe('douyu: 端到端（mock TCP server → DanmakuRecorder → JSONL）', () => {
  let server;
  let serverPort;
  let serverReceived;
  let serverSockets;

  beforeAll(async () => {
    process.env.VIDEO_DOWNLOAD_DIR = TMP_DIR;
    server = net.createServer((socket) => {
      serverSockets.push(socket);
      socket.on('data', (d) => serverReceived.push(d));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    serverPort = server.address().port;
  });

  afterAll(async () => {
    delete process.env.DANMAKU_NATIVE_PLATFORMS;
    delete process.env.DOUYU_DANMAKU_TCP_ENDPOINTS;
    await new Promise((r) => server.close(r));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    serverReceived = [];
    serverSockets = [];
    process.env.DANMAKU_NATIVE_PLATFORMS = 'douyu';
    process.env.DOUYU_DANMAKU_TCP_ENDPOINTS = `127.0.0.1:${serverPort}`;
    pool.query.mockImplementation((sql) => {
      if (sql.includes('INSERT INTO danmaku_capture_records')) {
        return Promise.resolve({ rows: [{ id: 66 }], rowCount: 1 });
      }
      if (sql.includes('UPDATE danmaku_capture_records')) {
        return Promise.resolve({ rows: [{ id: 66 }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
  });

  afterEach(async () => {
    for (const roomUrl of [...DanmakuRecorder.activeSessions.keys()]) {
      await DanmakuRecorder.stopCapture(roomUrl);
    }
  });

  test('startCapture → TCP 注册两包 → chatmsg/dgb → JSONL（gift 分支）', async () => {
    const captureId = await DanmakuRecorder.startCapture({
      sessionId: 401,
      roomId: 40,
      roomUrl: 'https://www.douyu.com/7777',
      platform: 'douyu',
      recordingStartedAt: Date.now() - 1000,
    });
    expect(captureId).toBe(66);

    await flush(400);
    expect(serverSockets.length).toBe(1);
    // 注册：loginreq + joingroup 两包（TCP 可能合并为一个 data 事件，按字节流断言）
    const receivedText = Buffer.concat(serverReceived).toString('utf8');
    expect(receivedText).toContain('type@=loginreq/roomid@=7777/');
    expect(receivedText).toContain('type@=joingroup/rid@=7777/gid@=-9999/');

    const socket = serverSockets[serverSockets.length - 1];
    socket.write(Buffer.concat([
      buildPacket('type@=chatmsg/nn@=斗鱼用户/txt@=斗鱼弹幕/uid@=1001/'),
      buildPacket('type@=dgb/nn@=斗鱼礼物哥/uid@=1002/gfn@=超级火箭/gfcnt@=1/'),
    ]));

    await flush(900); // 攒批窗口
    const session = DanmakuRecorder.getSession('https://www.douyu.com/7777');
    const lines = fs.readFileSync(session.rawPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: 'comment', username: '斗鱼用户', user_id: '1001', text: '斗鱼弹幕' });
    expect(lines[1]).toMatchObject({ type: 'gift', username: '斗鱼礼物哥', gift_name: '超级火箭', count: 1 });

    const stopped = await DanmakuRecorder.stopCapture('https://www.douyu.com/7777');
    expect(stopped.eventCount).toBe(2);
  }, 15000);

  test('断线后按退避重连并重发注册包（8601 失效切 8602 语义的骨架层验证）', async () => {
    const captureId = await DanmakuRecorder.startCapture({
      sessionId: 402,
      roomId: 41,
      roomUrl: 'https://www.douyu.com/8888',
      platform: 'douyu',
      recordingStartedAt: Date.now(),
    });
    expect(captureId).toBe(66);
    await flush(400);
    expect(serverSockets.length).toBe(1); // 首次注册

    const socket = serverSockets[0];
    socket.destroy(); // 模拟端点断流 → 骨架按退避重连

    await flush(1800); // 1s 退避后重连本 server
    expect(serverSockets.length).toBeGreaterThanOrEqual(2); // 重连
    const receivedText = Buffer.concat(serverReceived).toString('utf8');
    const count = (s) => receivedText.split(s).length - 1;
    expect(count('type@=loginreq/roomid@=8888/')).toBeGreaterThanOrEqual(2); // 重连后重发注册包

    await DanmakuRecorder.stopCapture('https://www.douyu.com/8888');
  }, 15000);
});
