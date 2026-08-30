/**
 * DouyuDanmakuClient — 斗鱼弹幕客户端（v1.10.0）
 *
 * 协议（移植自 biliup `protocols/douyu.rs`）：
 * - **裸 TCP**（danmuproxy.douyu.com:8601，8602 兜底）——第三方长期公共代理端点，
 *   非官方契约，断流属预期内风险，靠重连兜底
 * - 帧结构：4 字节长度(LE) + 4 字节长度(LE) + 4 字节消息类型(LE, 689) + STT 文本 + \0；
 *   声明长度从第 4 字节起算（= 8 + type(4) - 4 + body + 1），一帧可含多条消息、
 *   一条消息也可跨 TCP 分片（客户端内部按声明长度攒缓冲）
 * - STT 纯文本协议：注册发 loginreq + joingroup(gid=-9999) 两包，心跳 45s（type@=mrkl/）
 * - 消息映射：chatmsg → comment（nn/txt/uid；col 颜色码不在 JSONL 事件契约内，忽略）；
 *   dgb → gift（gfn/gfcnt，斗鱼不提供金额）；uenter 进场丢弃（信息噪声大，仅 debug）；
 *   loginres 忽略
 */
const stt = require('../../codec/stt');
const { DanmakuClientBase } = require('../DanmakuClientBase');

const DEFAULT_ENDPOINTS = [
  { host: 'danmuproxy.douyu.com', port: 8601 },
  { host: 'danmuproxy.douyu.com', port: 8602 },
];

const MSG_TYPE = 689; // 0x02b1

/** 心跳帧：type@=mrkl/\0（声明长度 20） */
const HEARTBEAT = Buffer.from([
  0x14, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0xb1, 0x02, 0x00, 0x00, 0x74, 0x79, 0x70, 0x65,
  0x40, 0x3d, 0x6d, 0x72, 0x6b, 0x6c, 0x2f, 0x00,
]);

/** 测试/开发口：覆盖 TCP 端点（逗号分隔 host:port） */
function resolveEndpoints() {
  const raw = process.env.DOUYU_DANMAKU_TCP_ENDPOINTS;
  if (!raw) return DEFAULT_ENDPOINTS;
  const endpoints = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const idx = s.lastIndexOf(':');
      return { host: s.slice(0, idx), port: parseInt(s.slice(idx + 1), 10) };
    })
    .filter((e) => e.host && Number.isFinite(e.port));
  return endpoints.length > 0 ? endpoints : DEFAULT_ENDPOINTS;
}

function extractRoomId(url) {
  const m = /douyu\.com\/(\d+)/.exec(url || '');
  return m ? m[1] : null;
}

/**
 * 构造 STT 数据帧
 * @param {string} data - STT 文本（如 type@=loginreq/roomid@=123/）
 * @returns {Buffer}
 */
function buildPacket(data) {
  const body = Buffer.from(data, 'utf8');
  const length = 9 + body.length; // 从第 4 字节起算：len(4)+type(4)-4+body+\0
  const packet = Buffer.alloc(4 + length);
  packet.writeUInt32LE(length, 0);
  packet.writeUInt32LE(length, 4);
  packet.writeUInt32LE(MSG_TYPE, 8);
  body.copy(packet, 12);
  packet[packet.length - 1] = 0x00;
  return packet;
}

/** 单条 STT 消息 → 标准化事件（无事件返回 null） */
function parseSttMessage(text) {
  const msg = stt.decode(text);
  const type = stt.getStr(msg, 'type');
  if (!type) return null;

  switch (type) {
    case 'chatmsg': {
      const text2 = stt.getStr(msg, 'txt');
      if (!text2) return null;
      return {
        type: 'comment',
        user: stt.getStr(msg, 'nn') || '',
        userId: stt.getStr(msg, 'uid') || '',
        text: text2,
      };
    }
    case 'dgb': {
      return {
        type: 'gift',
        user: stt.getStr(msg, 'nn') || '',
        userId: stt.getStr(msg, 'uid') || '',
        giftName: stt.getStr(msg, 'gfn') || '礼物',
        count: Math.max(1, parseInt(stt.getStr(msg, 'gfcnt'), 10) || 1),
      };
    }
    case 'uenter':
    case 'loginres':
    default:
      return null;
  }
}

/**
 * 从帧缓冲解析所有完整帧（声明长度 < 16 视为脏数据，丢弃缓冲）。
 * @param {Buffer} buf
 * @returns {{events: Array<Object>, rest: Buffer}}
 */
function parseFrames(buf) {
  const events = [];
  let start = 0;
  while (start + 4 <= buf.length) {
    const length = buf.readUInt32LE(start);
    if (length < 16 || start + 4 + length > buf.length) {
      // length < 16 不可能合法（至少 12 头 + \0）；数据不足则等待更多分片
      if (length < 16) {
        return { events, rest: Buffer.alloc(0) };
      }
      break;
    }
    const bodyStart = start + 12;
    const bodyEnd = start + 4 + length - 1; // 去掉 \0 结尾
    if (bodyEnd > bodyStart) {
      const text = buf.toString('utf8', bodyStart, bodyEnd);
      const event = parseSttMessage(text);
      if (event) {
        events.push(event);
      }
    }
    start += 4 + length;
  }
  return { events, rest: buf.subarray(start) };
}

class DouyuDanmakuClient extends DanmakuClientBase {
  constructor(opts) {
    super({ platform: 'douyu', ...opts });
    this._tcpBuf = Buffer.alloc(0); // TCP 分片攒缓冲
  }

  async getConnectionInfo() {
    const roomId = extractRoomId(this.roomUrl);
    if (!roomId) {
      throw new Error(`无法从 URL 提取斗鱼房间号: ${this.roomUrl}`);
    }
    return {
      transport: 'tcp',
      endpoints: resolveEndpoints(),
      registration: [
        buildPacket(`type@=loginreq/roomid@=${roomId}/`),
        buildPacket(`type@=joingroup/rid@=${roomId}/gid@=-9999/`),
      ],
      heartbeat: { data: HEARTBEAT, intervalMs: 45000, ackTimeoutMs: null },
    };
  }

  /**
   * TCP 数据分片处理：攒缓冲 → 解析完整帧 → 保留半帧尾部。
   * 心跳没有应用层响应（服务端不回 mrkl 包），不做 ack 超时检测，
   * 连接活性由 TCP close/error 事件驱动重连。
   */
  decode(chunk) {
    this._tcpBuf = Buffer.concat([this._tcpBuf, chunk]);
    const { events, rest } = parseFrames(this._tcpBuf);
    this._tcpBuf = Buffer.from(rest);
    if (events.length > 0) {
      const now = Date.now();
      for (const e of events) {
        e.ts_abs_ms = now;
      }
    }
    return events;
  }
}

module.exports = {
  DouyuDanmakuClient,
  extractRoomId,
  buildPacket,
  parseFrames,
  parseSttMessage,
  HEARTBEAT,
  MSG_TYPE,
  DEFAULT_ENDPOINTS,
};
