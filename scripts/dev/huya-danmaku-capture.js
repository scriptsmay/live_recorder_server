#!/usr/bin/env node
/**
 * 虎牙弹幕协议抓包验证脚本（开发期一次性工具，v1.10.0 Task 2）
 *
 * 用法：
 *   node scripts/dev/huya-danmaku-capture.js [roomId] [durationSec]
 *   例：node scripts/dev/huya-danmaku-capture.js 243547 120
 *
 * 职责：
 * 1. 真实连接热门虎牙房间的弹幕 WS（wss://cdnws.api.huya.com/）
 * 2. dump 原始二进制帧（hex）到 test/fixtures/danmaku/huya/raw-frames-{room}.jsonl
 * 3. 用最小编解码逐 tag 探测弹幕体字段布局（昵称/内容/颜色的真实 tag 位置），
 *    输出结论供 HuyaDanmakuClient parser 固化（不照抄 biliup 的投机解析）
 * 4. 实测匿名注册 lUid=0, bAnonymous=true 是否可收流（--anonymous）
 *
 * 退出条件：到达时长，或收到 ≥ --min-events 条弹幕（默认 20）。
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const WebSocket = require('ws');
const { TarsWriter } = require('../../server/lib/core/danmaku/codec/tars/writer');
const { TarsReader } = require('../../server/lib/core/danmaku/codec/tars/reader');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const WSS_URL = 'wss://cdnws.api.huya.com/';

const args = process.argv.slice(2);
const roomId = args[0] || '243547';
const durationSec = parseInt(args[1], 10) || 120;
const anonymous = args.includes('--anonymous');
const minEvents = parseInt(args[args.indexOf('--min-events') + 1], 10) || 20;

const outDir = path.join(__dirname, '..', '..', 'test', 'fixtures', 'danmaku', 'huya');
fs.mkdirSync(outDir, { recursive: true });
const fixturePath = path.join(outDir, `raw-frames-${roomId.replace(/[^a-z0-9_-]/gi, '')}.jsonl`);
const fixtureStream = fs.createWriteStream(fixturePath, { flags: 'a' });

let stats = { frames: 0, cmdTypes: {}, msgTypes: {}, danmaku: 0, anonymousAccepted: false, registerRsp: false };

function dumpFrame(direction, buf, note) {
  stats.frames++;
  fixtureStream.write(
    JSON.stringify({ ts: Date.now(), dir: direction, hex: buf.toString('hex'), note: note || '' }) + '\n'
  );
}

async function getRoomUid(roomId) {
  const resp = await axios.get(`https://www.huya.com/${roomId}`, {
    headers: { 'User-Agent': UA },
    timeout: 10000,
  });
  const m = resp.data.match(/uid['"]*:\s*['"]*(\d+)['"]*/);
  if (!m) throw new Error('failed to extract uid from room page');
  return parseInt(m[1], 10);
}

function buildRegisterPacket(uid, isAnonymous) {
  const userInfo = new TarsWriter();
  userInfo.writeInt64(0, isAnonymous ? 0 : uid);
  userInfo.writeBool(1, isAnonymous);
  userInfo.writeString(2, '');
  userInfo.writeString(3, '');
  userInfo.writeInt64(4, 0);
  userInfo.writeInt64(5, 0);
  userInfo.writeInt64(6, isAnonymous ? 0 : uid);
  userInfo.writeInt64(7, 3);
  const cmd = new TarsWriter();
  cmd.writeInt32(0, 1);
  cmd.writeBytes(1, userInfo.toBuffer());
  return cmd.toBuffer();
}

