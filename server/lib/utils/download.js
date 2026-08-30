const fs = require('fs');
const https = require('https');
const http = require('http');

// 按 content-type 推导下载文件的真实扩展名，未命中时兜底 jpg
const FILE_CONTENT_TYPE_MAP = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * 下载文件到指定路径
 *
 * destPath 的扩展名只是占位：最终文件名按响应 content-type 推导扩展名后替换，
 * 因此调用方应使用返回值（实际落盘路径）而非入参。
 *
 * @param {string} url - 文件 URL（支持 30x 重定向跟随）
 * @param {string} destPath - 目标路径
 * @returns {Promise<string>} 实际写入的文件路径（含真实扩展名）
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const contentType = res.headers['content-type'] || '';
      const ext = FILE_CONTENT_TYPE_MAP[contentType.split(';')[0].trim()] || 'jpg';
      const finalPath = destPath.replace(/\.[^.]+$/, `.${ext}`);
      const ws = fs.createWriteStream(finalPath);
      res.pipe(ws);
      ws.on('finish', () => resolve(finalPath));
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

module.exports = { downloadFile, FILE_CONTENT_TYPE_MAP };
