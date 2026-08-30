/**
 * TARS (Tencent Application Remote Service) 最小编码器
 *
 * 仅实现弹幕场景所需的子集（变长整数 / string / bytes / struct 嵌套、按 tag 写入），
 * 字节布局与 biliup `crates/danmaku/src/codec/tars.rs` 逐字节对齐（虎牙协议的硬标准）。
 *
 * 类型编号：
 *   0=Int8 1=Int16 2=Int32 3=Int64 4=Float 5=Double 6=String1 7=String4
 *   8=Map 9=List 10=StructBegin 11=StructEnd 12=Zero 13=Bytes(SimpleList)
 */
const TYPE = {
  INT8: 0,
  INT16: 1,
  INT32: 2,
  INT64: 3,
  FLOAT: 4,
  DOUBLE: 5,
  STRING1: 6,
  STRING4: 7,
  MAP: 8,
  LIST: 9,
  STRUCT_BEGIN: 10,
  STRUCT_END: 11,
  ZERO: 12,
  BYTES: 13,
};

const I32_MIN = -2147483648;
const I32_MAX = 2147483647;
const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;

class TarsWriter {
  constructor() {
    this.chunks = [];
  }

  _writeHead(tag, type) {
    if (tag < 15) {
      this.chunks.push((tag << 4) | type);
    } else {
      this.chunks.push(0xf0 | type, tag);
    }
  }

  _pushInt8(value) {
    this.chunks.push(value & 0xff);
  }

  _pushInt16(value) {
    this.chunks.push((value >> 8) & 0xff, value & 0xff);
  }

  _pushInt32(value) {
    this.chunks.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }

  _pushInt64(value) {
    const big = typeof value === 'bigint' ? value : BigInt(value);
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      this.chunks.push(Number((big >> shift) & 0xffn));
    }
  }

  writeInt8(tag, value) {
    if (value === 0) {
      this._writeHead(tag, TYPE.ZERO);
    } else {
      this._writeHead(tag, TYPE.INT8);
      this._pushInt8(value);
    }
  }

  writeInt16(tag, value) {
    if (value >= -128 && value <= 127) {
      this.writeInt8(tag, value);
    } else {
      this._writeHead(tag, TYPE.INT16);
      this._pushInt16(value);
    }
  }

  writeInt32(tag, value) {
    if (value >= -32768 && value <= 32767) {
      this.writeInt16(tag, value);
    } else {
      this._writeHead(tag, TYPE.INT32);
      this._pushInt32(value);
    }
  }

  /**
   * 写 int64。接受 number（安全整数范围内）或 BigInt。
   * 数值落在 i32 范围内时降级为 int32/int16/int8 最小编码（与 biliup 行为一致）。
   */
  writeInt64(tag, value) {
    const big = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
    if (big < I64_MIN || big > I64_MAX) {
      throw new RangeError(`TARS int64 out of range: ${big}`);
    }
    if (big >= I32_MIN && big <= I32_MAX) {
      this.writeInt32(tag, Number(big));
    } else {
      this._writeHead(tag, TYPE.INT64);
      this._pushInt64(big);
    }
  }

  writeBool(tag, value) {
    this.writeInt8(tag, value ? 1 : 0);
  }

  writeString(tag, value) {
    const bytes = Buffer.from(String(value), 'utf8');
    if (bytes.length <= 255) {
      this._writeHead(tag, TYPE.STRING1);
      this.chunks.push(bytes.length);
    } else {
      this._writeHead(tag, TYPE.STRING4);
      this._pushInt32(bytes.length);
    }
    for (const b of bytes) {
      this.chunks.push(b);
    }
  }

  /**
   * 写 bytes（SIMPLE_LIST）：head + 内层类型 head（固定 int8）+ 长度 + 数据。
   * 与 biliup write_bytes 完全一致（包括那个固定的内层 int8 head）。
   */
  writeBytes(tag, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this._writeHead(tag, TYPE.BYTES);
    this._writeHead(0, TYPE.INT8);
    this.writeInt32(0, buf.length);
    for (const b of buf) {
      this.chunks.push(b);
    }
  }

  writeStructBegin(tag) {
    this._writeHead(tag, TYPE.STRUCT_BEGIN);
  }

  writeStructEnd() {
    this._writeHead(0, TYPE.STRUCT_END);
  }

  /**
   * 写嵌套 struct 的便捷方法：begin(tag) → 调用 writeBody → end。
   * @param {number} tag
   * @param {Function} writeBody 回调内用同一个 writer 实例写 struct 字段
   * @returns {TarsWriter} this（支持链式）
   */
  writeStruct(tag, writeBody) {
    this.writeStructBegin(tag);
    writeBody(this);
    this.writeStructEnd();
    return this;
  }

  toBuffer() {
    return Buffer.from(this.chunks);
  }
}

module.exports = { TarsWriter, TYPE };