// biliup 硬编码的 118 字节心跳包（huya.rs:39）
const HEARTBEAT = Buffer.from([
  0x00, 0x03, 0x1d, 0x00, 0x00, 0x69, 0x00, 0x00, 0x00, 0x69, 0x10, 0x03, 0x2c, 0x3c, 0x4c, 0x56,
  0x08, 0x6f, 0x6e, 0x6c, 0x69, 0x6e, 0x65, 0x75, 0x69, 0x66, 0x0f, 0x4f, 0x6e, 0x55, 0x73, 0x65,
  0x72, 0x48, 0x65, 0x61, 0x72, 0x74, 0x42, 0x65, 0x61, 0x74, 0x7d, 0x00, 0x00, 0x3c, 0x08, 0x00,
  0x01, 0x06, 0x04, 0x74, 0x52, 0x65, 0x71, 0x1d, 0x00, 0x00, 0x2f, 0x0a, 0x0a, 0x0c, 0x16, 0x00,
  0x26, 0x00, 0x36, 0x07, 0x61, 0x64, 0x72, 0x5f, 0x77, 0x61, 0x70, 0x46, 0x00, 0x0b, 0x12, 0x03,
  0xae, 0xf0, 0x0f, 0x22, 0x03, 0xae, 0xf0, 0x0f, 0x3c, 0x42, 0x6d, 0x52, 0x02, 0x60, 0x5c, 0x60,
  0x01, 0x7c, 0x82, 0x00, 0x0b, 0xb0, 0x1f, 0x9c, 0xac, 0x0b, 0x8c, 0x98, 0x0c, 0xa8, 0x0c, 0x20,
]);

const strings = []; // analyzeDanmakuBody 与 collectStringsStrict 共享的探测缓冲

function readStringHere(r, type) {
  try {
    if (type === 6) {
      if (r.pos >= r.data.length) return null;
      const len = r.data[r.pos];
      r.pos += 1;
      if (r.pos + len > r.data.length) return null;
      const s = r.data.toString('utf8', r.pos, r.pos + len);
      r.pos += len;
      return s;
    }
    if (type === 7) {
      if (r.pos + 4 > r.data.length) return null;
      const len = r.data.readUInt32BE(r.pos);
      r.pos += 4;
      if (r.pos + len > r.data.length) return null;
      const s = r.data.toString('utf8', r.pos, r.pos + len);
      r.pos += len;
      return s;
    }
  } catch (_) {}
  return null;
}

function collectStringsStrict(r, depth, prefix) {
  if (depth > 4) return;
  while (r.pos < r.data.length) {
    const head = r.peekHead();
    if (!head || head.type === 11) break; // STRUCT_END
    r.readHead();
    const path = prefix ? `${prefix}.${head.tag}` : `${head.tag}`;
    if (head.type === 6 || head.type === 7) {
      const val = readStringHere(r, head.type);
      if (val && val.length > 0 && val.length < 200) {
        strings.push({ path, t: head.type, val });
      }
    } else if (head.type === 10) {
      collectStringsStrict(r, depth + 1, path);
      // 递归在 STRUCT_END 处 break，父层需消费它以继续读后续字段
      const after = r.peekHead();
      if (after && after.type === 11) {
        r.readHead();
      }
    } else if (head.type === 13) {
      // BYTES：读出后若是合法 TARS struct 也递归探测（弹幕体藏在 bytes 里）
      const save = r.pos;
      const innerHead = r.readHead();
      let inner = null;
      if (innerHead) {
        const sizeReader = new TarsReader(r.data.subarray(r.pos));
        // 复用 reader 内部逻辑：手动读 size（Zero/Int8/Int16/Int32）
        const sizeHead = sizeReader.readHead();
        let size = null;
        if (sizeHead) {
          if (sizeHead.type === 12) size = 0;
          else if (sizeHead.type === 0 && r.pos + 1 <= r.data.length) {
            size = r.data.readInt8(r.pos);
            r.pos += 1;
          } else if (sizeHead.type === 1 && r.pos + 2 <= r.data.length) {
            size = r.data.readInt16BE(r.pos);
            r.pos += 2;
          } else if (sizeHead.type === 2 && r.pos + 4 <= r.data.length) {
            size = r.data.readInt32BE(r.pos);
            r.pos += 4;
          }
        }
        if (size != null && size >= 0 && r.pos + size <= r.data.length) {
          inner = r.data.subarray(r.pos, r.pos + size);
          r.pos += size;
        } else {
          r.pos = save;
        }
      }
      if (inner) {
        const ir = new TarsReader(inner);
        try {
          collectStringsStrict(ir, depth + 1, `${path}[]`);
        } catch (_) {}
      }
    } else {
      r.skipField(head.type);
    }
  }
}

