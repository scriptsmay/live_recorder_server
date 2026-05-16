const { spawn } = require('child_process');
const express = require('express');
const router = express.Router();
const pool = require('../db/index');
const redis = require('../db/redis');
const notify = require('../lib/notify');
const { createProcLog } = require('../lib/proc-log');
const { afterUpload } = require('../lib/backup');

async function getUploadLimit() {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key = 'max_upload_limit'");
    if (r.rows.length) return parseInt(r.rows[0].value, 10) || 99;
  } catch (_) {}
  return 99;
}

async function checkUploadLimit(sessionId) {
  const limit = await getUploadLimit();
  try {
    const count = await redis.incr(`upload_count:${sessionId}`);
    if (count === 1) {
      await redis.expire(`upload_count:${sessionId}`, 86400);
    }
    if (count > limit) {
      console.log(`[上传限制] 会话 ${sessionId} 已达上传次数上限 (${count - 1}/${limit})，跳过`);
      return false;
    }
    return true;
  } catch (_) {
    return true;
  }
}

function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => (vars[key] !== undefined ? vars[key] : `{${key}}`));
}

function getTemplateVars(room, session) {
  const date = session.started_at ? new Date(session.started_at) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    room_name: room.room_name || room.room_url || 'unknown',
    room_url: room.room_url || '',
    caption: session.caption || '',
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
    const {
      name,
      room_url,
      title_template,
      desc_template,
      tid,
      tags,
      copyright,
      source,
      cover,
      is_only_self,
      cookies_path,
      dtime,
      after_upload,
    } = req.body;
    if (!name) return res.status(400).json({ status: 'Error', message: '模板名称必填' });
    const result = await pool.query(
      `INSERT INTO upload_templates (name, room_url, title_template, desc_template, tid, tags, copyright, source, cover, is_only_self, cookies_path, dtime, after_upload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        name,
        room_url || null,
        title_template || '{room_name} 直播录像 {date}',
        desc_template || '',
        tid || 171,
        tags || '',
        copyright ?? 2,
        source || '',
        cover || '',
        is_only_self ?? 0,
        cookies_path || '',
        dtime || 0,
        after_upload || 'none',
      ]
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
    const {
      name,
      room_url,
      title_template,
      desc_template,
      tid,
      tags,
      copyright,
      source,
      cover,
      is_only_self,
      cookies_path,
      dtime,
      after_upload,
    } = req.body;
    const result = await pool.query(
      `UPDATE upload_templates SET name=$1, room_url=$2, title_template=$3, desc_template=$4,
       tid=$5, tags=$6, copyright=$7, source=$8, cover=$9, is_only_self=$10, cookies_path=$11, dtime=$12, after_upload=$13, updated_at=NOW()
       WHERE id=$14 RETURNING *`,
      [
        name,
        room_url || null,
        title_template,
        desc_template,
        tid,
        tags,
        copyright,
        source || '',
        cover,
        is_only_self ?? 0,
        cookies_path || '',
        dtime || 0,
        after_upload || 'none',
        id,
      ]
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

  let recs = await pool.query(
    `SELECT DISTINCT ON (file_path) * FROM recordings
     WHERE session_id = $1 AND status IN ('completed', 'interrupted')
     ORDER BY file_path`,
    [session.id]
  );
  let files = recs.rows.map((r) => r.file_path).filter(Boolean);

  // 回退到 recording_files（会话异常中断时 recordings 可能无数据）
  if (files.length === 0) {
    const fallback = await pool.query(
      `SELECT DISTINCT file_path, file_size FROM recording_files
       WHERE session_id = $1 AND status IN ('recording', 'interrupted', 'completed')
       ORDER BY file_path`,
      [session.id]
    );
    files = fallback.rows.map((r) => r.file_path).filter(Boolean);
  }

  // 过滤掉磁盘上已不存在的文件
  files = files.filter((fp) => {
    try {
      return require('fs').statSync(fp).isFile();
    } catch {
      return false;
    }
  });

  if (files.length === 0) {
    console.log(`[自动投稿] 会话 ${session.id} 无文件，跳过`);
    return;
  }

  const totalSize = files.reduce((sum, f) => {
    try {
      return sum + require('fs').statSync(f).size;
    } catch {
      return sum;
    }
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
  if (desc) args.push(`--desc=${desc}`);
  if (tmpl.tid) args.push('--tid', String(tmpl.tid));
  if (tags) args.push('--tag', tags);
  if (tmpl.copyright) args.push('--copyright', String(tmpl.copyright));
  if (source) args.push('--source', source);
  if (tmpl.is_only_self) args.push('--is-only-self', String(tmpl.is_only_self));
  if (tmpl.cover) args.push('--cover', tmpl.cover);
  if (tmpl.dtime) args.push('--dtime', String(tmpl.dtime));
  args.push(...files);

  notify.uploadStart(session.room_name, tmpl.name, files.length, session.room_url);

  const { stream: logStream, logPath, logCommand } = createProcLog('biliup', recordId);
  console.log(`[投稿] biliup 日志: ${logPath}`);
  logCommand(biliupPath, args);

  const uploadCwd = process.env.BILIUP_WORK_DIR || process.env.HOME || '.';
  require('fs').mkdirSync(uploadCwd, { recursive: true });
  const proc = spawn(biliupPath, args, {
    cwd: uploadCwd,
  });

  let output = '';
  proc.stdout.on('data', (d) => {
    const s = d.toString();
    output += s;
    logStream.write(s);
  });
  proc.stderr.on('data', (d) => {
    const s = d.toString();
    output += s;
    logStream.write(s);
  });

  proc.on('error', async () => {
    await pool.query(
      `UPDATE upload_records SET status='failed', error_message=$1, output=$2, completed_at=NOW() WHERE id=$3`,
      ['进程启动失败', output, recordId]
    );
    notify.send('❌ 投稿失败', `模板：${tmpl.name}\n错误：进程启动失败`);
  });

  proc.on('close', async (code) => {
    const cmdStr = `${biliupPath} ${args.join(' ')}`;
    const bvMatch = output.match(/BV[0-9A-Za-z]{10}/);
    const bvId = bvMatch ? bvMatch[0] : '';
    if (code === 0) {
      await pool.query(
        `UPDATE upload_records SET status='success', command=$1, output=$2, bv_id=$3, completed_at=NOW() WHERE id=$4`,
        [cmdStr, output, bvId, recordId]
      );
      notify.uploadComplete(session.room_name, title, bvId, session.room_url);

      await new Promise((r) => setTimeout(r, 10000));
      const postResult = await afterUpload(
        tmpl.after_upload,
        files,
        session.id,
        tmpl.name,
        recordId,
        session.room_name
      );
      if (postResult) {
        output += `\n--- 投稿后处理 ---\n${JSON.stringify(postResult)}`;
        await pool.query(`UPDATE upload_records SET output=$1 WHERE id=$2`, [output, recordId]);
      }
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
    if (!(await checkUploadLimit(session.id))) return;
    const tmpls = await pool.query(
      `SELECT * FROM upload_templates WHERE room_url = $1 OR room_url IS NULL ORDER BY room_url NULLS LAST LIMIT 1`,
      [session.room_url]
    );
    if (tmpls.rows.length === 0) return;
    const tmpl = tmpls.rows[0];
    if (!tmpl.cookies_path) {
      console.log(`[自动投稿] 模板 ${tmpl.id} 未配置 cookies_path，跳过`);
      return;
    }
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

    if (!(await checkUploadLimit(session.id))) {
      return res.status(429).json({ status: 'Error', message: '该会话已达上传次数上限' });
    }

    const { template_id } = req.body;
    if (!template_id) return res.status(400).json({ status: 'Error', message: '请指定投稿模板' });

    const tmplResult = await pool.query('SELECT * FROM upload_templates WHERE id = $1', [template_id]);
    if (tmplResult.rows.length === 0) return res.status(404).json({ status: 'Error', message: '模板不存在' });
    const tmpl = tmplResult.rows[0];

    if (!tmpl.cookies_path)
      return res.status(400).json({ status: 'Error', message: '模板未配置账户文件(cookies_path)' });

    await executeUpload(session, tmpl);
    res.json({
      status: 'ok',
      message: '上传已启动',
      data: { record_id: null, title: '', file_count: 0 },
    });
  } catch (err) {
    console.error('[upload] 上传失败:', err);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

module.exports = { router, findAndAutoUpload };
