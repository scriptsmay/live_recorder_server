const { TarsWriter, TYPE } = require('../server/lib/core/danmaku/codec/tars/writer');
const { TarsReader } = require('../server/lib/core/danmaku/codec/tars/reader');

/**
 * biliup huya.rs:39 硬编码的心跳包（预编码 TARS RequestPacket）。
 * 这是 TARS reader 正确性的硬标准：来自真实虎牙协议、被 biliup 生产使用。
 */
const BILIUP_HEARTBEAT = Buffer.from([
  0x00, 0x03, 0x1d, 0x00, 0x00, 0x69, 0x00, 0x00, 0x00, 0x69, 0x10, 0x03, 0x2c, 0x3c, 0x4c, 0x56,
  0x08, 0x6f, 0x6e, 0x6c, 0x69, 0x6e, 0x65, 0x75, 0x69, 0x66, 0x0f, 0x4f, 0x6e, 0x55, 0x73, 0x65,
  0x72, 0x48, 0x65, 0x61, 0x72, 0x74, 0x42, 0x65, 0x61, 0x74, 0x7d, 0x00, 0x00, 0x3c, 0x08, 0x00,
  0x01, 0x06, 0x04, 0x74, 0x52, 0x65, 0x71, 0x1d, 0x00, 0x00, 0x2f, 0x0a, 0x0a, 0x0c, 0x16, 0x00,
  0x26, 0x00, 0x36, 0x07, 0x61, 0x64, 0x72, 0x5f, 0x77, 0x61, 0x70, 0x46, 0x00, 0x0b, 0x12, 0x03,
  0xae, 0xf0, 0x0f, 0x22, 0x03, 0xae, 0xf0, 0x0f, 0x3c, 0x42, 0x6d, 0x52, 0x02, 0x60, 0x5c, 0x60,
  0x01, 0x7c, 0x82, 0x00, 0x0b, 0xb0, 0x1f, 0x9c, 0xac, 0x0b, 0x8c, 0x98, 0x0c, 0xa8, 0x0c, 0x20,
]);

/** biliup build_ws_command(1, WSUserInfo(12345)) 的期望字节（手工推导，逐字节核对） */
const REGISTER_PACKET_UID_12345 = Buffer.from([
  0x00, 0x01, // WebSocketCommand: tag0 = 1 (REGISTER_REQ)，最小化编码为 int8
  0x1d, 0x00, 0x00, 0x0f, // tag1 bytes: inner int8 head + int8 长度 15
  0x01, 0x30, 0x39, // WSUserInfo tag0 int16 = 12345
  0x1c, // tag1 zero (bAnonymous=false)
  0x26, 0x00, // tag2 string1 "" (sGuid)
  0x36, 0x00, // tag3 string1 "" (sToken)
  0x4c, // tag4 zero (lTid)
  0x5c, // tag5 zero (lSid)
  0x61, 0x30, 0x39, // tag6 int16 = 12345 (lGroupId)
  0x70, 0x03, // tag7 int8 = 3 (lGroupType)
]);

// 与 biliup huya.rs 同款注册包构造
function buildWsUserInfo(uid) {
  const w = new TarsWriter();
  w.writeInt64(0, uid);
  w.writeBool(1, false);
  w.writeString(2, '');
  w.writeString(3, '');
  w.writeInt64(4, 0);
  w.writeInt64(5, 0);
  w.writeInt64(6, uid);
  w.writeInt64(7, 3);
  return w.toBuffer();
}

function buildWsCommand(cmdType, data) {
  const w = new TarsWriter();
  w.writeInt32(0, cmdType);
  w.writeBytes(1, data);
  return w.toBuffer();
}

describe('TARS writer — 固定字节向量', () => {
  test('注册包 WSUserInfo(12345) + WebSocketCommand(1) 逐字节匹配', () => {
    const packet = buildWsCommand(1, buildWsUserInfo(12345));
    expect(packet.equals(REGISTER_PACKET_UID_12345)).toBe(true);
  });

  test('biliup 硬编码心跳包（112 字节）可被 reader 正确解构', () => {
    const r = new TarsReader(BILIUP_HEARTBEAT);
    expect(r.readInt32(0)).toBe(3); // iVersion
    const payload = r.readBytes(1);
    expect(payload).not.toBeNull();
    // 载荷内含 RPC 方法名（ASCII 可读），证明字节对齐无误
    const s = payload.toString('latin1');
    expect(s).toContain('onlineuif');
    expect(s).toContain('OnUserHeartBeat');
  });
});

