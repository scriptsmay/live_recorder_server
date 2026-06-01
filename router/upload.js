const express = require('express');
const { spawn } = require('child_process');
const router = express.Router();
const pool = require('../db/index');
const UploadService = require('../services/UploadService');
const DataService = require('../services/DataService');
const { createProcLog } = require('../lib/utils/proc-log');

router.get('/upload_templates', async (req, res) => {
  try {
    const data = await DataService.getTemplates();
    res.json({ status: 'ok', data });
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
        tid != null ? parseInt(tid, 10) : null,
        copyright != null ? parseInt(copyright, 10) : null,
        is_only_self != null ? parseInt(is_only_self, 10) : 0,
        cover || null,
        dtime != null && dtime !== '' ? parseInt(dtime, 10) : null,
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
      'name',
      'cookies_path',
      'title_template',
      'desc_template',
      'tags',
      'source',
      'tid',
      'copyright',
      'is_only_self',
      'cover',
      'dtime',
      'after_upload',
    ];
    const intFields = new Set(['tid', 'copyright', 'is_only_self', 'dtime']);
    const sets = [];
    const values = [];
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        sets.push(`${field} = $${values.length + 1}`);
        const val = req.body[field];
        if (intFields.has(field)) {
          values.push(val != null && val !== '' ? parseInt(val, 10) : null);
        } else {
          values.push(val);
        }
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

router.post('/biliup/renew', async (req, res) => {
  try {
    const { template_id } = req.body;
    if (!template_id) {
      return res.status(400).json({ status: 'Error', message: '缺少 template_id' });
    }

    const tmpl = await DataService.getTemplates();
    const templateId = parseInt(template_id, 10);
    const row = tmpl.find((t) => t.id === templateId);
    if (!row) {
      return res.status(404).json({ status: 'Error', message: '模板不存在' });
    }

    const cookiesPath = row.cookies_path;
    if (!cookiesPath) {
      return res.status(400).json({
        status: 'Error',
        message: '该模板未配置 cookies_path',
      });
    }

    const biliupPath = process.env.BILIUP_PATH || 'biliup';
    const uploadCwd = process.env.BILIUP_WORK_DIR || process.env.HOME || '.';

    const { stream: logStream, logPath } = createProcLog('biliup', `renew_${template_id}`);
    console.log(`[biliup renew] 日志: ${logPath}`);

    const proc = spawn(biliupPath, ['-u', cookiesPath, 'renew'], {
      cwd: uploadCwd,
    });

    logStream.write(`# COMMAND: ${biliupPath} -u ${cookiesPath} renew\n`);

    proc.stdout.on('data', (d) => {
      logStream.write(d.toString());
    });
    proc.stderr.on('data', (d) => {
      logStream.write(d.toString());
    });

    proc.on('error', (err) => {
      logStream.write(`[ERROR] 进程启动失败: ${err.message}\n`);
      console.error('[biliup renew] 进程启动失败:', err.message);
    });

    proc.on('close', (code) => {
      logStream.write(`\n# EXIT CODE: ${code}\n`);
      console.log(`[biliup renew] 模板 ${template_id} 退出码: ${code}, 日志: ${logPath}`);
    });

    res.json({
      status: 'ok',
      message: 'Cookie 刷新已启动，请稍后查看结果',
    });
  } catch (err) {
    console.error('[biliup renew] 失败:', err);
    res.status(500).json({ status: 'Error', message: '刷新失败' });
  }
});

/**
 * 指定会话指定模板ID投稿
 */
router.post('/sessions/:id/upload', async (req, res) => {
  try {
    const { id } = req.params;
    const { template_id } = req.body;
    if (!template_id) {
      return res.status(400).json({ status: 'Error', message: '缺少 template_id' });
    }

    const session = await pool.query(
      `SELECT rs.*, r.room_name 
       FROM recording_sessions rs 
       LEFT JOIN rooms r ON rs.room_url = r.room_url 
       WHERE rs.id = $1`,
      [id]
    );
    if (session.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '会话不存在' });
    }

    const tmpl = await pool.query('SELECT * FROM upload_templates WHERE id = $1', [template_id]);
    if (tmpl.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '模板不存在' });
    }

    const sessionData = session.rows[0];
    const result = await UploadService.executeUpload(sessionData, tmpl.rows[0]);
    if (result.error) {
      return res.json({ status: 'Error', message: result.message });
    }
    res.json({ status: 'ok', message: result.message || '投稿任务已启动' });
  } catch (err) {
    console.error('[sessions] 上传失败:', err);
    res.status(500).json({ status: 'Error', message: '上传失败' });
  }
});

router.get('/upload_records', async (req, res) => {
  try {
    const { session_id, status, limit = 50 } = req.query;
    const data = await DataService.getUploadRecords({
      session_id,
      status,
      limit,
    });
    res.json({ status: 'ok', data });
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
