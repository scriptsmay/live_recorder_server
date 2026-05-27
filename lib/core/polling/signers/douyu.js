const crypto = require('crypto');
const vm = require('vm');

const DEFAULT_DID = '1000000000000000';

function md5Hash(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

const cryptoStub = {
  MD5: (str) => ({
    toString: () => md5Hash(str),
  }),
};

async function fetchRoomHtml(rid) {
  const url = `https://www.douyu.com/${rid}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.text();
}

function extractSignFunction(html) {
  const match = html.match(/(function ub98484234[\s\S]*?)\s*\}\s*;/);
  if (!match) {
    return null;
  }

  let jsCode = match[1] + '}';
  jsCode = jsCode.replace(/eval\s*\(\s*function\s*\(\)\s*\{/, '');
  jsCode = jsCode.replace(/\}\s*\(\s*\)\s*\)\s*$/, '');
  jsCode = jsCode.replace(/eval\(/g, '');
  jsCode = jsCode.replace(/\)\s*;/g, ';');

  return jsCode;
}

function parseSignResult(resultStr) {
  try {
    const params = new URLSearchParams(resultStr);
    const v = params.get('v');
    const did = params.get('did');
    const tt = params.get('tt');
    const sign = params.get('sign');

    if (v && did && tt && sign) {
      return { v, did, tt, sign };
    }
  } catch (e) {
    console.error('[DouyuSign] 解析签名结果失败:', e.message);
  }

  return null;
}

async function getSignParams(rid, did = DEFAULT_DID) {
  try {
    const html = await fetchRoomHtml(rid);
    const jsCode = extractSignFunction(html);

    if (!jsCode) {
      console.error('[DouyuSign] 未找到签名函数');
      return null;
    }

    const ct = Math.floor(Date.now() / 1000);
    const context = vm.createContext({
      CryptoJS: cryptoStub,
      did,
      rid: String(rid),
      ct,
    });

    const script = new vm.Script(jsCode, { filename: 'douyu-sign.js' });
    const result = script.runInContext(context, { timeout: 5000 });

    if (!result || typeof result !== 'string') {
      console.error('[DouyuSign] 签名函数返回无效');
      return null;
    }

    return parseSignResult(result);
  } catch (err) {
    console.error('[DouyuSign] 获取签名失败:', err.message);
    return null;
  }
}

module.exports = {
  getSignParams,
};
