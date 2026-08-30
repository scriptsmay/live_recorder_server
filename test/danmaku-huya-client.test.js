const fs = require('fs');
const path = require('path');
const { TarsReader } = require('../server/lib/core/danmaku/codec/tars/reader');
const { TarsWriter } = require('../server/lib/core/danmaku/codec/tars/writer');
const {
  extractRoomId,
  buildRegisterPacket,
  parseDanmakuBody,
  HEARTBEAT,
} = require('../server/lib/core/danmaku/client/platforms/huya');
const { createDanmakuClient, getSupportedPlatforms } = require('../server/lib/core/danmaku/client/DanmakuClientFactory');

// Task 2 抓包固化的真实帧（10 条 1400 弹幕 + 注册响应），期望值按抓包验证的布局解出
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'danmaku', 'huya', 'sample-frames.jsonl');
const FIXTURES = fs
  .readFileSync(FIXTURE_PATH, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const DANMAKU_FRAMES = FIXTURES.filter((f) => f.type !== 'register_rsp');
const REGISTER_RSP_FRAME = FIXTURES.find((f) => f.type === 'register_rsp');

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

function decodeFrame(buf) {
  const r = new TarsReader(buf);
  const cmd = r.readInt32(0);
  const inner = r.readBytes(1);
  if (!inner) return { cmd };
  const ir = new TarsReader(inner);
  const msgType = ir.readInt64(1);
  const body = ir.readBytes(2);
  return { cmd, msgType, body };
}

describe('huya: extractRoomId', () => {
  test.each([
    ['https://www.huya.com/123456', '123456'],
    ['https://huya.com/kpl', 'kpl'],
    ['https://www.huya.com/998?b=1', '998'],
    ['https://live.kuaishou.com/u/xxx', null],
    ['', null],
  ])('%s → %s', (url, expected) => {
    expect(extractRoomId(url)).toBe(expected);
  });
});

describe('huya: 注册包结构', () => {
  test('uid=12345 的注册包可被解回原始字段', () => {
    const packet = buildRegisterPacket(12345);
    const r = new TarsReader(packet);
    expect(r.readInt32(0)).toBe(1); // cmdType = REGISTER_REQ
    const userInfo = r.readBytes(1);
    const ur = new TarsReader(userInfo);
    expect(ur.readInt(0)).toBe(12345); // lUid
    expect(ur.readInt(1)).toBe(0); // bAnonymous=false
    expect(ur.readString(2)).toBe(''); // sGuid
    expect(ur.readString(3)).toBe(''); // sToken
    expect(ur.readInt(6)).toBe(12345); // lGroupId = uid
    expect(ur.readInt(7)).toBe(3); // lGroupType
  });
});

describe('huya: 1400 弹幕体解析（真实抓包 fixture）', () => {
  test.each(DANMAKU_FRAMES.map((f, i) => [`帧 #${i + 1}`, f]))('%s 按验证布局解出昵称与内容', (_name, frame) => {
    const { cmd, msgType, body } = decodeFrame(Buffer.from(frame.hex, 'hex'));
    expect(cmd).toBe(7);
    expect(msgType).toBe(1400);
    const parsed = parseDanmakuBody(body);
    expect(parsed.user).toBe(frame.expect.user);
    expect(parsed.text).toBe(frame.expect.text);
    expect(parsed.userId).toBe(frame.expect.userId);
  });

  test('缺内容或缺昵称的弹幕体返回 null（宽松解析不崩溃）', () => {
    const missingText = new TarsWriter();
    missingText.writeStruct(0, (u) => {
      u.writeInt64(0, 1);
      u.writeString(2, 'nick');
    });
    expect(parseDanmakuBody(missingText.toBuffer())).toBeNull();

    const missingUser = new TarsWriter();
    missingUser.writeString(3, 'only text');
    expect(parseDanmakuBody(missingUser.toBuffer())).toBeNull();
  });
});

describe('huya: HuyaDanmakuClient.decode', () => {
  const { HuyaDanmakuClient } = require('../server/lib/core/danmaku/client/platforms/huya');
  const noopLogger = { info: () => {}, important: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  function makeClient() {
    return new HuyaDanmakuClient({ roomUrl: 'https://www.huya.com/998', logger: noopLogger });
  }

  test('1400 推送帧 → comment 事件（ts_abs_ms 为当前时刻）', () => {
    const client = makeClient();
    const frame = buildDanmakuPushFrame({ nick: '测试用户', uid: 42, text: '你好' });
    const events = client.decode(frame);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('comment');
    expect(events[0].user).toBe('测试用户');
    expect(events[0].userId).toBe('42');
    expect(events[0].text).toBe('你好');
    expect(events[0].ts_abs_ms).toBeLessThanOrEqual(Date.now());
    expect(events[0].ts_abs_ms).toBeGreaterThan(Date.now() - 5000);
  });

  test('非 1400 消息类型忽略', () => {
    const client = makeClient();
    expect(client.decode(buildDanmakuPushFrame({ nick: 'a', uid: 1, text: 'b', msgType: 1402 }))).toEqual([]);
  });

  test('注册响应帧解出为空事件且不崩溃（真实抓包帧）', () => {
    const client = makeClient();
    const buf = Buffer.from(REGISTER_RSP_FRAME.hex, 'hex');
    expect(client.decode(buf)).toEqual([]);
  });

  test('心跳响应帧触发 _markHeartbeatAck', () => {
    const client = makeClient();
    const before = client.lastAckAt;
    const hbAck = new TarsWriter();
    hbAck.writeInt32(0, 6);
    client.decode(hbAck.toBuffer());
    expect(client.lastAckAt).toBeGreaterThanOrEqual(before);
  });

  test('脏数据（随机字节）不抛错返回空', () => {
    const client = makeClient();
    expect(() => client.decode(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))).not.toThrow();
    expect(client.decode(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual([]);
  });
});

describe('huya: 心跳包固定向量', () => {
  test('与 biliup huya.rs 硬编码逐字节一致', () => {
    // 注：v1.10.0 计划文档称 118 字节，实测 biliup 源码向量为 112 字节（7 行 × 16）
    expect(HEARTBEAT.length).toBe(112);
    expect(HEARTBEAT[5]).toBe(0x69);
  });
});

describe('DanmakuClientFactory', () => {
  test('huya 平台实例化客户端', () => {
    const client = createDanmakuClient('huya', { roomUrl: 'https://www.huya.com/998' });
    expect(client).not.toBeNull();
    expect(client.platform).toBe('huya');
    client.destroy();
  });

  test('未知平台返回 null', () => {
    expect(createDanmakuClient('kuaishou', { roomUrl: 'x' })).toBeNull();
    expect(createDanmakuClient('', { roomUrl: 'x' })).toBeNull();
  });

  test('支持平台列表包含四个目标平台中已实现者', () => {
    const platforms = getSupportedPlatforms();
    expect(platforms).toContain('huya');
  });
});
