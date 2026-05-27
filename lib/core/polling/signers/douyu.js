const crypto = require('crypto');

const DEFAULT_DID = '10000000000000000000000000001501';

function md5Hash(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * 获取斗鱼直播流签名参数
 * 参考 biliup 的实现，使用 hlsH5Preview API
 */
async function getSignParams(rid) {
  try {
    const time = Date.now();
    const sign = md5Hash(`${rid}${time}`);

    return {
      did: DEFAULT_DID,
      rid: String(rid),
      time: String(time),
      sign,
    };
  } catch (err) {
    console.error('[DouyuSign] 获取签名失败:', err.message);
    return null;
  }
}

module.exports = {
  getSignParams,
};
