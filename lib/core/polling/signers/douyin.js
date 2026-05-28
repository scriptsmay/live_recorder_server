const crypto = require('crypto');

function generateABogus(queryString, _userAgent = '') {
  try {
    if (!queryString) {
      return null;
    }

    const raw = queryString;
    let str = raw;

    const md5Hash = crypto.createHash('md5').update(str).digest('hex');
    let result = '';

    for (let i = 0; i < md5Hash.length; i += 2) {
      result += String.fromCharCode(parseInt(md5Hash.substr(i, 2), 16));
    }

    str = result;
    const magic = '3go8&$8*3*3h0k(2)2';
    let decoded = '';

    for (let i = 0; i < str.length; i++) {
      decoded += String.fromCharCode(str.charCodeAt(i) ^ magic.charCodeAt(i % magic.length));
    }

    const sha256Hash = crypto.createHash('sha256').update(decoded).digest();
    const base64Encoded = Buffer.from(sha256Hash).toString('base64');

    let finalResult = base64Encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const len = finalResult.length;
    if (len % 4 !== 0) {
      finalResult += '='.repeat(4 - (len % 4));
    }

    return finalResult;
  } catch (err) {
    console.error('[DouyinSign] 生成 a_bogus 失败:', err.message);
    return null;
  }
}

function generateXbogus(queryString, _userAgent = '') {
  try {
    const query = new URLSearchParams(queryString);
    const sortedKeys = Array.from(query.keys()).sort();
    let sortedQuery = '';

    for (let i = 0; i < sortedKeys.length; i++) {
      const key = sortedKeys[i];
      sortedQuery += `${key}=${query.get(key)}`;
      if (i < sortedKeys.length - 1) {
        sortedQuery += '&';
      }
    }

    const md5Hash = crypto.createHash('md5').update(sortedQuery).digest('hex');

    let result = '';
    for (let i = 0; i < md5Hash.length; i += 2) {
      result += String.fromCharCode(parseInt(md5Hash.substr(i, 2), 16));
    }

    const sha256Hash = crypto.createHash('sha256').update(result).digest();
    const base64Encoded = Buffer.from(sha256Hash).toString('base64');

    return base64Encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  } catch (err) {
    console.error('[DouyinSign] 生成 x_bogus 失败:', err.message);
    return null;
  }
}

module.exports = {
  generateABogus,
  generateXbogus,
};
