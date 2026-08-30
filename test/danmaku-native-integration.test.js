const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { WebSocketServer } = require('ws');

// ---- 模块级 mock：DB 与 DataService（与 danmaku-recorder.test.js 同风格）----
jest.mock('../server/db/index', () => ({
  query: jest.fn(),
}));
jest.mock('../server/services/DataService', () => ({
  getSetting: jest.fn().mockResolvedValue('true'),
}));

const pool = require('../server/db/index');
const DanmakuRecorder = require('../server/lib/core/danmaku/DanmakuRecorder');
const { TarsWriter } = require('../server/lib/core/danmaku/codec/tars/writer');
const { TarsReader } = require('../server/lib/core/danmaku/codec/tars/reader');
const { buildRegisterPacket } = require('../server/lib/core/danmaku/client/platforms/huya');

jest.mock('axios', () => ({
  get: jest.fn(),
}));
const axios = require('axios');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-native-'));
let wss;
let wssPort;
const serverState = { connections: [], received: [] }; // 每个 mock WS server 的连接/收包记录

function startMockWsServer() {
  return new Promise((resolve) => {
    wss = new WebSocketServer({ port: 0 }, () => {
      wssPort = wss.address().port;
      resolve();
    });
    wss.on('connection', (ws) => {
      serverState.connections.push(ws);
      ws.on('message', (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        serverState.received.push(buf);
      });
    });
  });
}

/** 按抓包验证的布局构造一条 1400 推送帧 */
function buildDanmakuPushFrame({ nick, uid, text, msgType = 1400 }) {
  const body = new TarsWriter();
  body.writeStruct(0, (u) => {
    u.writeInt64(0, uid);
    u.writeString(2, nick);
  });
  body.writeString(3, text);
  const inner = new TarsWriter();
  inner.writeInt64(1, msgType);
  inner.writeBytes(2, body.toBuffer());
  const cmd = new TarsWriter();
  cmd.writeInt32(0, 7);
  cmd.writeBytes(1, inner.toBuffer());
  return cmd.toBuffer();
}

