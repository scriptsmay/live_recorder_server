/**
 * WBI 签名（B站 Web Browser Interface）— 移植自 biliup `protocols/wbi.rs`
 *
 * 流程：导航栏 API 拿 img_key/sub_key → KEY_MAP 重排取前 32 位得 mixin_key
 *       → 参数追加 wts 时间戳 → 拼接 query + mixin_key 取 MD5 得 w_rid。
 * key 缓存 2 小时。
 */
const crypto = require('crypto');
const axios = require('axios');

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const UPDATE_INTERVAL_SEC = 2 * 60 * 60;

// WBI key 重排映射表（biliup wbi.rs / bilibili-api-collect 同源）
const KEY_MAP = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/** 从 URL 提取 key："https://...abc123.png" → "abc123" */
function extractKey(url) {
  const fileName = String(url || '').split('/').pop();
  return fileName ? fileName.split('.')[0] : null;
}

/** img_key + sub_key 按 KEY_MAP 重排取前 32 位 */
function createMixinKey(img, sub) {
  const full = String(img) + String(sub);
  return KEY_MAP.slice(0, 32)
    .map((i) => full[i])
    .filter((c) => c !== undefined)
    .join('');
}

function md5Hex(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

class WbiSigner {
  constructor() {
    this.key = null;
    this.lastUpdate = 0;
  }

  _needsUpdate() {
    if (!this.key) return true;
    return Date.now() / 1000 - this.lastUpdate >= UPDATE_INTERVAL_SEC;
  }

  /**
   * 更新 mixin key。失败时抛错（调用方降级到默认 WS 地址）。
   */
  async updateKey(headers) {
    if (!this._needsUpdate()) return;
    const resp = await axios.get(NAV_URL, { headers, timeout: 5000 });
    const wbiImg = resp.data && resp.data.data && resp.data.data.wbi_img;
    const img = extractKey(wbiImg && wbiImg.img_url);
    const sub = extractKey(wbiImg && wbiImg.sub_url);
    if (!img || !sub) {
      throw new Error('WBI: 无法从导航栏响应提取 img/sub key');
    }
    this.key = createMixinKey(img, sub);
    this.lastUpdate = Math.floor(Date.now() / 1000);
  }

  /**
   * 对 params 追加 wts + w_rid。成功返回 true；签名失败返回 false（调用方降级）。
   * @param {Object} params - 会被原地追加 wts / w_rid
   * @param {Object} headers - 请求头（传给导航栏 API）
   */
  async sign(params, headers) {
    try {
      await this.updateKey(headers);
    } catch (err) {
      return false;
    }
    const wts = Math.floor(Date.now() / 1000);
    // 值清洗：去掉 !'()* 后按 key 排序拼接（与 biliup 一致）
    const sanitized = {};
    for (const [k, v] of Object.entries(params)) {
      sanitized[k] = String(v).replace(/[!'()*]/g, '');
    }
    sanitized.wts = String(wts);
    const query = Object.keys(sanitized)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(sanitized[k])}`)
      .join('&');
    params.wts = String(wts);
    params.w_rid = md5Hex(query + this.key);
    return true;
  }
}

module.exports = { WbiSigner, extractKey, createMixinKey, KEY_MAP };
