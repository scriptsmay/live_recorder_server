/**
 * TARS (Tencent Application Remote Service) 最小编码器
 *
 * 仅实现弹幕场景所需的子集（变长整数 / string / bytes / struct 嵌套、按 tag 寻址），
 * 字节布局与 biliup `crates/danmaku/src/codec/tars.rs` 逐字节对齐（虎牙协议的硬标准）。
 *
 * 设计要点：
 * - 按 tag 寻址时遇到未知 tag / 未知类型一律安全跳过，不抛错（协议向前兼容的关键）
 * - 字段按 tag 升序排列时 skipToTag 提前终止（tag > target 即不存在）
 */
const { TYPE } = require('./writer');

const I64_AS_NUMBER_MAX = 9007199254740991n; // Number.MAX_SAFE_INTEGER

class TarsReader {
  /**
   * @param {Buffer|Uint8Array} data
   */
  constructor(data) {
    this.data = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.pos = 0;
  }

  get remaining() {
    return this.data.length - this.pos;
  }

  isEof() {
    return this.pos >= this.data.length;
  }

  /**
   * 预读下一个 (tag, type)，不移动游标。流尾或未知类型返回 null。
   * @returns {{tag: number, type: number}|null}
   */
  peekHead() {
    if (this.pos >= this.data.length) {
      return null;
    }
    const byte = this.data[this.pos];
    const rawTag = (byte >> 4) & 0x0f;
    const typeId = byte & 0x0f;
    let tag = rawTag;
    let headLen = 1;
    if (rawTag >= 15) {
      if (this.pos + 1 >= this.data.length) {
        return null;
      }
      tag = this.data[this.pos + 1];
      headLen = 2;
    }
    if (!Object.values(TYPE).includes(typeId)) {
      return null;
    }
    return { tag, type: typeId, headLen };
  }

  /**
   * 读下一个 (tag, type) 并移动游标。流尾或未知类型返回 null。
   */
  readHead() {
    const head = this.peekHead();
    if (!head) {
      return null;
    }
    this.pos += head.headLen;
    return { tag: head.tag, type: head.type };
  }

  /**
   * 跳过当前层的字段直到命中 targetTag。
   * 命中返回 true（游标停在 target 字段的 head 上）；StructEnd / tag 越过 target / 流尾返回 false。
   * @param {number} targetTag
   * @returns {boolean}
   */
  skipToTag(targetTag) {
    while (this.pos < this.data.length) {
      const head = this.peekHead();
      if (!head) {
        return false;
      }
      if (head.type === TYPE.STRUCT_END) {
        return false;
      }
      if (head.tag === targetTag) {
        return true;
      }
      if (head.tag > targetTag) {
        return false;
      }
      this.readHead();
      this.skipField(head.type);
    }
    return false;
  }

  /**
   * 跳过一个已知类型的字段值（head 已消费）。
   * 未知类型按不可解析处理：标记游标到流尾以终止后续解析（不抛错）。
   * @param {number} type
   */
  skipField(type) {
    switch (type) {
      case TYPE.INT8:
        this.pos += 1;
        break;
      case TYPE.INT16:
        this.pos += 2;
        break;
      case TYPE.INT32:
      case TYPE.FLOAT:
        this.pos += 4;
        break;
      case TYPE.INT64:
      case TYPE.DOUBLE:
        this.pos += 8;
        break;
      case TYPE.STRING1: {
        if (this.pos < this.data.length) {
          const len = this.data[this.pos];
          this.pos += 1 + len;
        }
        break;
      }
      case TYPE.STRING4: {
        if (this.pos + 4 <= this.data.length) {
          const len = this.data.readUInt32BE(this.pos);
          this.pos += 4 + len;
        }
        break;
      }
      case TYPE.MAP: {
        const size = this._readSizeInternal() || 0;
        for (let i = 0; i < size * 2; i++) {
          const head = this.readHead();
          if (!head) break;
          this.skipField(head.type);
        }
        break;
      }
      case TYPE.LIST: {
        const size = this._readSizeInternal() || 0;
        for (let i = 0; i < size; i++) {
          const head = this.readHead();
          if (!head) break;
          this.skipField(head.type);
        }
        break;
      }
      case TYPE.BYTES: {
        this.readHead(); // 内层类型 head（约定 int8）
        const size = this._readSizeInternal() || 0;
        this.pos += size;
        break;
      }
      case TYPE.STRUCT_BEGIN:
        this._skipToStructEnd();
        break;
      case TYPE.STRUCT_END:
      case TYPE.ZERO:
        break;
      default:
        // 未知类型：无法确定长度，终止本层解析（等价于把剩余数据全部丢弃）
        this.pos = this.data.length;
        break;
    }
  }

  _skipToStructEnd() {
    while (this.pos < this.data.length) {
      const head = this.readHead();
      if (!head) break;
      if (head.type === TYPE.STRUCT_END) break;
      this.skipField(head.type);
    }
  }

