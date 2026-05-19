const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const pool = require('../db/index');
const redis = require('../db/redis');
const transcodeQueue = require('../lib/core/TranscodeQueue');
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

  static async isSessionDeleted(sessionId) {
    const r = await pool.query('SELECT deleted_at FROM recording_sessions WHERE id = $1', [sessionId]);
    return r.rows.length === 0 || r.rows[0].deleted_at != null;
  }

  static async executeUpload(session, tmpl) {
    if (await this.isSessionDeleted(session.id)) {
      console.log(`[投稿] 会话 ${session.id} 已删除，跳过`);
      return;
    }

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

    // 读取碎片大小阈值
    const thresholdValue = await this.getSetting('filtering_threshold', '10');
    const thresholdBytes = (parseInt(thresholdValue, 10) || 10) * 1024 * 1024;

    files = files.filter((fp) => {
      try {
        const stat = fs.statSync(fp);
        return stat.isFile() && stat.size >= thresholdBytes;
      } catch {
        return false;
      }
    });

    files = files.map((fp) => path.resolve(fp));

    if (files.length === 0) {
      console.log(`[投稿] 会话 ${session.id} 无有效文件（或均小于碎片阈值），跳过`);
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
      `INSERT INTO upload_records (session_id, template_id, room_url, title, status, file_count, total_size, upload_files)
       VALUES ($1,$2,$3,$4,'uploading',$5,$6,$7) RETURNING id`,
      [session.id, tmpl.id, session.room_url, title, files.length, totalSize, JSON.stringify(files)]
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
      await notify.uploadFailed(session.room_name, tmpl.name, title, '进程启动失败', session.room_url);
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
          session.room_name,
          session.room_url
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
        await notify.uploadFailed(session.room_name, tmpl.name, title, `exit code ${code}`, session.room_url);
      }
    });

    await pool.query(`UPDATE upload_records SET command=$1 WHERE id=$2`, [[biliupPath, ...args].join(' '), recordId]);
    console.log(`[投稿] 会话 ${session.id} → 模板 ${tmpl.id}「${tmpl.name}」已启动`);
  }

  static async getSetting(key, def) {
    try {
      const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
      if (r.rows.length) return r.rows[0].value;
    } catch (_) {}
    return def;
  }

  static async hasBlockingUploadRecord(sessionId) {
    const r = await pool.query(
      `SELECT 1 FROM upload_records WHERE session_id = $1 AND status IN ('uploading', 'success') LIMIT 1`,
      [sessionId]
    );
    return r.rows.length > 0;
  }

  /**
   * 会话文件是否均已转码完成（无队列任务、无待转 FLV）
   */
  static async isSessionTranscodeComplete(sessionId) {
    if (await transcodeQueue.hasSessionPending(sessionId)) return false;

    const autoTranscode = await this.getSetting('auto_transcode', 'true');
    if (autoTranscode !== 'true') return true;

    let paths = [];
    const files = await pool.query(
      `SELECT file_path FROM recording_files
       WHERE session_id = $1 AND status NOT IN ('missing', 'deleted')`,
      [sessionId]
    );
    paths = files.rows.map((r) => r.file_path).filter(Boolean);

    if (paths.length === 0) {
      const recs = await pool.query(
        `SELECT file_path FROM recordings
         WHERE session_id = $1 AND status IN ('completed', 'interrupted')`,
        [sessionId]
      );
      paths = recs.rows.map((r) => r.file_path).filter(Boolean);
    }

    for (const fp of paths) {
      if (!/\.flv$/i.test(fp)) continue;
      try {
        if (!fs.existsSync(fp)) continue;
        const mp4 = fp.replace(/\.flv$/i, '.mp4');
        if (!fs.existsSync(mp4)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * 看门狗：扫描已完成且转码就绪的会话，按直播间模板自动投稿
   */
  static async scanPendingAutoUpload() {
    try {
      const { rows } = await pool.query(
        `SELECT rs.id, rs.room_url, rs.started_at, r.room_name, r.upload_template_id
         FROM recording_sessions rs
         INNER JOIN rooms r ON r.room_url = rs.room_url
         WHERE rs.status = 'completed'
           AND rs.deleted_at IS NULL
           AND r.upload_template_id IS NOT NULL
           AND rs.ended_at > NOW() - INTERVAL '7 days'
           AND NOT EXISTS (
             SELECT 1 FROM upload_records ur
             WHERE ur.session_id = rs.id AND ur.status IN ('uploading', 'success')
           )
         ORDER BY rs.ended_at DESC
         LIMIT 20`
      );

      for (const row of rows) {
        if (!(await this.isSessionTranscodeComplete(row.id))) continue;

        const tmplResult = await pool.query('SELECT * FROM upload_templates WHERE id = $1', [row.upload_template_id]);
        if (tmplResult.rows.length === 0) continue;

        const tmpl = tmplResult.rows[0];
        if (!tmpl.cookies_path) continue;
        if (!(await this.checkUploadLimit(row.id))) continue;
        if (await this.hasBlockingUploadRecord(row.id)) continue;

        const session = {
          id: row.id,
          room_url: row.room_url,
          room_name: row.room_name,
          started_at: row.started_at,
        };
        console.log(`[看门狗][投稿] 会话 ${row.id} 转码已完成，启动自动投稿`);
        await this.executeUpload(session, tmpl);
      }
    } catch (err) {
      console.error('[看门狗][投稿] 扫描失败:', err.message);
    }
  }

  static async findAndAutoUpload(session) {
    const lockKey = `lock:auto_upload:${session.id}`;
    try {
      const acquired = await redis.set(lockKey, '1', { EX: 300, NX: true });
      if (!acquired) {
        console.log(`[投稿] 会话 ${session.id} 正在执行中，跳过`);
        return;
      }
    } catch (_) {}

    try {
      if (!(await this.checkUploadLimit(session.id))) return;

      const existingRecords = await pool.query(
        'SELECT id, status FROM upload_records WHERE session_id = $1 LIMIT 1',
        [session.id]
      );
      if (existingRecords.rows.length > 0) {
        console.log(
          `[投稿] 会话 ${session.id} 已有投稿记录，跳过自动投稿`
        );
        return;
      }

      const sess = await pool.query(
        'SELECT status FROM recording_sessions WHERE id = $1',
        [session.id]
      );
      if (sess.rows.length === 0 || sess.rows[0].status !== 'completed') {
        console.log(
          `[投稿] 会话 ${session.id} 状态非 completed (${sess.rows[0]?.status || '不存在'})，跳过自动投稿`
        );
        return;
      }

      if (!(await this.isSessionTranscodeComplete(session.id))) {
        console.log(
          `[投稿] 会话 ${session.id} 转码未完成，跳过自动投稿（等待看门狗兜底）`
        );
        return;
      }

      let tmpl = null;

      const roomResult = await pool.query('SELECT upload_template_id FROM rooms WHERE room_url = $1', [
        session.room_url,
      ]);
      if (roomResult.rows.length > 0 && roomResult.rows[0].upload_template_id) {
        const tmplResult = await pool.query('SELECT * FROM upload_templates WHERE id = $1', [
          roomResult.rows[0].upload_template_id,
        ]);
        if (tmplResult.rows.length > 0) {
          tmpl = tmplResult.rows[0];
        }
      }

      if (!tmpl) {
        console.log(`[投稿] 会话 ${session.id} 直播间未配置投稿模板，跳过`);
        return;
      }

      if (!tmpl.cookies_path) {
        console.log(`[投稿] 模板 ${tmpl.id} 未配置 cookies_path，跳过`);
        return;
      }

      await this.executeUpload(session, tmpl);
    } catch (err) {
      console.error('[投稿] 失败:', err.message);
    }
  }
}

module.exports = UploadService;
