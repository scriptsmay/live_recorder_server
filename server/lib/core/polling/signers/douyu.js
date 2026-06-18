const crypto = require('crypto');
const { getOptimalUserAgent } = require('../../config/userAgents');

const DEFAULT_DID = '10000000000000000000000000001501';
const DOUYU_API_BASE = 'https://www.douyu.com';

// 加密密钥缓存
let encryptKeyCache = null;
let encryptKeyExpiry = 0;
let pendingKeyRequest = null; // 单飞机制：正在进行的请求 Promise

const KEY_CACHE_DURATION = 300000; // 5分钟

function md5Hash(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * 获取加密密钥（单飞机制：确保同时只有一个请求）
 */
async function getEncryptionKey(did) {
  const now = Date.now();

  // 缓存命中
  if (encryptKeyCache && now < encryptKeyExpiry) {
    return encryptKeyCache;
  }

  // 已有请求在进行中，等待它完成
  if (pendingKeyRequest) {
    try {
      return await pendingKeyRequest;
    } catch {
      return null;
    }
  }

  // 发起新请求
  pendingKeyRequest = _fetchEncryptionKey(did, now);

  try {
    return await pendingKeyRequest;
  } catch {
    return null;
  } finally {
    pendingKeyRequest = null;
  }
}

async function _fetchEncryptionKey(did, requestTime) {
  try {
    const url = `${DOUYU_API_BASE}/wgapi/livenc/liveweb/websec/getEncryption?did=${did}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': getOptimalUserAgent() },
    });

    const data = await response.json();

    if (data.error !== 0 || !data.data) {
      throw new Error(`获取加密密钥失败: ${data.msg || '未知错误'}`);
    }

    // 更新缓存
    encryptKeyCache = data.data;
    encryptKeyExpiry = requestTime + KEY_CACHE_DURATION;

    return encryptKeyCache;
  } catch (err) {
    console.error('[DouyuSign] 密钥获取异常:', err.message);
    throw err;
  }
}

/**
 * 生成完整签名（参考 biliup 实现）
 * 1. 从 getEncryption 接口获取加密密钥
 * 2. 生成 secret: MD5 迭代 enc_time 次
 * 3. 生成 auth: MD5(secret + key + rid + ts)
 */
async function getSignParams(rid, options = {}) {
  try {
    const { did = DEFAULT_DID } = options;
    const ts = Math.floor(Date.now() / 1000);

    // 获取加密密钥
    const keyData = await getEncryptionKey(did);
    if (!keyData) {
      // 降级到简化签名
      console.warn('[DouyuSign] 使用简化签名（降级）');
      const time = Date.now();
      return {
        did,
        rid: String(rid),
        time: String(time),
        sign: md5Hash(`${rid}${time}`),
        _fallback: true,
      };
    }

    const { rand_str, enc_time, key } = keyData;

    // 生成 secret: MD5 迭代 enc_time 次
    let secret = rand_str;
    for (let i = 0; i < enc_time; i++) {
      secret = md5Hash(`${secret}${key}`);
    }

    // 生成 auth
    const salt = `${rid}${ts}`;
    const auth = md5Hash(`${secret}${key}${salt}`);

    return {
      did,
      rid: String(rid),
      time: String(ts),
      sign: auth,
      enc_data: keyData.enc_data || '',
      key_ver: keyData.key_ver || '1',
      _fallback: false,
    };
  } catch (err) {
    console.error('[DouyuSign] 获取签名失败:', err.message);
    return null;
  }
}

/**
 * 清除密钥缓存（用于测试或强制刷新）
 */
function clearKeyCache() {
  encryptKeyCache = null;
  encryptKeyExpiry = 0;
}

module.exports = {
  getSignParams,
  getEncryptionKey,
  md5Hash,
  clearKeyCache,
};
