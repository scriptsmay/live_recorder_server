/**
 * 极简 Protobuf reader/writer — 移植自 biliup `codec/protobuf.rs`
 *
 * 抖音弹幕 schema 本就靠社区逆向，无需完整 protobufjs：
 * 按 wire-type 逐字段扫（Varint=0 / Fixed64=1 / LengthDelimited=2 / Fixed32=5），
 * parseAll 返回 { [fieldNum]: ProtoValue[] }，重复字段取数组。
 *
 * ProtoValue: { kind: 'varint'|'fixed64'|'fixed32', value: number|bigint }
 *           | { kind: 'string', value: string }
 *           | { kind: 'bytes', value: Buffer }
 * 辅助取值：asU64 / asStr / asBytes。
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const WIRE_TYPE = {
  VARINT: 0,
  FIXED64: 1,
  LENGTH_DELIMITED: 2,
  FIXED32: 5,
};

class ProtoReader {
  constructor(data) {
    this.data = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.pos = 0;
  }

  get isEof() {
    return this.pos >= this.data.length;
  }

  /** 读 varint（>2^53 时返回 BigInt） */
  readVarint() {
    let result = 0n;
    let shift = 0n;
    while (true) {
      if (this.pos >= this.data.length) return null;
      const byte = this.data[this.pos];
      this.pos += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
      if (shift >= 64n) return null;
    }
    return result <= MAX_SAFE ? Number(result) : result;
  }

  /** 读 field tag → { fieldNum, wireType } */
  readTag() {
    const v = this.readVarint();
    if (v == null) return null;
    const fieldNum = Math.floor(Number(v) / 8);
    const wireType = Number(v) % 8;
    if (![0, 1, 2, 5].includes(wireType)) return null;
    return { fieldNum, wireType };
  }

  readLengthDelimited() {
    const len = this.readVarint();
    if (len == null) return null;
    if (this.pos + len > this.data.length) return null;
    const bytes = this.data.subarray(this.pos, this.pos + len);
    this.pos += len;
    return bytes;
  }

  readFixed32() {
    if (this.pos + 4 > this.data.length) return null;
    const v = this.data.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  readFixed64() {
    if (this.pos + 8 > this.data.length) return null;
    const v = this.data.readBigUInt64LE(this.pos);
    this.pos += 8;
    return v <= MAX_SAFE ? Number(v) : v;
  }

  /**
   * 解析全部字段。
   * @returns {Object<number, Array<{kind: string, value: any}>>}
   */
  parseAll() {
    const fields = {};
    while (!this.isEof) {
      const tag = this.readTag();
      if (!tag) break;
      const { fieldNum, wireType } = tag;
      let value = null;
      switch (wireType) {
        case WIRE_TYPE.VARINT: {
          const v = this.readVarint();
          if (v != null) value = { kind: 'varint', value: v };
          break;
        }
        case WIRE_TYPE.FIXED64: {
          const v = this.readFixed64();
          if (v != null) value = { kind: 'fixed64', value: v };
          break;
        }
        case WIRE_TYPE.FIXED32: {
          const v = this.readFixed32();
          if (v != null) value = { kind: 'fixed32', value: v };
          break;
        }
        case WIRE_TYPE.LENGTH_DELIMITED: {
          const bytes = this.readLengthDelimited();
          if (bytes) {
            // 合法 UTF-8 且无控制字符 → 按 string 解释（对齐 biliup 的启发式）
            const asString = tryUtf8(bytes);
            value = asString ? { kind: 'string', value: asString } : { kind: 'bytes', value: Buffer.from(bytes) };
          }
          break;
        }
        default:
          break;
      }
      if (value) {
        (fields[fieldNum] = fields[fieldNum] || []).push(value);
      }
    }
    return fields;
  }
}

function tryUtf8(bytes) {
  const s = bytes.toString('utf8');
  // Buffer.toString 恢复时校验 round-trip，防止二进制被误判为字符串
  if (Buffer.from(s, 'utf8').equals(bytes) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) {
    return s;
  }
  return null;
}

/** 取某字段的第一个值 */
function first(fields, fieldNum) {
  const arr = fields[fieldNum];
  return arr && arr[0];
}

function asU64(v) {
  return v && (v.kind === 'varint' || v.kind === 'fixed64' || v.kind === 'fixed32') ? v.value : null;
}

function asStr(v) {
  return v && v.kind === 'string' ? v.value : null;
}

function asBytes(v) {
  return v && v.kind === 'bytes' ? v.value : null;
}

class ProtoWriter {
  constructor() {
    this.chunks = [];
  }

  writeVarint(value) {
    let v = typeof value === 'bigint' ? value : BigInt(value);
    while (true) {
      let byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v !== 0n) byte |= 0x80;
      this.chunks.push(byte);
      if (v === 0n) break;
    }
  }

  writeTag(fieldNum, wireType) {
    this.writeVarint((fieldNum << 3) | wireType);
  }

  writeString(fieldNum, value) {
    const bytes = Buffer.from(String(value), 'utf8');
    this.writeTag(fieldNum, WIRE_TYPE.LENGTH_DELIMITED);
    this.writeVarint(bytes.length);
    for (const b of bytes) this.chunks.push(b);
  }

  writeBytes(fieldNum, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.writeTag(fieldNum, WIRE_TYPE.LENGTH_DELIMITED);
    this.writeVarint(bytes.length);
    for (const b of bytes) this.chunks.push(b);
  }

  writeVarintField(fieldNum, value) {
    this.writeTag(fieldNum, WIRE_TYPE.VARINT);
    this.writeVarint(value);
  }

  toBuffer() {
    return Buffer.from(this.chunks);
  }
}

module.exports = { ProtoReader, ProtoWriter, first, asU64, asStr, asBytes, WIRE_TYPE };
