/**
 * HuyaDanmakuClient — 虎牙弹幕客户端（v1.10.0）
 *
 * 协议（2026-08-30 真实抓包验证，见知识库 huya-danmaku-capture-plan §2.3）：
 * - TARS 二进制协议 over WebSocket（wss://cdnws.api.huya.com/），免登录
 * - 外层 WebSocketCommand: tag0 iCmdType(int32) / tag1 vData(bytes)
 *   1=注册 2=注册响应 5=心跳 6=心跳响应 7=消息推送
 * - 注册：WSUserInfo（tag0 lUid / tag6 lGroupId=uid / tag7 lGroupType=3 ...）包进 cmdType=1
 * - 心跳：60s 固定 118 字节预编码 TARS 包（biliup huya.rs 同款），响应 cmdType=6
 * - 1400 弹幕体（MessageNotification）实测布局：
 *     tag 0 = UserInfo struct（内层 tag0=发送者uid, tag2=昵称, tag4=头像URL）
 *     tag 3 = 弹幕内容（顶层 string）
 *   （biliup 顶层读 tag2 实际是主播 uid int32，拿不到昵称——勿照抄）
 * - 匿名注册 lUid=0 实测「注册成功」但不推流，不可用；uid 提取失败直接放弃采集
 */
const axios = require('axios');
const { TarsWriter } = require('../../codec/tars/writer');
const { TarsReader } = require('../../codec/tars/reader');
const { DanmakuClientBase } = require('../DanmakuClientBase');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const WSS_URL = 'wss://cdnws.api.huya.com/';

/** 测试/开发口：覆盖弹幕 WS 端点（集成测试指向 mock server） */
function getWssUrl() {
  return process.env.HUYA_DANMAKU_WS_URL || WSS_URL;
}

const CMD_TYPE = {
  REGISTER_RSP: 2,
  HEARTBEAT_ACK: 6,
  MSG_PUSH_REQ: 7,
};

// biliup huya.rs:39 硬编码心跳包（内容为 onlineuif / OnUserHeartBeat RPC 请求）
const HEARTBEAT = Buffer.from([
  0x00, 0x03, 0x1d, 0x00, 0x00, 0x69, 0x00, 0x00, 0x00, 0x69, 0x10, 0x03, 0x2c, 0x3c, 0x4c, 0x56,
  0x08, 0x6f, 0x6e, 0x6c, 0x69, 0x6e, 0x65, 0x75, 0x69, 0x66, 0x0f, 0x4f, 0x6e, 0x55, 0x73, 0x65,
  0x72, 0x48, 0x65, 0x61, 0x72, 0x74, 0x42, 0x65, 0x61, 0x74, 0x7d, 0x00, 0x00, 0x3c, 0x08, 0x00,
  0x01, 0x06, 0x04, 0x74, 0x52, 0x65, 0x71, 0x1d, 0x00, 0x00, 0x2f, 0x0a, 0x0a, 0x0c, 0x16, 0x00,
  0x26, 0x00, 0x36, 0x07, 0x61, 0x64, 0x72, 0x5f, 0x77, 0x61, 0x70, 0x46, 0x00, 0x0b, 0x12, 0x03,
  0xae, 0xf0, 0x0f, 0x22, 0x03, 0xae, 0xf0, 0x0f, 0x3c, 0x42, 0x6d, 0x52, 0x02, 0x60, 0x5c, 0x60,
  0x01, 0x7c, 0x82, 0x00, 0x0b, 0xb0, 0x1f, 0x9c, 0xac, 0x0b, 0x8c, 0x98, 0x0c, 0xa8, 0x0c, 0x20,
]);

/** 从房间 URL 提取房间标识（huya.com/123456 数字 或 huya.com/kpl 别名） */
function extractRoomId(url) {
  const m = /huya\.com\/([^/?]+)/.exec(url || '');
  return m ? m[1] : null;
}

