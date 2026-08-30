const zlib = require('zlib');
const { WebSocketServer } = require('ws');

const {
  ProtoReader,
  ProtoWriter,
  first,
  asU64,
  asStr,
  asBytes,
} = require('../server/lib/core/danmaku/codec/protobuf');
const {
  DouyinDanmakuClient,
  extractRoomId,
  buildWsUrl,
  buildAck,
  generateXbogus,
  generateUserUniqueId,
  getXMsStub,
  parsePushFrame,
  parseChatMessage,
  rc4Encrypt,
  encodeBase64Remapped,
  HEARTBEAT,
  DOUYIN_WS_HOSTS,
} = require('../server/lib/core/danmaku/client/platforms/douyin');

const noopLogger = { info: () => {}, important: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const flush = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// protobuf codec
// ============================================================
describe('protobuf codec', () => {
  test('varint round-trip（含多字节与 BigInt 边界）', () => {
    for (const v of [0, 1, 127, 128, 300, 16384, Number.MAX_SAFE_INTEGER]) {
      const w = new ProtoWriter();
      w.writeVarint(v);
      expect(new ProtoReader(w.toBuffer()).readVarint()).toBe(v);
    }
    const w = new ProtoWriter();
    w.writeVarint(9007199254740993n);
    expect(new ProtoReader(w.toBuffer()).readVarint()).toBe(9007199254740993n);
  });

  test('string / bytes / varint 字段 parseAll', () => {
    const w = new ProtoWriter();
    w.writeString(1, 'hello');
    w.writeVarintField(2, 300);
    w.writeBytes(3, Buffer.from([0, 1, 2, 255]));
    const fields = new ProtoReader(w.toBuffer()).parseAll();
    expect(asStr(first(fields, 1))).toBe('hello');
    expect(asU64(first(fields, 2))).toBe(300);
    expect(asBytes(first(fields, 3)).equals(Buffer.from([0, 1, 2, 255]))).toBe(true);
  });

  test('重复字段（repeated）取数组', () => {
    const w = new ProtoWriter();
    w.writeString(1, 'a');
    w.writeString(1, 'b');
    const fields = new ProtoReader(w.toBuffer()).parseAll();
    expect(fields[1]).toHaveLength(2);
  });

  test('二进制 bytes 不被误判为 string', () => {
    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01]);
    const w = new ProtoWriter();
    w.writeBytes(1, binary);
    const fields = new ProtoReader(w.toBuffer()).parseAll();
    expect(asBytes(first(fields, 1)).equals(binary)).toBe(true);
  });

  test('截断数据不抛错', () => {
    const w = new ProtoWriter();
    w.writeString(1, 'hello world');
    const buf = w.toBuffer().subarray(0, 5); // 截断长度声明
    expect(() => new ProtoReader(buf).parseAll()).not.toThrow();
  });

  test('writeVarintField / buildAck round-trip（对齐 biliup build_ack 测试）', () => {
    const ack = buildAck(12345, 'internal_src:dim|seq:1');
    const fields = new ProtoReader(ack).parseAll();
    expect(asU64(first(fields, 2))).toBe(12345);
    expect(asStr(first(fields, 7))).toBe('ack');
    expect(asStr(first(fields, 8))).toBe('internal_src:dim|seq:1');
  });
});

