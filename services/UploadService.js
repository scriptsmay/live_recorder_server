const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const pool = require('../db/index');
const redis = require('../db/redis');
const notify = require('../lib/core/notify');
const { createProcLog } = require('../lib/utils/proc-log');
const { afterUpload } = require('../lib/core/backup');

class UploadService {
  static async getUploadLimit() {
    try {
      const r = await pool.query("SELECT value FROM settings WHERE key = 'max_upload_limit'");
      if (r.rows.length) return parseInt(r.rows[0].value, 10) || 99;
    } catch (_) {}
    return 99;
  }

  static async checkUploadLimit(sessionId) {
    const limit = await this.getUploadLimit();
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

  static renderTemplate(template, vars) {
    return template.replace(/\{(\w+)\}/g, (_, key) => (vars[key] !== undefined ? vars[key] : `{${key}}`));
  }

  static getTemplateVars(room, session) {
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

  static async executeUpload(session, tmpl) {
    const room = { room_url: session.room_url, room_name: session.room_name };
    const vars = this.getTemplateVars(room, session);
    const title = this.renderTemplate(tmpl.title_template, vars);
    const desc = this.renderTemplate(tmpl.desc_template || '', vars);
    const tags = this.renderTemplate(tmpl.tags || '', vars);
    const source = this.renderTemplate(tmpl.source || '{room_url}', vars);

    let recs = await pool.query(
      `SELECT DISTINCT ON (file_path) * FROM recordings
       WHERE session_id = $1 AND status IN ('completed', 'interrupted')
       ORDER BY file_path`,
      [session.id]
    );
    let files = recs.rows.map((r) => r.file_path).filter(Boolean);

    if (files.length === 0) {
      const fallback = await pool.query(
        `SELECT DISTINCT file_path, file_size FROM recording_files
         WHERE session_id = $1 AND status IN ('recording', 'interrupted', 'completed')
         ORDER BY file_path`,
        [session.id]
      );
      files = fallback.rows.map((r) => r.file_path).filter(Boolean);
    }

    files = files.filter((fp) => {
      try {
        return fs.statSync(fp).isFile();
      } catch {
        return false;
      }
    });

    files = files.map((fp) => path.resolve(fp));

    if (files.length === 0) {
      console.log(`[自动投稿] 会话 ${session.id} 无文件，跳过`);
      return;
    }

    const totalSize = files.reduce((sum, f) => {
      try {
        return sum + fs.statSync(f).size;
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

    const { stream: logStream, logPath } = createProcLog('biliup', recordId);
    console.log(`[投稿] biliup 日志: ${logPath}`);
    logStream.write(`# COMMAND: ${biliupPath} ${args.join(' ')}\n`);

    const uploadCwd = process.env.BILIUP_WORK_DIR || process.env.HOME || '.';
    fs.mkdirSync(uploadCwd, { recursive: true });
    const proc = spawn(biliupPath, args, { cwd: uploadCwd });

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

  static async findAndAutoUpload(session) {
    try {
      if (!(await this.checkUploadLimit(session.id))) return;

      let tmpl = null;

      const roomResult = await pool.query('SELECT upload_template_id FROM rooms WHERE room_url = $1', [session.room_url]);
      if (roomResult.rows.length > 0 && roomResult.rows[0].upload_template_id) {
        const tmplResult = await pool.query('SELECT * FROM upload_templates WHERE id = $1', [roomResult.rows[0].upload_template_id]);
        if (tmplResult.rows.length > 0) {
          tmpl = tmplResult.rows[0];
        }
      }

      if (!tmpl) {
        const globalTmpls = await pool.query('SELECT * FROM upload_templates ORDER BY id LIMIT 1');
        if (globalTmpls.rows.length > 0) {
          tmpl = globalTmpls.rows[0];
        }
      }

      if (!tmpl) {
        console.log(`[自动投稿] 会话 ${session.id} 找不到可用模板`);
        return;
      }

      if (!tmpl.cookies_path) {
        console.log(`[自动投稿] 模板 ${tmpl.id} 未配置 cookies_path，跳过`);
        return;
      }

      await this.executeUpload(session, tmpl);
    } catch (err) {
      console.error('[自动投稿] 失败:', err.message);
    }
  }
}

module.exports = UploadService;
