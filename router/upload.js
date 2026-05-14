const { spawn } = require('child_process');
const path = require('path');
const express = require('express');
const router = express.Router();
const pool = require('../db/index');

function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] !== undefined ? vars[key] : `{${key}}`);
}

function getTemplateVars(room, session) {
  const date = session.started_at ? new Date(session.started_at) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    room_name: room.room_name || room.room_url || 'unknown',
    room_url: room.room_url || '',
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    datetime: `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
    YYYY: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
  };
}

// ─── 模板 CRUD ─────────────────────────────────

router.get('/upload_templates', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, r.room_name FROM upload_templates t
       LEFT JOIN rooms r ON t.room_url = r.room_url
       ORDER BY t.id DESC`
    );
    res.json({ status: 'ok', data: result.rows });
  } catch (err) {
    console.error('[upload] 查询模板失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

router.post('/upload_templates', async (req, res) => {
  try {
    const { name, room_url, title_template, desc_template, tid, tags, line, copyright, source, cover } = req.body;
    if (!name) return res.status(400).json({ status: 'Error', message: '模板名称必填' });
    const result = await pool.query(
      `INSERT INTO upload_templates (name, room_url, title_template, desc_template, tid, tags, line, copyright, source, cover)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [name, room_url || null, title_template || '{room_name} 直播录像 {date}',
       desc_template || '', tid || 171, tags || '', line || 'bda2',
       copyright ?? 2, source || '', cover || '']
    );
    res.status(201).json({ status: 'ok', data: result.rows[0] });
  } catch (err) {
    console.error('[upload] 创建模板失败:', err);
    res.status(500).json({ status: 'Error', message: '创建失败' });
  }
});

router.put('/upload_templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, room_url, title_template, desc_template, tid, tags, line, copyright, source, cover } = req.body;
    const result = await pool.query(
      `UPDATE upload_templates SET name=$1, room_url=$2, title_template=$3, desc_template=$4,
       tid=$5, tags=$6, line=$7, copyright=$8, source=$9, cover=$10, updated_at=NOW()
       WHERE id=$11 RETURNING *`,
      [name, room_url || null, title_template, desc_template, tid, tags, line, copyright, source, cover, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ status: 'Error', message: '模板不存在' });
    res.json({ status: 'ok', data: result.rows[0] });
  } catch (err) {
    console.error('[upload] 更新模板失败:', err);
    res.status(500).json({ status: 'Error', message: '更新失败' });
  }
});

router.delete('/upload_templates/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM upload_templates WHERE id=$1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ status: 'Error', message: '模板不存在' });
    res.json({ status: 'ok', message: '已删除' });
  } catch (err) {
    console.error('[upload] 删除模板失败:', err);
    res.status(500).json({ status: 'Error', message: '删除失败' });
  }
});

// ─── 上传记录 ─────────────────────────────────

router.get('/upload_records', async (req, res) => {
  try {
    const { limit } = req.query;
    let query = `
      SELECT u.*, t.name AS template_name
      FROM upload_records u
      LEFT JOIN upload_templates t ON u.template_id = t.id
      ORDER BY u.id DESC
    `;
    if (limit) query += ` LIMIT ${parseInt(limit, 10)}`;
    const result = await pool.query(query);
    res.json({ status: 'ok', data: result.rows });
  } catch (err) {
    console.error('[upload] 查询记录失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

router.delete('/upload_records/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM upload_records WHERE id=$1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ status: 'Error', message: '记录不存在' });
    res.json({ status: 'ok', message: '已删除' });
  } catch (err) {
    console.error('[upload] 删除记录失败:', err);
    res.status(500).json({ status: 'Error', message: '删除失败' });
  }
});

// ─── 执行上传 ─────────────────────────────────

router.post('/sessions/:id/upload', async (req, res) => {
  try {
    const sessionResult = await pool.query(
      `SELECT s.*, r.room_name FROM recording_sessions s
       LEFT JOIN rooms r ON s.room_url = r.room_url
       WHERE s.id = $1`,
      [req.params.id]
    );
    if (sessionResult.rows.length === 0) return res.status(404).json({ status: 'Error', message: '会话不存在' });
    const session = sessionResult.rows[0];

    const { template_id } = req.body;
    if (!template_id) return res.status(400).json({ status: 'Error', message: '请指定投稿模板' });

    const tmplResult = await pool.query('SELECT * FROM upload_templates WHERE id = $1', [template_id]);
    if (tmplResult.rows.length === 0) return res.status(404).json({ status: 'Error', message: '模板不存在' });
    const tmpl = tmplResult.rows[0];

    const recs = await pool.query(
      `SELECT * FROM recordings WHERE session_id = $1 AND status = 'completed' ORDER BY segment_index ASC`,
      [session.id]
    );
    if (recs.rows.length === 0) return res.status(400).json({ status: 'Error', message: '会话无已完成的分片文件' });

    const files = recs.rows.map(r => r.file_path).filter(Boolean);
    if (files.length === 0) return res.status(400).json({ status: 'Error', message: '无有效文件路径' });

    const room = { room_url: session.room_url, room_name: session.room_name };
    const vars = getTemplateVars(room, session);
    const title = renderTemplate(tmpl.title_template, vars);
    const desc = renderTemplate(tmpl.desc_template || '', vars);
    const tags = renderTemplate(tmpl.tags || '', vars);

    const totalSize = files.reduce((sum, f) => { try { return sum + require('fs').statSync(f).size; } catch { return sum; } }, 0);

    const record = await pool.query(
      `INSERT INTO upload_records (session_id, template_id, room_url, title, status, file_count, total_size)
       VALUES ($1,$2,$3,$4,'uploading',$5,$6) RETURNING id`,
      [session.id, template_id, session.room_url, title, files.length, totalSize]
    );
    const recordId = record.rows[0].id;

    const args = ['upload'];
    if (title) args.push('--title', title);
    if (desc) args.push('--desc', desc);
    if (tmpl.tid) args.push('--tid', String(tmpl.tid));
    if (tags) args.push('--tag', tags);
    if (tmpl.line) args.push('--line', tmpl.line);
    if (tmpl.copyright) args.push('--copyright', String(tmpl.copyright));
    if (tmpl.source) args.push('--source', tmpl.source);
    if (tmpl.cover) args.push('--cover', tmpl.cover);
    args.push(...files);

    const biliupPath = process.env.BILIUP_PATH || 'biliup';
    const proc = spawn(biliupPath, args, { cwd: process.env.BILIUP_WORK_DIR || process.env.HOME });

    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.stderr.on('data', (d) => { output += d.toString(); });

    proc.on('error', async (err) => {
      await pool.query(
        `UPDATE upload_records SET status='failed', error_message=$1, output=$2, completed_at=NOW() WHERE id=$3`,
        [err.message, output, recordId]
      );
    });

    proc.on('close', async (code) => {
      const cmdStr = `${biliupPath} ${args.join(' ')}`;
      if (code === 0) {
        await pool.query(
          `UPDATE upload_records SET status='success', command=$1, output=$2, completed_at=NOW() WHERE id=$3`,
          [cmdStr, output, recordId]
        );
      } else {
        await pool.query(
          `UPDATE upload_records SET status='failed', command=$1, output=$2, error_message=$3, completed_at=NOW() WHERE id=$4`,
          [cmdStr, output, `exit code ${code}`, recordId]
        );
      }
    });

    await pool.query(`UPDATE upload_records SET command=$1 WHERE id=$2`, [[biliupPath, ...args].join(' '), recordId]);

    res.json({ status: 'ok', message: '上传已启动', data: { record_id: recordId, title, file_count: files.length } });
  } catch (err) {
    console.error('[upload] 上传失败:', err);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

module.exports = router;