// ============================================================
// 抖音签名与 URL
// ============================================================
describe('douyin: 签名与 URL', () => {
  test('心跳包为 `:\\x02hb`', () => {
    expect(HEARTBEAT.equals(Buffer.from([0x3a, 0x02, 0x68, 0x62]))).toBe(true);
    expect(HEARTBEAT.toString('binary')).toBe(':\u0002hb');
  });

  test('extractRoomId', () => {
    expect(extractRoomId('https://live.douyin.com/123456789')).toBe('123456789');
    expect(extractRoomId('https://live.douyin.com/abc')).toBeNull();
  });

  test('generateUserUniqueId 落在 biliup 区间', () => {
    const id = generateUserUniqueId();
    const num = BigInt(id);
    expect(num).toBeGreaterThanOrEqual(7300000000000000000n);
    expect(num).toBeLessThan(8000000000000000000n);
  });

  test('getXMsStub 为 32 位 MD5 hex', () => {
    const stub = getXMsStub([
      ['room_id', '123'],
      ['live_id', '1'],
    ]);
    expect(stub).toMatch(/^[0-9a-f]{32}$/);
  });

  test('generateXbogus：16 字符且全部落在自定义字母表', () => {
    const stub = getXMsStub([['room_id', '1']]);
    const sig = generateXbogus(stub, 1);
    expect(sig).toHaveLength(16);
    const alphabet = 'Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe';
    for (const ch of sig) {
      expect(alphabet).toContain(ch);
    }
  });

  test('buildWsUrl：三 host 生成带签名的完整 URL（回归：参数齐全）', () => {
    const url = buildWsUrl('123', DOUYIN_WS_HOSTS[0]);
    expect(url.startsWith(DOUYIN_WS_HOSTS[0])).toBe(true);
    expect(url).toContain('room_id=123');
    expect(url).toContain('signature=');
    expect(url).toContain('compress=gzip');
    expect(url).toContain('identity=audience');
    expect(url.split('&').length).toBeGreaterThanOrEqual(22);
  });

  test('rc4Encrypt 单字节 key：已知自洽性（加密后解密还原）', () => {
    const data = [0x01, 0x02, 0x03, 0x04, 0x05];
    const copy = [...data];
    rc4Encrypt(0xab, data);
    expect(data).not.toEqual(copy); // 确实发生了混淆
    rc4Encrypt(0xab, data); // RC4 流对称：再次异或还原
    expect(data).toEqual(copy);
  });

  test('encodeBase64Remapped：12 字节 → 16 字符且使用抖音字母表', () => {
    const out = encodeBase64Remapped(Buffer.alloc(12, 0xab));
    expect(out).toHaveLength(16);
    const alphabet = Buffer.from('Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe');
    for (const b of out) {
      expect(alphabet.includes(b)).toBe(true);
    }
  });
});

// ============================================================
// 推送解码
// ============================================================
/** 构造一条 gzip 压缩的 PushFrame 推送 */
function buildPushFrame({ logId, method, chat, needAck, internalExt }) {
  const msgWriter = new ProtoWriter();
  msgWriter.writeString(1, method);
  msgWriter.writeBytes(2, chat);
  const response = new ProtoWriter();
  response.writeBytes(1, msgWriter.toBuffer());
  if (needAck) {
    response.writeVarintField(9, 1);
    response.writeString(5, internalExt);
  }
  const frame = new ProtoWriter();
  frame.writeVarintField(2, logId);
  frame.writeString(7, 'msg');
  frame.writeBytes(8, zlib.gzipSync(response.toBuffer()));
  return frame.toBuffer();
}

/** 构造 ChatMessage protobuf（2=user{3=nickName}, 3=content） */
function buildChat(nick, content) {
  const user = new ProtoWriter();
  user.writeString(3, nick);
  const chat = new ProtoWriter();
  chat.writeBytes(2, user.toBuffer());
  chat.writeString(3, content);
  return chat.toBuffer();
}