  /**
   * 读长度/尺寸字段（Zero/Int8/Int16/Int32）。
   * @returns {number|null}
   * @private
   */
  _readSizeInternal() {
    const head = this.readHead();
    if (!head) return null;
    switch (head.type) {
      case TYPE.ZERO:
        return 0;
      case TYPE.INT8: {
        if (this.pos >= this.data.length) return null;
        const v = this.data.readInt8(this.pos);
        this.pos += 1;
        return v;
      }
      case TYPE.INT16: {
        if (this.pos + 2 > this.data.length) return null;
        const v = this.data.readInt16BE(this.pos);
        this.pos += 2;
        return v;
      }
      case TYPE.INT32: {
        if (this.pos + 4 > this.data.length) return null;
        const v = this.data.readInt32BE(this.pos);
        this.pos += 4;
        return v;
      }
      default:
        return null;
    }
  }

  /**
   * 读整数（Zero/Int8/Int16/Int32/Int64），游标停在 head 之后。
   * int64 超出 Number 安全范围时返回 BigInt。
   * @returns {number|bigint|null}
   * @private
   */
  _readIntInternal() {
    const head = this.readHead();
    if (!head) return null;
    switch (head.type) {
      case TYPE.ZERO:
        return 0;
      case TYPE.INT8: {
        if (this.pos >= this.data.length) return null;
        const v = this.data.readInt8(this.pos);
        this.pos += 1;
        return v;
      }
      case TYPE.INT16: {
        if (this.pos + 2 > this.data.length) return null;
        const v = this.data.readInt16BE(this.pos);
        this.pos += 2;
        return v;
      }
      case TYPE.INT32: {
        if (this.pos + 4 > this.data.length) return null;
        const v = this.data.readInt32BE(this.pos);
        this.pos += 4;
        return v;
      }
      case TYPE.INT64: {
        if (this.pos + 8 > this.data.length) return null;
        const v = this.data.readBigInt64BE(this.pos);
        this.pos += 8;
        return v >= -I64_AS_NUMBER_MAX && v <= I64_AS_NUMBER_MAX ? Number(v) : v;
      }
      default:
        return null;
    }
  }

  /**
   * 按 tag 读整数。字段不存在返回 null（区分「值为 0」与「无此字段」）。
   * @param {number} tag
   * @returns {number|bigint|null}
   */
  readInt(tag) {
    if (!this.skipToTag(tag)) return null;
    return this._readIntInternal();
  }

  readInt32(tag) {
    const v = this.readInt(tag);
    return typeof v === 'bigint' ? Number(v) : v;
  }

  readInt64(tag) {
    return this.readInt(tag);
  }

  /**
   * 按 tag 读字符串（String1/String4）。不存在或类型不符返回 null。
   * @param {number} tag
   * @returns {string|null}
   */
  readString(tag) {
    if (!this.skipToTag(tag)) return null;
    const head = this.readHead();
    if (!head) return null;
    if (head.type === TYPE.STRING1) {
      if (this.pos >= this.data.length) return null;
      const len = this.data[this.pos];
      this.pos += 1;
      if (this.pos + len > this.data.length) return null;
      const s = this.data.toString('utf8', this.pos, this.pos + len);
      this.pos += len;
      return s;
    }
    if (head.type === TYPE.STRING4) {
      if (this.pos + 4 > this.data.length) return null;
      const len = this.data.readUInt32BE(this.pos);
      this.pos += 4;
      if (this.pos + len > this.data.length) return null;
      const s = this.data.toString('utf8', this.pos, this.pos + len);
      this.pos += len;
      return s;
    }
    // 类型不符：回滚不现实（head 已消费），按缺失处理
    return null;
  }

  /**
   * 按 tag 读 bytes（SIMPLE_LIST）。不存在或类型不符返回 null。
   * @param {number} tag
   * @returns {Buffer|null}
   */
  readBytes(tag) {
    if (!this.skipToTag(tag)) return null;
    const head = this.readHead();
    if (!head || head.type !== TYPE.BYTES) return null;
    this.readHead(); // 内层类型 head（约定 int8）
    const size = this._readSizeInternal();
    if (size == null || size < 0 || this.pos + size > this.data.length) return null;
    const buf = this.data.subarray(this.pos, this.pos + size);
    this.pos += size;
    return Buffer.from(buf);
  }

  /**
   * 遍历当前 struct 的所有顶层字段（按声明顺序）。
   * 回调收到 {tag, type}；返回 false 可提前终止。StructEnd 与流尾自动终止。
   * 用于宽松解析（逐 tag 探测未知布局）。
   * @param {Function} fn ({tag, type}) => boolean|void
   */
  forEachField(fn) {
    while (this.pos < this.data.length) {
      const head = this.peekHead();
      if (!head || head.type === TYPE.STRUCT_END) {
        break;
      }
      this.readHead();
      if (fn(head) === false) {
        break;
      }
      this.skipField(head.type);
    }
  }
}

module.exports = { TarsReader };
