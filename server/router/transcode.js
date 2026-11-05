const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();
const pool = require('../db/index');
const DataService = require('../services/DataService');

router.get('/transcode_records', async (req, res) => {
  try {
    const { status, limit = 100, page } = req.query;
    const data = await DataService.getTranscodeRecords({
      status,
      limit,
      page,
    });
    res.json({ status: 'ok', data: data.rows, total: data.total });
  } catch (err) {
    console.error('[transcode_records] 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

/**
 * 播放转码产物（仅 mp4），支持 HTTP Range。
 * 用于转码记录未关联到 recording_files 行（历史/手工任务）时的兜底播放入口。
 */
router.get('/transcode_records/:id/stream', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT transcoded_path FROM transcode_records
       WHERE id = $1 AND status = 'completed' AND deleted_at IS NULL`,
      [id]
    );
    const filePath = result.rows[0]?.transcoded_path;

    if (!filePath) {
      return res.status(404).json({ status: 'Error', message: '转码产物不存在' });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ status: 'Error', message: '文件已从磁盘删除' });
    }

    // 与 /api/recordings/:id/stream 保持一致：仅支持 mp4 直连
    if (path.extname(filePath).toLowerCase() !== '.mp4') {
      return res.status(400).json({ status: 'Error', message: '仅支持播放mp4文件' });
    }

    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    console.error('[transcode_records] 播放失败:', err);
    res.status(500).json({ status: 'Error', message: '播放失败' });
  }
});

router.delete('/transcode_records/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // v1.12.0：物理删除改软删除；重复删除返回 404（记录已不存在于未删除集合）
    const result = await pool.query(
      'UPDATE transcode_records SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ status: 'Error', message: '记录不存在' });
    }
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[transcode_records] 删除失败:', err);
    res.status(500).json({ status: 'Error', message: '删除失败' });
  }
});

module.exports = router;
