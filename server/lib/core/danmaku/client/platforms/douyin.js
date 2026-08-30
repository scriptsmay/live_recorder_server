/**
 * DouyinDanmakuClient — 抖音弹幕客户端（v1.10.0）
 *
 * 协议（移植自 biliup `protocols/douyin.rs`；**抖音定位为尽力而为**：
 * X-Bogus 签名算法与 ttwid 都可能随时失效，失效时优先对照 biliup 上游更新）：
 * - Protobuf over WebSocket（wss://webcast100-ws-web-{lq,hl,lf}.douyin.com/webcast/im/push/v2/，
 *   三 host 轮换兜底），gzip 载荷
 * - WS URL 需 X-Bogus 签名（RC4 + MD5 复刻）+ 伪造 user_unique_id + X-MS-Stub
 * - cookie：DOUYIN_TTWID 环境变量优先，缺省用 biliup 硬编码值（有时效风险，启动告警）
 * - PushFrame(2=logId,7=payloadType,8=payload) → gzip → Response(1=messages,5=internalExt,9=needAck)
 *   → 仅处理 WebcastChatMessage（2=user 内 3=nickName，3=content）
 * - needAck 时按 logId + internalExt 回 ACK 包；心跳 10s（固定包 `:\x02hb`），四平台最短
 * - 礼物/点赞未实现（biliup 同样未做）
 */
const zlib = require('zlib');
const crypto = require('crypto');
const { ProtoReader, ProtoWriter, first, asU64, asStr, asBytes } = require('../../codec/protobuf');
const { DanmakuClientBase } = require('../DanmakuClientBase');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DOUYIN_WS_HOSTS = [
  'wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/',
  'wss://webcast100-ws-web-hl.douyin.com/webcast/im/push/v2/',
  'wss://webcast100-ws-web-lf.douyin.com/webcast/im/push/v2/',
];

/** biliup 硬编码 ttwid（2025-07 生成，有时效风险） */
const DEFAULT_TTWID =
  '1%7Cu7ogdHsSmHtxbt4hjDCNvcLfVJz78CTM0TTWU8Hio8w%7C1751545220%7C18aac967e501e9d6c13384335ced3523c46a0b1cc4535c7213bc2506a7f462c8';

/** 心跳包 `:\x02hb` */
const HEARTBEAT = Buffer.from([0x3a, 0x02, 0x68, 0x62]);

// ---- X-Bogus 签名（RC4 + MD5 复刻）----
const XBOGUS_ALPHABET = Buffer.from('Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe', 'binary');
const STANDARD_ALPHABET = Buffer.from(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  'binary'
);
const ALPHABET_LOOKUP = (() => {
  const table = new Array(128).fill(0);
  for (let i = 0; i < 64; i++) {
    table[STANDARD_ALPHABET[i]] = XBOGUS_ALPHABET[i];
  }
  return table;
})();
const EMPTY_MD5_BYTES = [0x45, 0x3f];

function md5Hex(input) {
  return crypto.createHash('md5').update(input).digest('hex');
}

/** RC4（单字节 key），in-place */
function rc4Encrypt(key, data) {
  const s = new Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key) % 256;
    [s[i], s[j]] = [s[j], s[i]];
  }
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) % 256;
    j = (j + s[i]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
    data[k] ^= s[(s[i] + s[j]) % 256];
  }
}

/** 标准 base64 字符重映射到抖音自定义字母表（12 字节 → 16 字符） */
function encodeBase64Remapped(data) {
  const out = Buffer.alloc(16);
  for (let input = 0, output = 0; input < 12; input += 3, output += 4) {
    const b0 = data[input];
    const b1 = data[input + 1];
    const b2 = data[input + 2];
    out[output] = ALPHABET_LOOKUP[STANDARD_ALPHABET[(b0 >> 2) & 0x3f]];
    out[output + 1] = ALPHABET_LOOKUP[STANDARD_ALPHABET[((b0 << 4) | (b1 >> 4)) & 0x3f]];
    out[output + 2] = ALPHABET_LOOKUP[STANDARD_ALPHABET[((b1 << 2) | (b2 >> 6)) & 0x3f]];
    out[output + 3] = ALPHABET_LOOKUP[STANDARD_ALPHABET[b2 & 0x3f]];
  }
  return out;
}