describe('douyin: 推送解码', () => {
  test('parsePushFrame / parseChatMessage', () => {
    const frame = buildPushFrame({ logId: 777, method: 'WebcastChatMessage', chat: buildChat('抖音用户', '你好呀'), needAck: false });
    const parsed = parsePushFrame(frame);
    expect(parsed.logId).toBe(777);
    // payload 解压后是 Response（含消息列表），需先取消息 payload 再解析 ChatMessage
    const { parseResponse } = require('../server/lib/core/danmaku/client/platforms/douyin');
    const { messages } = parseResponse(zlib.gunzipSync(parsed.payload));
    expect(messages).toHaveLength(1);
    expect(messages[0].method).toBe('WebcastChatMessage');
    const chat = parseChatMessage(messages[0].payload);
    expect(chat).toEqual({ name: '抖音用户', content: '你好呀' });
  });

  test('客户端 decode：WebcastChatMessage → comment 事件；其他 method 忽略', () => {
    const client = new DouyinDanmakuClient({ roomUrl: 'https://live.douyin.com/1', logger: noopLogger });
    const frame = new ProtoWriter();
    const chat1 = buildChat('u1', 'm1');
    const chat2 = buildChat('u2', 'm2');
    const response = new ProtoWriter();
    const m1 = new ProtoWriter();
    m1.writeString(1, 'WebcastChatMessage');
    m1.writeBytes(2, chat1);
    const m2 = new ProtoWriter();
    m2.writeString(1, 'WebcastMemberMessage');
    m2.writeBytes(2, chat2);
    response.writeBytes(1, m1.toBuffer());
    response.writeBytes(1, m2.toBuffer());
    frame.writeVarintField(2, 1);
    frame.writeBytes(8, zlib.gzipSync(response.toBuffer()));

    const events = client.decode(frame.toBuffer());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'comment', user: 'u1', text: 'm1' });
  });

  test('非 gzip 载荷容错（不抛错返回空）', () => {
    const client = new DouyinDanmakuClient({ roomUrl: 'https://live.douyin.com/1', logger: noopLogger });
    const frame = new ProtoWriter();
    frame.writeVarintField(2, 1);
    frame.writeBytes(8, Buffer.from([1, 2, 3]));
    expect(client.decode(frame.toBuffer())).toEqual([]);
  });
});

// ============================================================
// 端到端（mock WS：推送 + ACK 回包 → DanmakuRecorder → JSONL）
// ============================================================
describe('douyin: 端到端', () => {
  let wss;
  let wssPort;
  let received;
  let connections;

  beforeAll(async () => {
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
    await new Promise((r) => wss.close(r));
  });

  beforeEach(() => {
    received = [];
    connections = [];
  });

  test('needAck 推送触发 ACK 回包（logId + internalExt 正确）', async () => {
    const client = new DouyinDanmakuClient({
      roomUrl: 'https://live.douyin.com/999',
      logger: noopLogger,
      onEvent: () => {},
    });
    // 覆盖端点指向 mock server（生产为三抖音 host）
    client.getConnectionInfo = async () => ({
      transport: 'ws',
      endpoints: [`ws://127.0.0.1:${wssPort}`],
      headers: client._buildHeaders(),
      registration: [],
      heartbeat: { data: HEARTBEAT, intervalMs: 10000, ackTimeoutMs: null },
    });
    client.start();

    await flush(300);
    const ws = connections[0];
    const logId = 424242;
    ws.send(
      buildPushFrame({ logId, method: 'WebcastChatMessage', chat: buildChat('抖友', 'ACK 测试'), needAck: true, internalExt: 'internal_src:dim|seq:9' })
    );

    await flush(300);
    // 服务端收到 ACK 包
    expect(received.length).toBeGreaterThanOrEqual(1);
    const ackFields = new ProtoReader(received[0]).parseAll();
    expect(asU64(first(ackFields, 2))).toBe(logId);
    expect(asStr(first(ackFields, 7))).toBe('ack');
    expect(asStr(first(ackFields, 8))).toBe('internal_src:dim|seq:9');

    client.destroy();
  }, 15000);

  test('cookie 策略：DOUYIN_TTWID 环境变量优先', () => {
    process.env.DOUYIN_TTWID = 'ttwid-test-value;';
    const client = new DouyinDanmakuClient({ roomUrl: 'https://live.douyin.com/1', logger: noopLogger });
    const headers = client._buildHeaders();
    expect(headers.Cookie).toBe('ttwid=ttwid-test-value;;');
    delete process.env.DOUYIN_TTWID;
  });
});
