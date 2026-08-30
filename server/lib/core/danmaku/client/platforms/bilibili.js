/**
 * BilibiliDanmakuClient — B站弹幕客户端（v1.10.0）
 *
 * 协议（移植自 biliup `protocols/bilibili.rs`，B站公开成熟的二进制 WS 协议）：
 * - 16 字节包头（packet_len / header_len=16 / version / operation / sequence=1）
 * - version: 0=裸 JSON 1=人气值 2=zlib 3=brotli（Node 内置 zlib，零依赖）
 * - op: 2=心跳 3=心跳响应(人气值) 5=通知 7=认证 8=认证响应
 * - 建连：room_init 短号换真实房间号 → getDanmuInfo（WBI 签名，失败/-352 风控时
 *   降级默认地址 + 空 token）→ 认证包（伪造 buvid3 + 匿名 uid=0, protover=3）
 * - 心跳 30s 固定字节包
 * - 消息映射（激活 DanmakuRecorder 一直空转的 gift 分支）：
 *     DANMU_MSG → comment（表情包转 `表情【...】`）
 *     SEND_GIFT / GUARD_BUY → gift
 *     SUPER_CHAT_MESSAGE → comment（付费弹幕内容进字幕）
 */
const zlib = require('zlib');
const crypto = require('crypto');
const axios = require('axios');
const { WbiSigner } = require('../../codec/wbi');
const { DanmakuClientBase } = require('../DanmakuClientBase');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_WS_URL = 'wss://broadcastlv.chat.bilibili.com/sub';

/** 压缩包最大嵌套深度（真实协议只嵌一层，深层即恶意输入） */
const MAX_DECODE_DEPTH = 8;

const OP = {
  HEARTBEAT: 2,
  HEARTBEAT_REPLY: 3,
  NOTIFICATION: 5,
  AUTH: 7,
  AUTH_REPLY: 8,
};

const VER = {
  RAW_JSON: 0,
  POPULARITY: 1,
  ZLIB: 2,
  BROTLI: 3,
};

/**
 * 心跳包（biliup 同款固定字节）：len=31, header_len=16, ver=1, op=2, seq=1
 * body = "[object Object] "
 */
const HEARTBEAT = Buffer.from([
  0x00, 0x00, 0x00, 0x1f, 0x00, 0x10, 0x00, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01,
  0x5b, 0x6f, 0x62, 0x6a, 0x65, 0x63, 0x74, 0x20, 0x4f, 0x62, 0x6a, 0x65, 0x63, 0x74, 0x5d, 0x20,
]);

/** 构造 16 字节包头数据包 */
function buildPacket(body, operation) {
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const packet = Buffer.alloc(16 + bodyBuf.length);
  packet.writeUInt32BE(16 + bodyBuf.length, 0);
  packet.writeUInt16BE(16, 4);
  packet.writeUInt16BE(1, 6); // version
  packet.writeUInt32BE(operation, 8);
  packet.writeUInt32BE(1, 12); // sequence
  bodyBuf.copy(packet, 16);
  return packet;
}

/** 解压 zlib / brotli，失败返回 null（调用方丢弃该包） */
function decompress(data, version) {
  try {
    return version === VER.ZLIB ? zlib.inflateSync(data) : zlib.brotliDecompressSync(data);
  } catch (_) {
    return null;
  }
}

/**
 * 切包 + 解压缩（递归，带深度上限）。
 * 声明长度 < 16 视为不可信帧，丢弃剩余数据（防 panic/死循环，对齐 biliup 修复）。
 * @returns {Array<{operation: number, body: Buffer}>}
 */
function decodePackets(data, depth = 0) {
  const packets = [];
  let offset = 0;
  while (offset + 16 <= data.length) {
    const packetLen = data.readUInt32BE(offset);
    const version = data.readUInt16BE(offset + 6);
    const operation = data.readUInt32BE(offset + 8);

    if (packetLen < 16 || offset + packetLen > data.length) {
      break;
    }
    const body = data.subarray(offset + 16, offset + packetLen);

    if (version === VER.ZLIB || version === VER.BROTLI) {
      if (depth < MAX_DECODE_DEPTH) {
        const inner = decompress(body, version);
        if (inner) {
          packets.push(...decodePackets(inner, depth + 1));
        }
      }
    } else if (version === VER.RAW_JSON || version === VER.POPULARITY) {
      packets.push({ operation, body: Buffer.from(body) });
    }
    offset += packetLen;
  }
  return packets;
}