/** MD5 hex 字符串 → 对 16 字节再取 MD5 的最后 2 字节 */
function md5Last2(hexStr) {
  const bytes = Buffer.from(hexStr, 'hex');
  const hash = crypto.createHash('md5').update(bytes).digest();
  return [hash[14], hash[15]];
}

/**
 * 生成 X-Bogus 签名（16 字符）。
 * @param {string} msStubHex - X-MS-Stub（32 位 MD5 hex）
 * @param {number} counter - 固定传 1
 */
function generateXbogus(msStubHex, counter) {
  const random1 = crypto.randomBytes(1)[0];
  const random2 = Math.floor((crypto.randomBytes(1)[0] * 255) / 256);
  const header = 0x40 | (random1 & 0x1f);
  const md5Bytes = md5Last2(msStubHex);
  const payload = [
    counter & 0x3f,
    0,
    1,
    0x0e,
    EMPTY_MD5_BYTES[0],
    EMPTY_MD5_BYTES[1],
    md5Bytes[0],
    md5Bytes[1],
    random2,
    0,
  ];
  payload[9] = payload.slice(0, 9).reduce((acc, x) => acc ^ x, 0);
  rc4Encrypt(random2, payload);

  const finalData = [header, random2, ...payload];
  return encodeBase64Remapped(finalData).toString('binary');
}

/** 伪造随机 user_unique_id */
function generateUserUniqueId() {
  const base = 7300000000000000000n;
  const range = 699999999999999999n;
  const ts = process.hrtime.bigint();
  return (base + (ts % range)).toString();
}

/** X-MS-Stub：sig_params 的 MD5 hex */
function getXMsStub(params) {
  const sigParams = params.map(([k, v]) => `${k}=${v}`).join(',');
  return md5Hex(sigParams);
}

/** 构造带签名的 WS URL */
function buildWsUrl(roomId, host) {
  const userUniqueId = generateUserUniqueId();
  const versionCode = '180800';
  const webcastSdkVersion = '1.0.15';

  const sigParams = [
    ['live_id', '1'],
    ['aid', '6383'],
    ['version_code', versionCode],
    ['webcast_sdk_version', webcastSdkVersion],
    ['room_id', roomId],
    ['sub_room_id', ''],
    ['sub_channel_id', ''],
    ['did_rule', '3'],
    ['user_unique_id', userUniqueId],
    ['device_platform', 'web'],
    ['device_type', ''],
    ['ac', ''],
    ['identity', 'audience'],
  ];
  const xMsStub = getXMsStub(sigParams);
  const signature = generateXbogus(xMsStub, 1);

  const wsParams = {
    app_name: 'douyin_web',
    compress: 'gzip',
    device_platform: 'web',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Mozilla',
    browser_version: '120.0.0.0',
    aid: '6383',
    live_id: '1',
    enter_from: 'web_live',
    version_code: versionCode,
    webcast_sdk_version: webcastSdkVersion,
    update_version_code: '1.0.15',
    host: 'https://live.douyin.com',
    did_rule: '3',
    identity: 'audience',
    endpoint: 'live_pc',
    need_persist_msg_count: '15',
    heartbeatDuration: '0',
    room_id: roomId,
    user_unique_id: userUniqueId,
    signature,
  };
  const query = Object.entries(wsParams)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `${host}?${query}`;
}

function extractRoomId(url) {
  const m = /live\.douyin\.com\/(\d+)/.exec(url || '');
  return m ? m[1] : null;
}

/** 解析 PushFrame → { logId, payload, payloadType } */
function parsePushFrame(data) {
  const fields = new ProtoReader(data).parseAll();
  const logId = asU64(first(fields, 2));
  const payload = asBytes(first(fields, 8));
  if (logId == null || !payload) return null;
  const payloadType = asStr(first(fields, 7)) || '';
  return { logId, payload, payloadType };
}