function analyzeDanmakuBody(body) {
  strings.length = 0;
  try {
    collectStringsStrict(new TarsReader(body), 0, '');
  } catch (e) {
    return { error: e.message };
  }
  // 输出前若干条的真实布局样本
  return strings.slice(0, 24);
}

function parseFrame(buf) {
  const r = new TarsReader(buf);
  const cmdType = r.readInt32(0);
  stats.cmdTypes[cmdType] = (stats.cmdTypes[cmdType] || 0) + 1;
  if (cmdType === 7) {
    const inner = r.readBytes(1);
    if (inner) {
      const ir = new TarsReader(inner);
      const msgType = ir.readInt64(1);
      stats.msgTypes[msgType] = (stats.msgTypes[msgType] || 0) + 1;
      if (msgType === 1400) {
        const body = ir.readBytes(2);
        if (body) {
          stats.danmaku++;
          const layout = analyzeDanmakuBody(body);
          if (stats.danmaku <= 8) {
            console.log(`[danmaku #${stats.danmaku}] 弹幕体字段布局:`);
            for (const s of layout) {
              console.log(`   ${s.path} (t${s.t}): ${JSON.stringify(s.val)}`);
            }
            console.log('');
          }
        }
      }
    }
  } else if (cmdType === 2) {
    stats.registerRsp = true;
    console.log('[register] 收到注册响应');
    if (anonymous) {
      // 注册响应体内含成功与否信息，dump 出来人工判断
      const rsp = r.readBytes(1);
      if (rsp) console.log('[register] 响应体 hex:', rsp.toString('hex').slice(0, 120));
      stats.anonymousAccepted = true;
    }
  } else if (cmdType === 6) {
    console.log('[heartbeat] 收到心跳响应');
  }
}

async function main() {
  console.log(`[huya-capture] room=${roomId} duration=${durationSec}s anonymous=${anonymous}`);
  let uid = null;
  if (!anonymous) {
    uid = await getRoomUid(roomId);
    console.log(`[huya-capture] 房间页 uid=${uid}`);
  }

  const ws = new WebSocket(WSS_URL, { headers: { 'User-Agent': UA } });
  ws.on('open', () => {
    console.log('[ws] connected');
    const reg = buildRegisterPacket(uid || 0, anonymous);
    dumpFrame('C2S', reg, 'register');
    ws.send(reg);
    setTimeout(() => {
      dumpFrame('C2S', HEARTBEAT, 'heartbeat');
      ws.send(HEARTBEAT);
    }, 5000);
    const hbTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        dumpFrame('C2S', HEARTBEAT, 'heartbeat');
        ws.send(HEARTBEAT);
      }
    }, 60000);
    ws._hbTimer = hbTimer;
  });
  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    dumpFrame('S2C', buf, '');
    try {
      parseFrame(buf);
    } catch (e) {
      console.error('[parse] 解析异常(忽略):', e.message);
    }
  });
  ws.on('error', (e) => console.error('[ws] error:', e.message));
  ws.on('close', (code, reason) => {
    console.log('[ws] closed:', code, reason && reason.toString());
    if (ws._hbTimer) clearInterval(ws._hbTimer);
  });

  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      `[status] ${elapsed}s frames=${stats.frames} danmaku=${stats.danmaku} cmdTypes=${JSON.stringify(stats.cmdTypes)} msgTypes=${JSON.stringify(stats.msgTypes)}`
    );
    if (stats.danmaku >= minEvents || elapsed >= durationSec) {
      clearInterval(timer);
      console.log('\n===== 结论 =====');
      console.log(JSON.stringify(stats, null, 2));
      console.log(`fixture 已写入: ${fixturePath}`);
      ws.close();
      setTimeout(() => process.exit(0), 500);
    }
  }, 10000);
}

main().catch((e) => {
  console.error('[fatal]', e.message);
  process.exit(1);
});