/** 伪造 buvid3（时间戳拼 UUID 格式 + infoc 后缀） */
function generateFakeBuvid3() {
  const uuid = crypto.randomBytes(16).toString('hex').toUpperCase();
  return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20, 32)}infoc`;
}

function buildDefaultHeaders(cookie) {
  const buvid3 = generateFakeBuvid3();
  const cookieValue = cookie ? `buvid3=${buvid3};${cookie}` : `buvid3=${buvid3};`;
  return {
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate',
    'Accept-Language': 'zh-CN,zh;q=0.8,en-US;q=0.5,en;q=0.3',
    'User-Agent': UA,
    Origin: 'https://live.bilibili.com',
    Referer: 'https://live.bilibili.com',
    Cookie: cookieValue,
  };
}

/** 从 URL 提取房间号（短号或真实号） */
function extractRoomId(url) {
  const m = /live\.bilibili\.com\/(\d+)/.exec(url || '');
  return m ? m[1] : null;
}

/** 构造认证包（op=7）：uid=0 匿名 + protover=3 */
function buildAuthPacket(roomId, token, uid = 0) {
  const auth = JSON.stringify({
    uid,
    roomid: roomId,
    protover: 3,
    platform: 'web',
    type: 2,
    key: token,
  });
  return buildPacket(Buffer.from(auth), OP.AUTH);
}

/**
 * DANMU_MSG → comment。info[1]=内容，info[2][0]=uid，info[2][1]=昵称，
 * info[0][15].extra.emoticon_unique 非空时内容替换为 `表情【...】`。
 */
function parseDanmuMsg(json) {
  const info = json.info;
  if (!Array.isArray(info) || typeof info[1] !== 'string' || !Array.isArray(info[2])) {
    return null;
  }
  let text = info[1];
  const uid = info[2][0];
  const name = typeof info[2][1] === 'string' ? info[2][1] : null;
  const meta = Array.isArray(info[0]) ? info[0] : null;
  const emoticonUnique = meta && meta[15] && meta[15].extra ? safeJsonGet(meta[15].extra, 'emoticon_unique') : null;
  if (emoticonUnique) {
    text = `表情【${emoticonUnique}】`;
  }
  if (!text) return null;
  return {
    type: 'comment',
    user: name || '',
    userId: uid != null ? String(uid) : '',
    text,
  };
}

function safeJsonGet(jsonStr, field) {
  try {
    const extra = JSON.parse(jsonStr);
    return typeof extra[field] === 'string' && extra[field] ? extra[field] : null;
  } catch (_) {
    return null;
  }
}

/** SEND_GIFT → gift */
function parseSendGift(json) {
  const data = json.data;
  if (!data || typeof data.uname !== 'string' || typeof data.giftName !== 'string') {
    return null;
  }
  return {
    type: 'gift',
    user: data.uname,
    userId: data.uid != null ? String(data.uid) : '',
    giftName: data.giftName,
    count: Math.max(1, parseInt(data.num, 10) || 1),
  };
}

/** GUARD_BUY → gift（上舰，激活 gift 分支） */
function parseGuardBuy(json) {
  const data = json.data;
  if (!data || typeof data.username !== 'string') {
    return null;
  }
  return {
    type: 'gift',
    user: data.username,
    userId: data.uid != null ? String(data.uid) : '',
    giftName: typeof data.gift_name === 'string' && data.gift_name ? data.gift_name : '上舰',
    count: Math.max(1, parseInt(data.num, 10) || 1),
  };
}

/** SUPER_CHAT_MESSAGE → comment（付费弹幕内容进字幕） */
function parseSuperChat(json) {
  const data = json.data;
  const uname = data && data.user_info && data.user_info.uname;
  if (typeof data?.message !== 'string') {
    return null;
  }
  return {
    type: 'comment',
    user: typeof uname === 'string' ? uname : '',
    userId: data.uid != null ? String(data.uid) : '',
    text: data.message,
  };
}

/** op=5 通知按 cmd 分发；其余忽略 */
function parseNotification(body) {
  let json;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch (_) {
    return null;
  }
  if (typeof json.cmd !== 'string') return null;
  const cmdBase = json.cmd.split(':')[0]; // DANMU_MSG 带版本后缀（如 DANMU_MSG:4:0:2:2:2:0）
  switch (cmdBase) {
    case 'DANMU_MSG':
      return parseDanmuMsg(json);
    case 'SEND_GIFT':
      return parseSendGift(json);
    case 'GUARD_BUY':
      return parseGuardBuy(json);
    case 'SUPER_CHAT_MESSAGE':
      return parseSuperChat(json);
    default:
      return null;
  }
}

class BilibiliDanmakuClient extends DanmakuClientBase {
  constructor(opts) {
    super({ platform: 'bilibili', ...opts });
    this.wbiSigner = new WbiSigner();
  }

  async getConnectionInfo() {
    const shortId = extractRoomId(this.roomUrl);
    if (!shortId) {
      throw new Error(`无法从 URL 提取 B站房间号: ${this.roomUrl}`);
    }
    const headers = buildDefaultHeaders(process.env.BILIBILI_DANMAKU_COOKIE);
    const roomId = await this._getRealRoomId(shortId, headers);
    const { wsUrl, token } = await this._getDanmuInfo(roomId, headers);
    return {
      transport: 'ws',
      endpoints: [this._resolveWsUrl(wsUrl)],
      headers,
      registration: [buildAuthPacket(roomId, token)],
      heartbeat: { data: HEARTBEAT, intervalMs: 30000, ackTimeoutMs: 90000 },
    };
  }

  async _getRealRoomId(shortId, headers) {
    const resp = await axios.get(
      `https://api.live.bilibili.com/room/v1/Room/room_init?id=${shortId}`,
      { headers, timeout: 5000 }
    );
    const roomId = resp.data && resp.data.data && resp.data.data.room_id;
    if (!roomId) {
      throw new Error(`B站 room_init 失败: ${shortId}`);
    }
    return roomId;
  }

  /**
   * getDanmuInfo（WBI 签名）。返回 { wsUrl, token }；
   * 签名失败或接口错误（含 -352 风控）降级默认地址 + 空 token（biliup 同款降级）。
   */
  async _getDanmuInfo(roomId, headers) {
    const params = { id: String(roomId), type: '0', web_location: '444.8' };
    const signed = await this.wbiSigner.sign(params, headers);
    if (!signed) {
      return { wsUrl: DEFAULT_WS_URL, token: '' };
    }
    const query = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    let json;
    try {
      const resp = await axios.get(
        `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`,
        { headers, timeout: 5000 }
      );
      json = resp.data;
    } catch (err) {
      this.log.warn(`[bilibili] getDanmuInfo 请求失败(${err.message})，降级默认 WS 地址`);
      return { wsUrl: DEFAULT_WS_URL, token: '' };
    }
    const code = json && json.code;
    if (code !== 0) {
      this.log.warn(
        `[bilibili] getDanmuInfo 返回错误 code=${code} msg=${(json && json.message) || 'unknown'}，降级默认 WS 地址`
      );
      return { wsUrl: DEFAULT_WS_URL, token: '' };
    }
    const data = json.data || {};
    const host = data.host_list && data.host_list[0];
    const wsUrl =
      host && host.host && host.wss_port
        ? `wss://${host.host}:${host.wss_port}/sub`
        : DEFAULT_WS_URL;
    return { wsUrl, token: data.token || '' };
  }

  /** 测试/开发口：覆盖最终 WS 地址（集成测试指向 mock server） */
  _resolveWsUrl(wsUrl) {
    return process.env.BILIBILI_DANMAKU_WS_URL || wsUrl;
  }

  decode(chunk) {
    const events = [];
    for (const packet of decodePackets(chunk)) {
      switch (packet.operation) {
        case OP.NOTIFICATION: {
          const event = parseNotification(packet.body);
          if (event) {
            event.ts_abs_ms = Date.now();
            events.push(event);
          }
          break;
        }
        case OP.HEARTBEAT_REPLY:
          this._markHeartbeatAck();
          break;
        case OP.AUTH_REPLY:
          this.log.debug ? this.log.debug('[bilibili] 认证响应') : null;
          break;
        default:
          break;
      }
    }
    return events;
  }
}

module.exports = {
  BilibiliDanmakuClient,
  extractRoomId,
  buildPacket,
  buildAuthPacket,
  decodePackets,
  parseNotification,
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
};