/** 构造 WebSocketCommand(1, WSUserInfo(uid)) 注册包 */
function buildRegisterPacket(uid) {
  const userInfo = new TarsWriter();
  userInfo.writeInt64(0, uid);
  userInfo.writeBool(1, false); // bAnonymous=false
  userInfo.writeString(2, ''); // sGuid
  userInfo.writeString(3, ''); // sToken
  userInfo.writeInt64(4, 0); // lTid
  userInfo.writeInt64(5, 0); // lSid
  userInfo.writeInt64(6, uid); // lGroupId = uid
  userInfo.writeInt64(7, 3); // lGroupType = 3
  const cmd = new TarsWriter();
  cmd.writeInt32(0, 1);
  cmd.writeBytes(1, userInfo.toBuffer());
  return cmd.toBuffer();
}

/**
 * 解析 1400 弹幕体（MessageNotification）：
 * tag0 UserInfo struct（tag0 uid / tag2 昵称）+ tag3 内容。缺字段返回 null（宽松解析）。
 */
function parseDanmakuBody(body) {
  const r = new TarsReader(body);
  let user = null;
  let userId = '';
  // tag 0: UserInfo 嵌套 struct
  if (r.skipToTag(0)) {
    const head = r.readHead();
    if (head && head.type === 10) {
      // 在 struct 体内按 tag 读（tag 升序：0 uid → 2 昵称）
      userId = String(r.readInt(0) ?? '');
      user = r.readString(2);
      // 消费到 STRUCT_END，游标回到外层才能继续读顶层 tag 3 内容
      while (!r.isEof()) {
        const h = r.peekHead();
        if (!h) break;
        if (h.type === 11) {
          r.readHead();
          break;
        }
        r.readHead();
        r.skipField(h.type);
      }
    }
  }
  const text = r.readString(3);
  if (!user || !text) {
    return null;
  }
  return { user, userId, text };
}

class HuyaDanmakuClient extends DanmakuClientBase {
  constructor(opts) {
    super({ platform: 'huya', ...opts });
  }

  async getConnectionInfo() {
    const roomId = extractRoomId(this.roomUrl);
    if (!roomId) {
      throw new Error(`无法从 URL 提取虎牙房间标识: ${this.roomUrl}`);
    }
    const uid = await this._fetchRoomUid(roomId);
    return {
      transport: 'ws',
      endpoints: [getWssUrl()],
      headers: { 'User-Agent': UA },
      registration: [buildRegisterPacket(uid)],
      heartbeat: { data: HEARTBEAT, intervalMs: 60000, ackTimeoutMs: 150000 },
    };
  }

  async _fetchRoomUid(roomId) {
    const resp = await axios.get(`https://www.huya.com/${roomId}`, {
      headers: { 'User-Agent': UA },
      timeout: 10000,
    });
    const m = /uid['"]*:\s*['"]*(\d+)['"]*/.exec(resp.data);
    if (!m) {
      // 降级链：页面正则失败 → 匿名注册已实测不可收流 → 放弃采集（由上层重连耗尽后放弃）
      throw new Error(`虎牙房间页 uid 提取失败: ${roomId}`);
    }
    return parseInt(m[1], 10);
  }

  decode(chunk) {
    const r = new TarsReader(chunk);
    const cmdType = r.readInt32(0);
    if (cmdType === CMD_TYPE.HEARTBEAT_ACK) {
      this._markHeartbeatAck();
      return [];
    }
    if (cmdType === CMD_TYPE.REGISTER_RSP) {
      this.log.debug ? this.log.debug(`[huya] 注册响应`) : null;
      return [];
    }
    if (cmdType !== CMD_TYPE.MSG_PUSH_REQ) {
      return [];
    }
    const inner = r.readBytes(1);
    if (!inner) return [];
    const ir = new TarsReader(inner);
    const msgType = ir.readInt64(1);
    if (msgType !== 1400) {
      // 礼物（1402 系）/进场等其他消息类型本版本不解析
      return [];
    }
    const body = ir.readBytes(2);
    if (!body) return [];
    const parsed = parseDanmakuBody(body);
    if (!parsed) return [];
    return [
      {
        ts_abs_ms: Date.now(),
        type: 'comment',
        user: parsed.user,
        userId: parsed.userId,
        text: parsed.text,
      },
    ];
  }
}

module.exports = { HuyaDanmakuClient, extractRoomId, buildRegisterPacket, parseDanmakuBody, HEARTBEAT };
