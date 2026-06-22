const fs = require('fs');
const path = require('path');
const pool = require('../../../db/index');
const notify = require('../notify');
const biliup = require('../biliup');
const UploadService = require('../../../services/UploadService');

function formatDuration(seconds) {
  const total = parseInt(seconds, 10) || 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}小时${minutes}分钟`;
  return `${minutes}分钟`;
}

function resolveDisplayName(record) {
  return record.config_principal_name || record.room_name || record.principal_name || record.principal_id || 'unknown';
}

function getReplayTemplateVars(record) {
  const startedAt = record.start_time || record.created_at || new Date();
  const displayName = resolveDisplayName(record);
  const baseVars = UploadService.getTemplateVars(
    { room_name: displayName, room_url: record.play_url },
    { started_at: startedAt, caption: '', duration_seconds: record.duration || 0 }
  );
  const date = new Date(startedAt);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    ...baseVars,
    room_name: displayName,
    principal_name: displayName,
    principal_id: record.principal_id || '',
    replay_date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    replay_time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    duration: formatDuration(record.duration),
    replay_id: record.replay_id || '',
  };
}

function parseFileList(record) {
  for (const field of ['final_file_paths', 'fixed_file_paths', 'cut_file_paths']) {
    try {
      const parsed = JSON.parse(record[field] || '[]');
      const files = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
      if (files.length > 0) return files;
    } catch (_) {}
  }
  return [record.raw_file_path].filter(Boolean);
}

async function getReplayRecordForUpload(replayRecordId) {
  const result = await pool.query(
    `SELECT rr.*,
            NULLIF(rs.value, '') AS config_principal_name,
            rooms.room_name AS room_name
     FROM replay_records rr
     LEFT JOIN replay_settings rs
       ON rs.principal_id = rr.principal_id
      AND rs.key = 'principal_name'
     LEFT JOIN rooms
       ON rooms.room_url ILIKE '%' || rr.principal_id || '%'
      AND rooms.room_url ILIKE '%live.kuaishou.com%'
     WHERE rr.id = $1
     ORDER BY rooms.id DESC
     LIMIT 1`,
    [replayRecordId]
  );
  return result.rows[0] || null;
}

class ReplayUploadService {
  static async getUploadPreview(replayRecordId) {
    const record = await getReplayRecordForUpload(replayRecordId);
    if (!record) {
      return { error: true, message: '回放记录不存在' };
    }

    const settingsResult = await pool.query(
      `SELECT value FROM replay_settings WHERE principal_id = $1 AND key = 'upload_template_id'`,
      [record.principal_id]
    );
    const templateId = settingsResult.rows[0]?.value;
    if (!templateId) {
      return { error: true, message: '未配置回放投稿模板' };
    }

    const tmplResult = await pool.query('SELECT * FROM upload_templates WHERE id = $1', [templateId]);
    const tmpl = tmplResult.rows[0];
    if (!tmpl) {
      return { error: true, message: '回放投稿模板不存在或已删除' };
    }

    const vars = getReplayTemplateVars(record);
    const descFull = UploadService.renderTemplate(tmpl.desc_template || '', vars);
    const desc = descFull.length > 100 ? `${descFull.slice(0, 100)}...` : descFull;

    return {
      error: false,
      preview: {
        title: UploadService.renderTemplate(tmpl.title_template || '', vars),
        desc,
        desc_full: descFull,
        tags: UploadService.renderTemplate(tmpl.tags || '', vars),
        template_name: tmpl.name || '',
      },
    };
  }

  static async executeUpload(replayRecordId) {
    const record = await getReplayRecordForUpload(replayRecordId);
    if (!record) {
      return { error: true, message: '回放记录不存在' };
    }

    const settingsResult = await pool.query(
      `SELECT value FROM replay_settings WHERE principal_id = $1 AND key = 'upload_template_id'`,
      [record.principal_id]
    );
    const templateId = settingsResult.rows[0]?.value;
    if (!templateId) {
      return { error: true, message: '未配置回放投稿模板' };
    }

    const tmplResult = await pool.query('SELECT * FROM upload_templates WHERE id = $1', [templateId]);
    const tmpl = tmplResult.rows[0];
    if (!tmpl) {
      return { error: true, message: '回放投稿模板不存在或已删除' };
    }

    const vars = getReplayTemplateVars(record);
    const title = UploadService.renderTemplate(tmpl.title_template || '', vars);
    const desc = UploadService.renderTemplate(tmpl.desc_template || '', vars);
    const tags = UploadService.renderTemplate(tmpl.tags || '', vars);
    const source = UploadService.renderTemplate(tmpl.source || record.play_url || '', vars);

    let files = parseFileList(record).map((fp) => path.resolve(fp));
    files = files.filter((fp) => {
      try {
        return fs.statSync(fp).isFile();
      } catch (_) {
        return false;
      }
    });
    if (files.length === 0) {
      return { error: true, message: '回放记录无可投稿文件' };
    }

    const totalSize = files.reduce((sum, fp) => {
      try {
        return sum + fs.statSync(fp).size;
      } catch (_) {
        return sum;
      }
    }, 0);

    const uploadRecord = await pool.query(
      `INSERT INTO replay_upload_records
       (replay_record_id, template_id, template_name, title, status, file_count, total_size, upload_files)
       VALUES ($1,$2,$3,$4,'uploading',$5,$6,$7)
       RETURNING id`,
      [record.id, tmpl.id, tmpl.name || '', title, files.length, totalSize, JSON.stringify(files)]
    );
    const uploadRecordId = uploadRecord.rows[0].id;

    const displayName = resolveDisplayName(record);
    notify.uploadStart(displayName, tmpl.name, files.length, record.play_url);
    this._runUpload(uploadRecordId, record, tmpl, files, title, desc, tags, source).catch((err) => {
      console.error('[回放投稿] 后台上传异常:', err);
    });

    return { error: false, message: '回放投稿任务已启动', upload_record_id: uploadRecordId };
  }

  static async _runUpload(uploadRecordId, record, tmpl, files, title, desc, tags, source) {
    const cmdParts = [process.env.BILIUP_PATH || 'biliup', '-u', tmpl.cookies_path, 'upload'];
    if (title) cmdParts.push('--title', title);
    if (desc) cmdParts.push(`--desc=${desc}`);
    if (tags) cmdParts.push('--tag', tags);
    if (source) cmdParts.push('--source', source);
    cmdParts.push(...files);
    const cmdStr = cmdParts.join(' ');

    try {
      const result = await biliup.upload({
        cookiesPath: tmpl.cookies_path,
        files,
        title,
        desc,
        tags,
        source,
        tid: tmpl.tid,
        copyright: tmpl.copyright,
        isOnlySelf: tmpl.is_only_self,
        cover: tmpl.cover,
        dtime: tmpl.dtime,
        recordId: `replay_${uploadRecordId}`,
      });

      if (result.success) {
        await pool.query(
          `UPDATE replay_upload_records
           SET status='success', command=$1, output=$2, bv_id=$3, completed_at=NOW()
           WHERE id=$4`,
          [cmdStr, result.output, result.bvId, uploadRecordId]
        );
        await pool.query(
          `UPDATE replay_records SET status='completed', bv_id=$1, uploaded_at=NOW(), completed_at=NOW(), updated_at=NOW() WHERE id=$2`,
          [result.bvId, record.id]
        );
        const displayName = resolveDisplayName(record);
        notify.uploadComplete(displayName, title, result.bvId, record.play_url);
      } else {
        await pool.query(
          `UPDATE replay_upload_records
           SET status='failed', command=$1, output=$2, error_message=$3, completed_at=NOW()
           WHERE id=$4`,
          [cmdStr, result.output, result.error, uploadRecordId]
        );
        const displayName = resolveDisplayName(record);
        await notify.uploadFailed(displayName, tmpl.name, title, result.error, record.play_url);
      }
    } catch (err) {
      await pool
        .query(
          `UPDATE replay_upload_records
           SET status='failed', command=$1, error_message=$2, completed_at=NOW()
           WHERE id=$3`,
          [cmdStr, err.message, uploadRecordId]
        )
        .catch(() => {});
    }
  }
}

module.exports = ReplayUploadService;
