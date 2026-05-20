const express = require('express');
const router = express.Router();
const pool = require('../db/index');
const DataService = require('../services/DataService');

router.get('/transcode_records', async (req, res) => {
  try {
    const { status, limit = 100 } = req.query;
    const data = await DataService.getTranscodeRecords({
      status,
      limit,
    });
    res.json({ status: 'ok', data });
  } catch (err) {
    console.error('[transcode_records] 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

router.delete('/transcode_records/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM transcode_records WHERE id = $1', [id]);
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
