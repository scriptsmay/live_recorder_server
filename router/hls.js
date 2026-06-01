const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();

router.get(/\/hls\/(.+)/, async (req, res) => {
  try {
    const filePathParam = req.params[0];
    const safePath = path.normalize(filePathParam).replace(/^(\.\.(\/|\\|$))+/, '');
    const videoDownloadDir = path.resolve(process.env.VIDEO_DOWNLOAD_DIR || '.');
    const fullPath = path.join(videoDownloadDir, safePath);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ status: 'Error', message: '文件不存在' });
    }

    const ext = path.extname(fullPath).toLowerCase();
    let contentType = 'application/octet-stream';
    if (ext === '.m3u8') {
      contentType = 'application/vnd.apple.mpegurl';
    } else if (ext === '.ts') {
      contentType = 'video/mp2t';
    }

    const stat = fs.statSync(fullPath);
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = end - start + 1;
      const file = fs.createReadStream(fullPath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(fullPath).pipe(res);
    }
  } catch (err) {
    console.error('[HLS] Error:', err);
    res.status(500).json({ status: 'Error', message: '服务器内部错误' });
  }
});

module.exports = router;
