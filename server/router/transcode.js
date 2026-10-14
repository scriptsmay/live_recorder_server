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
