const zlib = require('zlib');
const {
  extractRoomId,
  buildPacket,
  buildAuthPacket,
  decodePackets,
  parseDanmuMsg,
  parseSendGift,
  parseGuardBuy,
  parseSuperChat,
  generateFakeBuvid3,
  HEARTBEAT,
  OP,
  VER,
  DEFAULT_WS_URL,
  MAX_DECODE_DEPTH,
} = require('../server/lib/core/danmaku/client/platforms/bilibili');
const { createMixinKey, extractKey } = require('../server/lib/core/danmaku/codec/wbi');

/** 构造指定协议版本的数据包（buildPacket 固定 ver=1） */
function buildPacketWithVersion(body, operation, version) {
  const packet = buildPacket(body, operation);
  packet.writeUInt16BE(version, 6);
  return packet;
}

function zlibCompress(data) {
  return zlib.deflateSync(data);
}

describe('bilibili: extractRoomId', () => {
  test.each([
    ['https://live.bilibili.com/12345', '12345'],
    ['https://live.bilibili.com/123?from=abc', '123'],
    ['https://live.bilibili.com/h5/23058', null], // 非纯数字路径不匹配（与 biliup 一致）
    ['https://www.huya.com/998', null],
  ])('%s → %s', (url, expected) => {
    expect(extractRoomId(url)).toBe(expected);
  });
});

describe('bilibili: 包头构建', () => {
  test('buildPacket 头部字段与 biliup 一致', () => {
    const body = Buffer.from('test');
    const packet = buildPacket(body, OP.AUTH);
    expect(packet.readUInt32BE(0)).toBe(20); // 16 + 4
    expect(packet.readUInt16BE(4)).toBe(16);
    expect(packet.readUInt16BE(6)).toBe(1);
    expect(packet.readUInt32BE(8)).toBe(OP.AUTH);
    expect(packet.readUInt32BE(12)).toBe(1);
    expect(packet.subarray(16).equals(body)).toBe(true);
  });

  test('心跳包固定字节：op=2, body="[object Object] "', () => {
    // biliup 源码向量：body 16 字节（含尾随空格）+ 16 字节包头 = 32；包头声明 31 为上游固有怪癖
    expect(HEARTBEAT.length).toBe(32);
    expect(HEARTBEAT.readUInt32BE(8)).toBe(2);
    expect(HEARTBEAT.subarray(16).toString()).toBe('[object Object] ');
  });
});

describe('bilibili: 切包与解压（含恶意输入防护，对齐 biliup 修复）', () => {
  test('裸 JSON 包解码', () => {
    const body = Buffer.from('{"cmd":"TEST"}');
    const packet = buildPacket(body, OP.NOTIFICATION);
    const decoded = decodePackets(packet);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].operation).toBe(OP.NOTIFICATION);
    expect(decoded[0].body.equals(body)).toBe(true);
  });

  test('packet_len=0：不 panic 不死循环，返回空', () => {
    const packet = buildPacket(Buffer.from('{"cmd":"TEST"}'), OP.NOTIFICATION);
    packet.writeUInt32BE(0, 0);
    expect(decodePackets(packet)).toEqual([]);
  });

  test('packet_len<16：丢弃不可信帧', () => {
    const packet = buildPacket(Buffer.from('{"cmd":"TEST"}'), OP.NOTIFICATION);
    packet.writeUInt32BE(8, 0);
    expect(decodePackets(packet)).toEqual([]);
  });

  test('合法包之后跟畸形头：保留已解析的包', () => {
    const body = Buffer.from('{"cmd":"TEST"}');
    const data = Buffer.concat([
      buildPacket(body, OP.NOTIFICATION),
      (() => {
        const garbage = buildPacket(Buffer.from('x'), OP.NOTIFICATION);
        garbage.writeUInt32BE(3, 0);
        return garbage;
      })(),
    ]);
    const decoded = decodePackets(data);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].body.equals(body)).toBe(true);
  });

  test('一层 zlib 压缩（真实协议形态）解码', () => {
    const body = Buffer.from('{"cmd":"TEST"}');
    const inner = buildPacket(body, OP.NOTIFICATION);
    const packet = buildPacketWithVersion(zlibCompress(inner), OP.NOTIFICATION, VER.ZLIB);
    const decoded = decodePackets(packet);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].body.equals(body)).toBe(true);
  });

  test('brotli 压缩解码（Node 内置 zlib.brotliDecompressSync）', () => {
    const body = Buffer.from('{"cmd":"TEST"}');
    const inner = buildPacket(body, OP.NOTIFICATION);
    const packet = buildPacketWithVersion(zlib.brotliCompressSync(inner), OP.NOTIFICATION, VER.BROTLI);
    const decoded = decodePackets(packet);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].body.equals(body)).toBe(true);
  });

  test('超过深度上限的恶意多层压缩嵌套被丢弃（防栈溢出）', () => {
    let data = buildPacket(Buffer.from('{"cmd":"TEST"}'), OP.NOTIFICATION);
    for (let i = 0; i < MAX_DECODE_DEPTH + 8; i++) {
      data = buildPacketWithVersion(zlibCompress(data), OP.NOTIFICATION, VER.ZLIB);
    }
    expect(decodePackets(data)).toEqual([]);
  });
});