function mockDbInsertCapture(id = 1) {
  pool.query.mockImplementation((sql) => {
    if (sql.includes('INSERT INTO danmaku_capture_records')) {
      return Promise.resolve({ rows: [{ id }], rowCount: 1 });
    }
    if (sql.includes('UPDATE danmaku_capture_records')) {
      return Promise.resolve({ rows: [{ id: 77 }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

const flush = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  process.env.VIDEO_DOWNLOAD_DIR = TMP_DIR;
  await startMockWsServer();
  process.env.HUYA_DANMAKU_WS_URL = `ws://127.0.0.1:${wssPort}`;
});

afterAll(async () => {
  delete process.env.DANMAKU_NATIVE_PLATFORMS;
  delete process.env.HUYA_DANMAKU_WS_URL;
  await new Promise((r) => wss.close(r));
});

beforeEach(() => {
  jest.clearAllMocks();
  serverState.connections = [];
  serverState.received = [];
  mockDbInsertCapture(77);
  axios.get.mockResolvedValue({ data: 'var hyPlayerConfig = {"uid":123456};' });
});

afterEach(async () => {
  // 清理会话，避免单例状态泄漏到下一个用例
  for (const roomUrl of [...DanmakuRecorder.activeSessions.keys()]) {
    await DanmakuRecorder.stopCapture(roomUrl);
  }
  delete process.env.DANMAKU_NATIVE_PLATFORMS;
});

const ROOM = 'https://www.huya.com/itest-room';

describe('端到端：startCapture → mock WS 推弹幕 → JSONL 落盘 → stopCapture', () => {
  test('白名单命中：注册包正确、事件写入 JSONL 且 ts_ms 对齐录制时间轴', async () => {
    process.env.DANMAKU_NATIVE_PLATFORMS = 'huya';
    const recordingStartedAt = Date.now() - 5000;

    const captureId = await DanmakuRecorder.startCapture({
      sessionId: 101,
      roomId: 9,
      roomUrl: ROOM,
      platform: 'huya',
      recordingStartedAt,
    });
    expect(captureId).toBe(77);

    // 客户端连接 mock server 并发注册包
    await flush(300);
    expect(serverState.connections.length).toBe(1);
    expect(serverState.received.length).toBeGreaterThanOrEqual(1);

    // 注册包 = WebSocketCommand(1, WSUserInfo(uid=123456))
    const regPacket = serverState.received[0];
    expect(regPacket.equals(buildRegisterPacket(123456))).toBe(true);

    const session = DanmakuRecorder.getSession(ROOM);
    expect(session.nativeClient).toBeTruthy();

    // 服务端推 3 条弹幕 → 攒批 500ms 后落盘
    const ws = serverState.connections[0];
    ws.send(buildDanmakuPushFrame({ nick: '弹幕用户A', uid: 1001, text: '第一条' }));
    ws.send(buildDanmakuPushFrame({ nick: '弹幕用户B', uid: 1002, text: '第二条' }));
    ws.send(buildDanmakuPushFrame({ nick: '弹幕用户C', uid: 1003, text: '第三条' }));

    await flush(900); // 500ms 攒批窗口 + 余量
    const jsonlPath = session.rawPath;
    expect(fs.existsSync(jsonlPath)).toBe(true);
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      type: 'comment',
      username: '弹幕用户A',
      user_id: '1001',
      text: '第一条',
    });
    // ts_ms = 弹幕到达时刻 - recordingStartedAt ≈ 5000ms
    for (const line of lines) {
      expect(line.ts_ms).toBeGreaterThanOrEqual(4900);
      expect(line.ts_ms).toBeLessThan(10000);
      expect(line.ts_abs_ms).toBeGreaterThan(recordingStartedAt);
    }

    // stopCapture：客户端销毁 + 状态收口
    const stopped = await DanmakuRecorder.stopCapture(ROOM);
    expect(stopped.captureId).toBe(77);
    expect(stopped.eventCount).toBe(3);
    expect(DanmakuRecorder.getSession(ROOM)).toBeNull();
    await flush(200);
    expect(ws.readyState).toBeGreaterThanOrEqual(2); // CLOSING/CLOSED

    const updateCall = pool.query.mock.calls.find((c) => c[0].includes("SET status = 'completed'"));
    expect(updateCall).toBeTruthy();
    expect(updateCall[1]).toEqual([3, 77]);
  });

  test('攒批生效：3 条事件在 500ms 窗口内合并为一次写入', async () => {
    process.env.DANMAKU_NATIVE_PLATFORMS = 'huya';
    await DanmakuRecorder.startCapture({
      sessionId: 102,
      roomId: 9,
      roomUrl: ROOM + '-batch',
      platform: 'huya',
      recordingStartedAt: Date.now(),
    });
    await flush(300);
    const ws = serverState.connections.find((c) => c.readyState === 1);
    ws.send(buildDanmakuPushFrame({ nick: 'n1', uid: 1, text: 't1' }));

    await flush(150); // 未到攒批窗口
    const session = DanmakuRecorder.getSession(ROOM + '-batch');
    // JSONL 文件在 startCapture 即创建（openSync 'a'），攒批判断看内容大小
    expect(fs.existsSync(session.rawPath)).toBe(true);
    expect(fs.statSync(session.rawPath).size).toBe(0); // 尚未写入

    await flush(600);
    const lines = fs.readFileSync(session.rawPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    await DanmakuRecorder.stopCapture(ROOM + '-batch');
  });

  test('白名单为空（默认）：不建立原生连接，行为与现状一致', async () => {
    delete process.env.DANMAKU_NATIVE_PLATFORMS;
    await DanmakuRecorder.startCapture({
      sessionId: 103,
      roomId: 9,
      roomUrl: ROOM + '-off',
      platform: 'huya',
      recordingStartedAt: Date.now(),
    });
    await flush(300);
    const session = DanmakuRecorder.getSession(ROOM + '-off');
    expect(session.nativeClient).toBeFalsy();
    expect(serverState.connections.length).toBe(0);
    await DanmakuRecorder.stopCapture(ROOM + '-off');
  });

  test('白名单不包含当前平台：不建立原生连接', async () => {
    process.env.DANMAKU_NATIVE_PLATFORMS = 'bilibili,douyu';
    await DanmakuRecorder.startCapture({
      sessionId: 104,
      roomId: 9,
      roomUrl: ROOM + '-other',
      platform: 'huya',
      recordingStartedAt: Date.now(),
    });
    await flush(300);
    const session = DanmakuRecorder.getSession(ROOM + '-other');
    expect(session.nativeClient).toBeFalsy();
    await DanmakuRecorder.stopCapture(ROOM + '-other');
  });

  test('uid 提取失败：客户端重试后放弃采集，录制主流程不受影响', async () => {
    process.env.DANMAKU_NATIVE_PLATFORMS = 'huya';
    axios.get.mockRejectedValue(new Error('room page 404'));
    const captureId = await DanmakuRecorder.startCapture({
      sessionId: 105,
      roomId: 9,
      roomUrl: ROOM + '-baduid',
      platform: 'huya',
      recordingStartedAt: Date.now(),
    });
    // startCapture 正常返回（弹幕失败不影响录制）
    expect(captureId).toBe(77);
    await flush(300);
    const session = DanmakuRecorder.getSession(ROOM + '-baduid');
    expect(session).toBeTruthy();
    // stopCapture 照常收口
    await DanmakuRecorder.stopCapture(ROOM + '-baduid');
  }, 15000);
});

describe('骨架行为：心跳与断线重连（测试专用平台客户端）', () => {
  const { DanmakuClientBase } = require('../server/lib/core/danmaku/client/DanmakuClientBase');
  const noopLogger = { info: () => {}, important: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  class TinyHeartbeatClient extends DanmakuClientBase {
    constructor(opts) {
      super({ platform: 'tiny', ...opts });
      this.endpoints = opts.endpoints;
      this.ack = opts.ack;
    }
    async getConnectionInfo() {
      return {
        transport: 'ws',
        endpoints: this.endpoints,
        registration: [Buffer.from([1])],
        heartbeat: { data: Buffer.from([2]), intervalMs: 50, ackTimeoutMs: 500 },
      };
    }
    decode(chunk) {
      // 心跳响应（单字节 0x3）触发 ack
      if (chunk.length === 1 && chunk[0] === 0x3) {
        this._markHeartbeatAck();
      }
      return [];
    }
  }

  test('心跳正常发送 + ack 到期检测：无 ack 时主动断开并按退避重连', async () => {
    let connCount = 0;
    let clientRef = null;
    const s = await new Promise((resolve) => {
      const srv = new WebSocketServer({ port: 0 }, () => { console.log('DBG server listening'); resolve(srv); });
    });
    const port = s.address().port;
    console.log('DBG port', port);
    s.on('connection', (ws) => {
      connCount++;
      // 收到心跳但不回 ack
      ws.on('message', () => {});
    });

    clientRef = new TinyHeartbeatClient({
      roomUrl: 'mock://tiny-noack',
      endpoints: [`ws://127.0.0.1:${port}`],
      logger: noopLogger,
    });
    clientRef.start();
    console.log('DBG client started');

    // 50ms 心跳、500ms ack 窗口、1s 退避 → 2.6s 内至少一次「心跳超时断开 → 重连」
    await flush(2600);
    console.log('DBG flushed 2600, conn', connCount, 'stats', JSON.stringify(clientRef.stats));
    clientRef.destroy('test done');
    // close 回调可能因半关闭连接悬挂，加超时兜底
    await Promise.race([new Promise((r) => s.close(() => r())), flush(500)]);
    expect(connCount).toBeGreaterThanOrEqual(2);
    expect(clientRef.stats.reconnectCount).toBeGreaterThanOrEqual(1);
  }, 10000);

  test('心跳有 ack：连接保持稳定不重连', async () => {
    let connCount = 0;
    let clientRef = null;
    const s = new WebSocketServer({ port: 0 }, () => {
      const port = s.address().port;
      const client = new TinyHeartbeatClient({
        roomUrl: 'mock://tiny-ack',
        endpoints: [`ws://127.0.0.1:${port}`],
        ack: true,
        logger: noopLogger,
      });
      clientRef = client;
      client.start();
      setTimeout(() => {
        client.destroy('test done');
        s.close();
      }, 800);
    });
    s.on('connection', (ws) => {
      connCount++;
      ws.on('message', (data) => {
        if (Buffer.from(data)[0] === 2) {
          ws.send(Buffer.from([0x3])); // 回 ack
        }
      });
    });
    await flush(900);
    expect(connCount).toBe(1);
    expect(clientRef.stats.reconnectCount).toBe(0);
    expect(clientRef.stats.connectCount).toBe(1);
  }, 10000);

  test('TCP 传输：net.Socket 连接、注册包、数据帧解码', async () => {
    const received = [];
    const server = net.createServer((socket) => {
      socket.on('data', (d) => received.push(d));
      // 收到注册包后回一帧数据
      socket.on('data', (d) => {
        if (d.toString() === 'REG') {
          socket.write('DATA');
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const events = [];
    class TinyTcpClient extends DanmakuClientBase {
      constructor() {
        super({ platform: 'tinycp', roomUrl: 'mock://tcp', logger: noopLogger });
      }
      async getConnectionInfo() {
        return {
          transport: 'tcp',
          endpoints: [{ host: '127.0.0.1', port }],
          registration: [Buffer.from('REG')],
          heartbeat: null,
        };
      }
      decode(chunk) {
        const text = chunk.toString();
        return text === 'DATA' ? [{ type: 'comment', user: 'u', userId: '1', text: 'hi', ts_abs_ms: Date.now() }] : [];
      }
    }
    const client = new TinyTcpClient();
    client.onEvent = (e) => events.push(e);
    client.start();

    await flush(300);
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].toString()).toBe('REG');
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('hi');

    client.destroy();
    await new Promise((r) => server.close(r));
  }, 10000);
});

describe('orphan 兜底路径保持不变', () => {
  test('无活跃会话 writeBatch → 落 orphan 文件', async () => {
    // stopCapture 后再写 → no_active_session
    const result = await DanmakuRecorder.writeBatch('https://www.huya.com/orphan-check', [
      { ts_abs_ms: Date.now(), type: 'comment', user: 'u', userId: '1', text: 'late' },
    ]);
    expect(result.error).toBe('no_active_session');
    expect(result.orphan).toBeTruthy();
    expect(fs.existsSync(result.orphan.raw_path)).toBe(true);
    const content = fs.readFileSync(result.orphan.raw_path, 'utf8').trim().split('\n');
    const meta = JSON.parse(content[0]);
    expect(meta._meta.schema).toBe('orphan-v1');
  });
});
