const express = require('express');
const { spawn } = require('child_process');
const router = express.Router();
const pool = require('../db/index');
const UploadService = require('../services/UploadService');
const DataService = require('../services/DataService');
const SeasonService = require('../services/SeasonService');
const { createProcLog } = require('../lib/utils/proc-log');

/**
 * 合集 ID（BIGINT）入参归一：空值落 null，非正整数视为非法。
 * 直接 parseInt 会得到 NaN，落到 pg 只是 500，前端拿不到可改的提示。
 */
function parseSeasonId(value) {
  if (value === undefined || value === null || value === '') return { valid: true, value: null };
  const raw = typeof value === 'string' ? value.trim() : value;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return { valid: true, value: raw };
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed > 0) return { valid: true, value: parsed };
  }
  return { valid: false, value: null };
}

function invalidSeasonIdReply(res) {
  return res.status(400).json({ status: 'Error', message: '合集 ID 必须为正整数' });
}

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
      use_room_cover,
      season_id,
      season_title,
      section_id,
      season_auto_add,
    } = req.body;
    const seasonId = parseSeasonId(season_id);
    const sectionId = parseSeasonId(section_id);
    if (!seasonId.valid || !sectionId.valid) return invalidSeasonIdReply(res);
    if (seasonId.value || sectionId.value) {
      const verdict = await SeasonService.validateSelection(cookies_path, seasonId.value, sectionId.value);
      if (!verdict.ok) return res.status(verdict.http).json({ status: 'Error', message: verdict.message });
    }
    const result = await pool.query(
      `INSERT INTO upload_templates
       (name, cookies_path, title_template, desc_template, tags, source, tid, copyright, is_only_self, cover, dtime, after_upload, use_room_cover,
        season_id, season_title, section_id, season_auto_add)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
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
        use_room_cover === true,
        seasonId.value,
        season_title || null,
        sectionId.value,
        season_auto_add === true,
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
      'use_room_cover',
      'season_id',
      'season_title',
      'section_id',
      'season_auto_add',
    ];
    const intFields = new Set(['tid', 'copyright', 'is_only_self', 'dtime']);
    // BOOLEAN 列严格归一，非布尔输入（'true'/1 等）不落库报错
    const boolFields = new Set(['use_room_cover', 'season_auto_add']);
    const seasonFields = new Set(['season_id', 'section_id']);
    const sets = [];
    const values = [];
    const selection = {};
    for (const field of fields) {
      if (req.body[field] === undefined) continue;
      let value;
      if (seasonFields.has(field)) {
        const parsed = parseSeasonId(req.body[field]);
        if (!parsed.valid) return invalidSeasonIdReply(res);
        value = parsed.value;
        selection[field] = parsed.value;
      } else if (intFields.has(field)) {
        const raw = req.body[field];
        value = raw != null && raw !== '' ? parseInt(raw, 10) : null;
      } else if (boolFields.has(field)) {
        value = req.body[field] === true;
      } else {
        value = req.body[field];
      }
      sets.push(`${field} = $${values.length + 1}`);
      values.push(value);
    }
    if (sets.length === 0) {
      return res.status(400).json({ status: 'Error', message: '无更新字段' });
    }
    // 选了合集、或换了 cookie，都要按最终生效的组合校验归属；校验不过就不写库
    const needsCheck =
      selection.season_id !== undefined || selection.section_id !== undefined || req.body.cookies_path !== undefined;
    if (needsCheck) {
      const existing = await pool.query(
        'SELECT cookies_path, season_id, section_id FROM upload_templates WHERE id = $1',
        [id]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ status: 'Error', message: '模板不存在' });
      }
      const current = existing.rows[0];
      const verdict = await SeasonService.validateSelection(
        req.body.cookies_path !== undefined ? req.body.cookies_path : current.cookies_path,
        selection.season_id !== undefined ? selection.season_id : current.season_id,
        selection.section_id !== undefined ? selection.section_id : current.section_id
      );
      if (!verdict.ok) return res.status(verdict.http).json({ status: 'Error', message: verdict.message });
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

/**
 * 常规（录制）投稿记录列表 —— 只服务 upload_records 单表。
 *
 * 回放投稿请走 `GET /api/replay_upload_records`（server/router/replay.js）。
 * 两表 id 各自独立自增，端点按路径分表后不再有「同号稿件指错表」的可能。
 */
router.get('/upload_records', async (req, res) => {
  try {
    const { session_id, status, season_status, title, limit = 50, page } = req.query;
    const result = await DataService.getUploadRecords({
      session_id,
      status,
      season_status,
      title,
      limit,
      page,
    });
    res.json({ status: 'ok', data: result.rows, total: result.total, page: result.page, limit: result.limit });
  } catch (err) {
    console.error('[upload_records] 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

/**
 * 删除常规（录制）投稿记录 —— 只动 upload_records 单表。
 *
 * 回放投稿请走 `DELETE /api/replay_upload_records/:id`（server/router/replay.js）。
 * 按路径分表后不再有 `?source=` 参数，也就不存在「漏传/误传删错表」的风险类别。
 */
router.delete('/upload_records/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM upload_records WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '投稿记录不存在' });
    }
    res.json({ status: 'ok', data: { id: result.rows[0].id } });
  } catch (err) {
    console.error('[upload_records] 删除失败:', err);
    res.status(500).json({ status: 'Error', message: '删除失败' });
  }
});

/**
 * 合集相关端点（v1.11.0）
 * 凭证红线：错误只回类别，cookie 相关问题一律引导用户检查模板配置，不回显任何凭证。
 */

function seasonFailure(res, err) {
  const code = (err && err.code) || 'unknown';
  console.error(`[合集] 请求失败: ${code}`);
  const cookieIssue = code.startsWith('COOKIE') || code === 'AUTH_EXPIRED' || code === 'CREDENTIAL_INVALID';
  const message = cookieIssue ? 'cookie 不可用，请检查模板的 cookie 配置与登录态' : '合集信息获取失败，请稍后重试';
  return res.status(cookieIssue ? 400 : 500).json({ status: 'Error', message });
}

/**
 * 模板维度拉取合集 + 小节（模板编辑页的三级级联用）
 */
router.get('/upload_templates/:id/seasons', async (req, res) => {
  try {
    const tmpl = await pool.query('SELECT cookies_path FROM upload_templates WHERE id = $1', [req.params.id]);
    if (tmpl.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '模板不存在' });
    }
    const data = await SeasonService.listSeasonsByCookies(tmpl.rows[0].cookies_path, {
      force: req.query.force === '1',
    });
    res.json({ status: 'ok', data });
  } catch (err) {
    seasonFailure(res, err);
  }
});

/**
 * 手动重试「加入合集」（常规/录制投稿）—— 只动 upload_records 单表。
 *
 * 回放投稿请走 `POST /api/replay_upload_records/:id/season/retry`（server/router/replay.js）。
 * 按路径分表后不再有 `?source=` 参数，两表同号稿件不可能互相串台。
 */
router.post('/upload_records/:id/season/retry', async (req, res) => {
  try {
    const result = await SeasonService.retryAdd(req.params.id, 'recording');
    if (!result.ok) {
      return res.status(result.http || 500).json({ status: 'Error', message: result.message });
    }
    res.json({ status: 'ok', message: result.message });
  } catch (err) {
    seasonFailure(res, err);
  }
});

module.exports = router;
