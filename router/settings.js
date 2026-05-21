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

router.put('/settings', async (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ status: 'Error', message: '请求格式错误' });
    }

    const entries = Object.entries(updates);
    if (entries.length === 0) {
      return res.json({ status: 'ok', data: [] });
    }

    // 构造批量插入的 SQL
    const values = [];
    const placeholders = entries.map(([key, value], index) => {
      values.push(key, value);
      return `($${index * 2 + 1}, $${index * 2 + 2})`;
    }).join(', ');

    const query = `
      INSERT INTO settings (key, value)
      VALUES ${placeholders}
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = NOW()
      RETURNING *
    `;

    const result = await pool.query(query, values);
    res.json({ status: 'ok', data: result.rows });
  } catch (err) {
    console.error('[settings] 批量更新失败:', err);
    res.status(500).json({ status: 'Error', message: '更新失败' });
  }
});

module.exports = router;