describe('bilibili: 消息映射', () => {
  test('DANMU_MSG → comment（昵称/uid/内容）', () => {
    const json = {
      cmd: 'DANMU_MSG:4:0:2:2:2:0',
      info: [
        [0, 1, 25, 16777215, 0, 0, 0, '', 0, 0, 0, '', 0, '{}', '{}', { extra: '{}' }],
        'Hello World',
        [12345, 'TestUser'],
      ],
    };
    const event = parseDanmuMsg(json);
    expect(event.type).toBe('comment');
    expect(event.text).toBe('Hello World');
    expect(event.user).toBe('TestUser');
    expect(event.userId).toBe('12345');
  });

  test('DANMU_MSG 表情包 → `表情【...】`', () => {
    const json = {
      cmd: 'DANMU_MSG',
      info: [
        [
          0, 1, 25, 16777215, 0, 0, 0, '', 0, 0, 0, '', 0, '{}', '{}',
          { extra: JSON.stringify({ emoticon_unique: 'upower_emoji:123' }) },
        ],
        '原始文本会被替换',
        [1, 'u'],
      ],
    };
    const event = parseDanmuMsg(json);
    expect(event.text).toBe('表情【upower_emoji:123】');
  });

  test('SEND_GIFT → gift', () => {
    const json = {
      cmd: 'SEND_GIFT',
      data: { uname: '礼物哥', uid: 777, giftName: '小花花', num: 3, price: 100 },
    };
    const event = parseSendGift(json);
    expect(event).toMatchObject({ type: 'gift', user: '礼物哥', userId: '777', giftName: '小花花', count: 3 });
  });

  test('GUARD_BUY → gift（上舰）', () => {
    const json = {
      cmd: 'GUARD_BUY',
      data: { username: '舰长哥', uid: 888, gift_name: '舰长', num: 1, price: 198000 },
    };
    const event = parseGuardBuy(json);
    expect(event).toMatchObject({ type: 'gift', user: '舰长哥', giftName: '舰长', count: 1 });
  });

  test('SUPER_CHAT_MESSAGE → comment（付费弹幕内容进字幕）', () => {
    const json = {
      cmd: 'SUPER_CHAT_MESSAGE',
      data: { uid: 999, message: 'SC 内容', price: 30, user_info: { uname: 'SC哥' } },
    };
    const event = parseSuperChat(json);
    expect(event).toMatchObject({ type: 'comment', user: 'SC哥', userId: '999', text: 'SC 内容' });
  });

  test('未知 cmd 忽略', () => {
    const { parseNotification } = require('../server/lib/core/danmaku/client/platforms/bilibili');
    expect(parseNotification(Buffer.from(JSON.stringify({ cmd: 'ENTRY_EFFECT', data: {} })))).toBeNull();
    expect(parseNotification(Buffer.from('not json'))).toBeNull();
  });
});