describe('TARS writer/reader round-trip', () => {
  test.each([
    ['int8 边界', (w) => w.writeInt8(0, -128), (r) => r.readInt(0), -128],
    ['int16 边界', (w) => w.writeInt16(1, 32767), (r) => r.readInt(1), 32767],
    ['int16 负数', (w) => w.writeInt16(2, -300), (r) => r.readInt(2), -300],
    ['int32 边界', (w) => w.writeInt32(3, -2147483648), (r) => r.readInt(3), -2147483648],
    ['zero 最小编码', (w) => w.writeInt32(4, 0), (r) => r.readInt(4), 0],
    [
      'int64 超出 i32（BigInt）',
      (w) => w.writeInt64(5, 9007199254740993n),
      (r) => r.readInt(5),
      9007199254740993n,
    ],
    [
      'int64 负大数',
      (w) => w.writeInt64(6, -9007199254740993n),
      (r) => r.readInt(6),
      -9007199254740993n,
    ],
  ])('%s', (_name, write, read, expected) => {
    const w = new TarsWriter();
    write(w);
    const r = new TarsReader(w.toBuffer());
    expect(read(r)).toBe(expected);
  });

  test('字符串 round-trip（含 CJK 与超长 string4）', () => {
    const w = new TarsWriter();
    w.writeString(0, '你好，世界');
    w.writeString(1, '');
    w.writeString(2, 'x'.repeat(300)); // 超 255 → STRING4
    const r = new TarsReader(w.toBuffer());
    expect(r.readString(0)).toBe('你好，世界');
    expect(r.readString(1)).toBe('');
    expect(r.readString(2)).toBe('x'.repeat(300));
  });

  test('bytes round-trip', () => {
    const w = new TarsWriter();
    w.writeBytes(1, Buffer.from([0, 1, 2, 255]));
    w.writeBytes(2, Buffer.alloc(0));
    const r = new TarsReader(w.toBuffer());
    expect(r.readBytes(1).equals(Buffer.from([0, 1, 2, 255]))).toBe(true);
    expect(r.readBytes(2).length).toBe(0);
  });

  test('嵌套 struct round-trip（writeStruct 便捷方法）', () => {
    const w = new TarsWriter();
    w.writeStruct(0, (inner) => {
      inner.writeString(2, 'nested-name');
      inner.writeInt32(5, 42);
    });
    w.writeString(3, 'outer');

    // 顶层读到 tag 3
    const rOuter = new TarsReader(w.toBuffer());
    expect(rOuter.readString(3)).toBe('outer');

    // struct 体逐字段解码：定位 tag 0 → 消费 struct begin head → 在体内按 tag 读
    const rInner = new TarsReader(w.toBuffer());
    expect(rInner.skipToTag(0)).toBe(true);
    const head = rInner.readHead();
    expect(head.type).toBe(TYPE.STRUCT_BEGIN);
    expect(rInner.readString(2)).toBe('nested-name');
    expect(rInner.readInt32(5)).toBe(42);
  });
});

describe('TARS reader — 未知 tag / 未知类型容错', () => {
  test('跳过中间未知字段读取目标 tag', () => {
    const w = new TarsWriter();
    w.writeString(1, 'skip-me');
    w.writeBytes(3, Buffer.alloc(20));
    w.writeInt32(7, 99);
    const r = new TarsReader(w.toBuffer());
    expect(r.readInt32(7)).toBe(99);
  });

  test('skipToTag 命中 StructEnd / tag 越界返回 false 且不抛错', () => {
    const w = new TarsWriter();
    w.writeInt32(0, 1);
    w.writeString(2, 'end-here');
    const r = new TarsReader(w.toBuffer());
    expect(r.readInt32(0)).toBe(1);
    expect(r.readString(5)).toBeNull(); // tag 2 < 5 → 越过即停
    expect(r.readInt32(1)).toBeNull();
  });

  test('截断的字节流不抛错（网络半包容错）', () => {
    const truncated = BILIUP_HEARTBEAT.subarray(0, 50);
    const r = new TarsReader(truncated);
    expect(r.readInt32(0)).toBe(3);
    // 截断的 bytes 字段：长度声明超出实际 → null 而非异常
    expect(() => r.readBytes(1)).not.toThrow();
  });

  test('forEachField 遍历顶层字段并跳过嵌套 struct', () => {
    const w = new TarsWriter();
    w.writeInt32(0, 7);
    w.writeStruct(1, (inner) => inner.writeString(0, 'deep'));
    w.writeString(2, 'tail');
    const r = new TarsReader(w.toBuffer());
    const seen = [];
    r.forEachField(({ tag, type }) => seen.push({ tag, type }));
    expect(seen.map((s) => s.tag)).toEqual([0, 1, 2]);
    expect(seen[1].type).toBe(TYPE.STRUCT_BEGIN);
  });
});
