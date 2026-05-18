const express = require('express');
const router = express.Router();
const pool = require('../db/index');
const DataService = require('../services/DataService');

router.get('/settings', async (req, res) => {
  try {
    const { rows, map } = await DataService.getSettings();
    res.json({ status: 'ok', data: rows, map });
  } catch (err) {
    console.error('[settings] 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

router.put('/settings/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    const result = await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
       RETURNING *`,
      [key, value]
    );
    res.json({ status: 'ok', data: result.rows[0] });
  } catch (err) {
    console.error('[settings] 更新失败:', err);
    res.status(500).json({ status: 'Error', message: '更新失败' });
  }
});

module.exports = router;
