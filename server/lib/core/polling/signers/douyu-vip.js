const vm = require('vm');
const crypto = require('crypto');
const { getOptimalUserAgent } = require('../../config/userAgents');

const DOUYU_DEFAULT_DID = '10000000000000000000000000001501';
const DOUYU_WEB_DOMAIN = 'https://www.douyu.com';

/**
 * VIP 房间专用签名（需要执行 JS 代码）
 * 参考 biliup: homeH5Enc + ub98484234() 执行
 */
async function getVipSignParams(rid, jsCode) {
  try {
    // 创建安全的沙箱环境
    const sandbox = {
      CryptoJS: {
        MD5: (str) => ({
          toString: () => crypto.createHash('md5').update(str).digest('hex'),
        }),
      },
      window: {},
      document: {},
      ub98484234: null,
    };

    const context = vm.createContext(sandbox);

    // 执行 JS 代码
    const wrappedCode = `
      (function() {
        ${jsCode}
        return ub98484234();
      })()
    `;

    const result = vm.runInContext(wrappedCode, context);

    // 解析返回值
    const [signFun, signV] = Array.isArray(result) ? result : [null, null];

    if (!signFun || !signV) {
      throw new Error('JS 执行未返回有效签名');
    }

    // 生成 rb 参数
    const rb = crypto.createHash('md5').update(`${rid}${DOUYU_DEFAULT_DID}${Date.now()}${signV}`).digest('hex');

    // 替换原代码中的 MD5 调用
    const finalSign = signFun.replace('CryptoJS.MD5(cb).toString()', `"${rb}"`);

    return {
      did: DOUYU_DEFAULT_DID,
      rid: String(rid),
      time: String(Math.floor(Date.now() / 1000)),
      sign: finalSign,
      isVip: true,
    };
  } catch (err) {
    console.error('[DouyuSign] VIP 签名失败:', err.message);
    return null;
  }
}

/**
 * 获取 VIP 房间的 JS 加密代码
 */
async function fetchVipJsCode(rid) {
  const url = `${DOUYU_WEB_DOMAIN}/ub98484234.js`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': getOptimalUserAgent(),
      Referer: `${DOUYU_WEB_DOMAIN}/${rid}`,
    },
  });
  return await response.text();
}

module.exports = { getVipSignParams, fetchVipJsCode };