/** 解析 Response → { messages: [{method, payload}], needAck, internalExt } */
function parseResponse(data) {
  const fields = new ProtoReader(data).parseAll();
  const messages = [];
  const msgList = fields[1] || [];
  for (const msgValue of msgList) {
    const msgBytes = asBytes(msgValue);
    if (!msgBytes) continue;
    const msgFields = new ProtoReader(msgBytes).parseAll();
    messages.push({
      method: asStr(first(msgFields, 1)) || '',
      payload: asBytes(first(msgFields, 2)) || Buffer.alloc(0),
    });
  }
  const needAckV = asU64(first(fields, 9));
  return {
    messages,
    needAck: needAckV != null ? needAckV !== 0 : false,
    internalExt: asStr(first(fields, 5)) || '',
  };
}

/** ChatMessage → { name, content }（2=user 内 3=nickName，3=content） */
function parseChatMessage(data) {
  const fields = new ProtoReader(data).parseAll();
  const content = asStr(first(fields, 3));
  if (content == null) return null;
  let name = '';
  const userBytes = asBytes(first(fields, 2));
  if (userBytes) {
    const userFields = new ProtoReader(userBytes).parseAll();
    name = asStr(first(userFields, 3)) || '';
  }
  return { name, content };
}

/** 构造 ACK 包（field 2=logId varint, 7="ack", 8=internalExt bytes） */
function buildAck(logId, internalExt) {
  const writer = new ProtoWriter();
  writer.writeVarintField(2, logId);
  writer.writeString(7, 'ack');
  writer.writeBytes(8, Buffer.from(internalExt, 'utf8'));
  return writer.toBuffer();
}

class DouyinDanmakuClient extends DanmakuClientBase {
  constructor(opts) {
    super({ platform: 'douyin', ...opts });
    if (!process.env.DOUYIN_TTWID) {
      this.log.warn(
        '[douyin] 未配置 DOUYIN_TTWID，使用 biliup 硬编码 ttwid（2025-07 生成）——有时效风险，失效请更新环境变量'
      );
    }
  }

  async getConnectionInfo() {
    const roomId = extractRoomId(this.roomUrl);
    if (!roomId) {
      throw new Error(`无法从 URL 提取抖音房间号: ${this.roomUrl}`);
    }
    return {
      transport: 'ws',
      endpoints: DOUYIN_WS_HOSTS.map((host) => buildWsUrl(roomId, host)),
      headers: this._buildHeaders(),
      registration: [],
      heartbeat: { data: HEARTBEAT, intervalMs: 10000, ackTimeoutMs: null },
    };
  }

  _buildHeaders() {
    const ttwid = process.env.DOUYIN_TTWID || DEFAULT_TTWID;
    return {
      'User-Agent': UA,
      Origin: 'https://live.douyin.com',
      Referer: 'https://live.douyin.com/',
      Cookie: `ttwid=${ttwid};`,
    };
  }

  decode(chunk) {
    const events = [];
    const frame = parsePushFrame(chunk);
    if (!frame) return events;
    let decompressed;
    try {
      decompressed = zlib.gunzipSync(frame.payload);
    } catch (err) {
      this.log.warn(`[douyin] gzip 解压失败(忽略): ${err.message}`);
      return events;
    }
    const { messages, needAck, internalExt } = parseResponse(decompressed);
    if (needAck) {
      // needAck 时回 ACK 包（logId + internalExt）
      this._write(buildAck(frame.logId, internalExt));
    }
    for (const message of messages) {
      if (message.method !== 'WebcastChatMessage') continue;
      const parsed = parseChatMessage(message.payload);
      if (!parsed || !parsed.content) continue;
      events.push({
        ts_abs_ms: Date.now(),
        type: 'comment',
        user: parsed.name,
        userId: '',
        text: parsed.content,
      });
    }
    return events;
  }
}

module.exports = {
  DouyinDanmakuClient,
  extractRoomId,
  buildWsUrl,
  buildAck,
  generateXbogus,
  generateUserUniqueId,
  getXMsStub,
  parsePushFrame,
  parseResponse,
  parseChatMessage,
  rc4Encrypt,
  encodeBase64Remapped,
  md5Last2,
  HEARTBEAT,
  DOUYIN_WS_HOSTS,
  DEFAULT_TTWID,
};