describe('bilibili: 客户端 decode', () => {
  const { BilibiliDanmakuClient } = require('../server/lib/core/danmaku/client/platforms/bilibili');
  const noopLogger = { info: () => {}, important: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  function makeClient() {
    return new BilibiliDanmakuClient({ roomUrl: 'https://live.bilibili.com/123', logger: noopLogger });
  }

  test('op=5 通知包 → comment 事件', () => {
    const client = makeClient();
    const json = JSON.stringify({
      cmd: 'DANMU_MSG',
      info: [[0, 1, 25, 16777215], '弹幕内容', [42, '用户']],
    });
    const events = client.decode(buildPacket(Buffer.from(json), OP.NOTIFICATION));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'comment', user: '用户', userId: '42', text: '弹幕内容' });
    expect(events[0].ts_abs_ms).toBeLessThanOrEqual(Date.now());
  });

  test('op=3 心跳响应触发 ack 标记；op=8 认证响应不产事件', () => {
    const client = makeClient();
    const before = client.lastAckAt;
    expect(client.decode(buildPacket(Buffer.alloc(4), OP.HEARTBEAT_REPLY))).toEqual([]);
    expect(client.lastAckAt).toBeGreaterThanOrEqual(before);
    expect(client.decode(buildPacket(Buffer.from('{}'), OP.AUTH_REPLY))).toEqual([]);
  });

  test('认证包结构：uid=0 匿名 + protover=3 + roomid', () => {
    const packet = buildAuthPacket(23058, 'tok-token');
    expect(packet.readUInt32BE(8)).toBe(OP.AUTH);
    const auth = JSON.parse(packet.subarray(16).toString());
    expect(auth).toMatchObject({ uid: 0, roomid: 23058, protover: 3, platform: 'web', type: 2, key: 'tok-token' });
  });
});

describe('bilibili: buvid3 与 WBI', () => {
  test('伪造 buvid3 为 UUID 格式且以 infoc 结尾', () => {
    const buvid = generateFakeBuvid3();
    expect(buvid.endsWith('infoc')).toBe(true);
    expect(buvid.split('-')).toHaveLength(5);
  });

  test('WBI extractKey', () => {
    expect(extractKey('https://i0.hdslb.com/bfs/wbi/abc123.png')).toBe('abc123');
  });

  test('WBI mixin key：KEY_MAP 重排取前 32 位（回归向量）', () => {
    // 固定输入的输出 pin 为回归向量（算法对齐 biliup wbi.rs create_mixin_key）
    const key = createMixinKey('0123456789abcdef0123456789abcdef', 'fedcba9876543210fedcba9876543210');
    expect(key).toHaveLength(32);
    // KEY_MAP 前 8 位: 46,47,18,2,53,8,23,32 → full[46..] = '3210','9876','7654','3210'...
    expect(key.slice(0, 8)).toBe('1022a87f');
  });

});

describe('DanmakuClientFactory 注册 bilibili', () => {
  test('bilibili 平台实例化客户端', () => {
    const { createDanmakuClient } = require('../server/lib/core/danmaku/client/DanmakuClientFactory');
    const client = createDanmakuClient('bilibili', { roomUrl: 'https://live.bilibili.com/123' });
    expect(client).not.toBeNull();
    expect(client.platform).toBe('bilibili');
    expect(client.wbiSigner).toBeTruthy();
    client.destroy();
  });
});

describe('默认 WS 地址（-352 风控降级目标）', () => {
  test('DEFAULT_WS_URL 为官方兜底地址', () => {
    expect(DEFAULT_WS_URL).toBe('wss://broadcastlv.chat.bilibili.com/sub');
  });
});
