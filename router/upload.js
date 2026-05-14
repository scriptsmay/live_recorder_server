const { spawn } = require('child_process');
const path = require('path');
const express = require('express');
const router = express.Router();
const pool = require('../db/index');
const notify = require('../lib/notify');

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
    const { name, room_url, title_template, desc_template, tid, tags, copyright, source, cover, is_only_self, cookies_path, dtime } = req.body;
    if (!name) return res.status(400).json({ status: 'Error', message: '模板名称必填' });
    const result = await pool.query(
      `INSERT INTO upload_templates (name, room_url, title_template, desc_template, tid, tags, copyright, source, cover, is_only_self, cookies_path, dtime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [name, room_url || null, title_template || '{room_name} 直播录像 {date}',
       desc_template || '', tid || 171, tags || '',
       copyright ?? 2, source || '', cover || '',
       is_only_self ?? 0, cookies_path || '', dtime || 0]
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
    const { name, room_url, title_template, desc_template, tid, tags, copyright, source, cover, is_only_self, cookies_path, dtime } = req.body;
    const result = await pool.query(
      `UPDATE upload_templates SET name=$1, room_url=$2, title_template=$3, desc_template=$4,
       tid=$5, tags=$6, copyright=$7, source=$8, cover=$9, is_only_self=$10, cookies_path=$11, dtime=$12, updated_at=NOW()
       WHERE id=$13 RETURNING *`,
      [name, room_url || null, title_template, desc_template, tid, tags, copyright, source || '', cover,
       is_only_self ?? 0, cookies_path || '', dtime || 0, id]
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

// ─── 执行上传（可复用） ─────────────────────────

async function executeUpload(session, tmpl) {
  const room = { room_url: session.room_url, room_name: session.room_name };
  const vars = getTemplateVars(room, session);
  const title = renderTemplate(tmpl.title_template, vars);
  const desc = renderTemplate(tmpl.desc_template || '', vars);
  const tags = renderTemplate(tmpl.tags || '', vars);
  const source = renderTemplate(tmpl.source || '{room_url}', vars);

  const recs = await pool.query(
    `SELECT * FROM recordings WHERE session_id = $1 AND status = 'completed' ORDER BY segment_index ASC`,
    [session.id]
  );
  const files = recs.rows.map(r => r.file_path).filter(Boolean);
  if (files.length === 0) { console.log(`[自动投稿] 会话 ${session.id} 无文件，跳过`); return; }

  const totalSize = files.reduce((sum, f) => {
    try { return sum + require('fs').statSync(f).size; } catch { return sum; }
  }, 0);

  const record = await pool.query(
    `INSERT INTO upload_records (session_id, template_id, room_url, title, status, file_count, total_size)
     VALUES ($1,$2,$3,$4,'uploading',$5,$6) RETURNING id`,
    [session.id, tmpl.id, session.room_url, title, files.length, totalSize]
  );
  const recordId = record.rows[0].id;

  const biliupPath = process.env.BILIUP_PATH || 'biliup';
  const args = ['-u', tmpl.cookies_path, 'upload'];
  if (title) args.push('--title', title);
  if (desc) args.push('--desc', desc);
  if (tmpl.tid) args.push('--tid', String(tmpl.tid));
  if (tags) args.push('--tag', tags);
  if (tmpl.copyright) args.push('--copyright', String(tmpl.copyright));
  if (source) args.push('--source', source);
  if (tmpl.is_only_self) args.push('--is-only-self');
  if (tmpl.cover) args.push('--cover', tmpl.cover);
  if (tmpl.dtime) args.push('--dtime', String(tmpl.dtime));
  args.push(...files);

  notify.uploadStart(session.room_name, tmpl.name, files.length);

  const proc = spawn(biliupPath, args, { cwd: process.env.BILIUP_WORK_DIR || process.env.HOME });

  let output = '';
  proc.stdout.on('data', (d) => { output += d.toString(); });
  proc.stderr.on('data', (d) => { output += d.toString(); });

  proc.on('error', async () => {
    await pool.query(
      `UPDATE upload_records SET status='failed', error_message=$1, output=$2, completed_at=NOW() WHERE id=$3`,
      ['进程启动失败', output, recordId]
    );
    notify.send('❌ 投稿失败', `模板：${tmpl.name}\n错误：进程启动失败`);
  });

  proc.on('close', async (code) => {
    const cmdStr = `${biliupPath} ${args.join(' ')}`;
    const bvMatch = output.match(/BV[\w]+/);
    const bvId = bvMatch ? bvMatch[0] : '';
    if (code === 0) {
      await pool.query(
        `UPDATE upload_records SET status='success', command=$1, output=$2, bv_id=$3, completed_at=NOW() WHERE id=$4`,
        [cmdStr, output, bvId, recordId]
      );
      notify.uploadComplete(session.room_name, title, bvId);
    } else {
      await pool.query(
        `UPDATE upload_records SET status='failed', command=$1, output=$2, error_message=$3, completed_at=NOW() WHERE id=$4`,
        [cmdStr, output, `exit code ${code}`, recordId]
      );
      notify.send('❌ 投稿失败', `模板：${tmpl.name}\n标题：${title}\n错误：exit code ${code}`);
    }
  });

  await pool.query(`UPDATE upload_records SET command=$1 WHERE id=$2`, [[biliupPath, ...args].join(' '), recordId]);
  console.log(`[自动投稿] 会话 ${session.id} → 模板 ${tmpl.id}「${tmpl.name}」已启动`);
}

async function findAndAutoUpload(session) {
  try {
    const tmpls = await pool.query(
      `SELECT * FROM upload_templates WHERE room_url = $1 OR room_url IS NULL ORDER BY room_url NULLS LAST LIMIT 1`,
      [session.room_url]
    );
    if (tmpls.rows.length === 0) return;
    const tmpl = tmpls.rows[0];
    if (!tmpl.cookies_path) { console.log(`[自动投稿] 模板 ${tmpl.id} 未配置 cookies_path，跳过`); return; }
    await executeUpload(session, tmpl);
  } catch (err) {
    console.error('[自动投稿] 失败:', err.message);
  }
}

// ─── 手动投稿 ─────────────────────────────────

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

    if (!tmpl.cookies_path) return res.status(400).json({ status: 'Error', message: '模板未配置账户文件(cookies_path)' });

    await executeUpload(session, tmpl);
    res.json({ status: 'ok', message: '上传已启动', data: { record_id: null, title: '', file_count: 0 } });
  } catch (err) {
    console.error('[upload] 上传失败:', err);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

module.exports = { router, findAndAutoUpload };
