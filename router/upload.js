const express = require('express');
const router = express.Router();
const pool = require('../db/index');
const UploadService = require('../services/UploadService');

router.get('/upload_templates', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM upload_templates ORDER BY id');
    res.json({ status: 'ok', data: result.rows });
  } catch (err) {
    console.error('[templates] 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

router.post('/upload_templates', async (req, res) => {
  try {
    const {
      name,
      cookies_path,
      title_template,
      desc_template,
      tags,
      source,
      tid,
      copyright,
      is_only_self,
      cover,
      dtime,
      after_upload,
    } = req.body;
    const result = await pool.query(
      `INSERT INTO upload_templates
       (name, cookies_path, title_template, desc_template, tags, source, tid, copyright, is_only_self, cover, dtime, after_upload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        name,
        cookies_path,
        title_template || '{room_name}',
        desc_template || '',
        tags || '',
        source || '{room_url}',
        tid || null,
        copyright || null,
        is_only_self || false,
        cover || null,
        dtime || null,
        after_upload || null,
      ]
    );
    res.json({ status: 'ok', data: result.rows[0] });
  } catch (err) {
    console.error('[templates] 创建失败:', err);
    res.status(500).json({ status: 'Error', message: '创建失败' });
  }
});

router.put('/upload_templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const fields = [
      'name', 'cookies_path', 'title_template', 'desc_template',
      'tags', 'source', 'tid', 'copyright', 'is_only_self',
      'cover', 'dtime', 'after_upload',
    ];
    const sets = [];
    const values = [];
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        sets.push(`${field} = $${values.length + 1}`);
        values.push(req.body[field]);
      }
    }
    if (sets.length === 0) {
      return res.status(400).json({ status: 'Error', message: '无更新字段' });
    }
    values.push(id);
    const result = await pool.query(
      `UPDATE upload_templates SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '模板不存在' });
    }
    res.json({ status: 'ok', data: result.rows[0] });
  } catch (err) {
    console.error('[templates] 更新失败:', err);
    res.status(500).json({ status: 'Error', message: '更新失败' });
  }
});

router.delete('/upload_templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM upload_templates WHERE id = $1', [id]);
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[templates] 删除失败:', err);
    res.status(500).json({ status: 'Error', message: '删除失败' });
  }
});

router.post('/sessions/:id/upload', async (req, res) => {
  try {
    const { id } = req.params;
    const { template_id } = req.body;
    if (!template_id) {
      return res.status(400).json({ status: 'Error', message: '缺少 template_id' });
    }

    const session = await pool.query('SELECT * FROM recording_sessions WHERE id = $1', [id]);
    if (session.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '会话不存在' });
    }

    const tmpl = await pool.query('SELECT * FROM upload_templates WHERE id = $1', [template_id]);
    if (tmpl.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '模板不存在' });
    }

    const sessionData = session.rows[0];
    await UploadService.executeUpload(sessionData, tmpl.rows[0]);
    res.json({ status: 'ok', message: '投稿任务已启动' });
  } catch (err) {
    console.error('[sessions] 上传失败:', err);
    res.status(500).json({ status: 'Error', message: '上传失败' });
  }
});

router.get('/upload_records', async (req, res) => {
  try {
    const { session_id, status, limit = 50 } = req.query;
    const conditions = [];
    const params = [];
    if (session_id) {
      conditions.push(`session_id = $${params.length + 1}`);
      params.push(session_id);
    }
    if (status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    }
    let sql = 'SELECT * FROM upload_records';
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ` ORDER BY id DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit, 10));
    const result = await pool.query(sql, params);
    res.json({ status: 'ok', data: result.rows });
  } catch (err) {
    console.error('[upload_records] 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

router.delete('/upload_records/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM upload_records WHERE id = $1', [id]);
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[upload_records] 删除失败:', err);
    res.status(500).json({ status: 'Error', message: '删除失败' });
  }
});

module.exports = router;
