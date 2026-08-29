const fs = require('fs');
const path = require('path');
const pool = require('../db/index');
const redis = require('../db/redis');
const transcodeQueue = require('../lib/core/TranscodeQueue');
const notify = require('../lib/core/notify');
const biliup = require('../lib/core/biliup');
const { afterUpload } = require('../lib/core/backup');
const DataService = require('./DataService');

/**
 * 上传服务类
 * 负责处理录制文件的自动上传功能，支持模板化配置、文件过滤、转码检查等
 */
class UploadService {
  /**
   * 获取上传次数限制
   * @returns {Promise<number>} 返回每日最大上传次数，默认值为99
   */
  static async getUploadLimit() {
    return parseInt(await DataService.getSetting('max_upload_limit', 99), 10) || 99;
  }

  /**
   * 检查会话的上传次数是否超过限制
   * @param {string} sessionId - 录制会话ID
   * @returns {Promise<boolean>} 如果未超过限制返回true，否则返回false
   */
  static async checkUploadLimit(sessionId) {
    const limit = await this.getUploadLimit();
    try {
      const count = await redis.incr(`upload_count:${sessionId}`);
      if (count === 1) {
        await redis.expire(`upload_count:${sessionId}`, 86400);
      }
      if (count > limit) {
        await redis.set(`upload_skipped:${sessionId}`, '1', { EX: 86400 }).catch(() => {});
        console.log(`[上传限制] 会话 ${sessionId} 已达上传次数上限 (${count - 1}/${limit})，跳过`);
        return false;
      }
      return true;
    } catch (_) {
      return true;
    }
  }

  /**
   * 检查会话是否已被标记为跳过上传
   * @param {string} sessionId - 录制会话ID
   * @returns {Promise<boolean>} 如果已跳过返回true，否则返回false
   */
  static async isUploadSkipped(sessionId) {
    try {
      const skipped = await redis.get(`upload_skipped:${sessionId}`);
      return skipped === '1';
    } catch (_) {
      return false;
    }
  }

  /**
   * 渲染模板字符串，将占位符替换为实际值
   * @param {string} template - 模板字符串，使用 {variableName} 格式
   * @param {Object} vars - 变量映射对象
   * @returns {string} 渲染后的字符串
   */
  static renderTemplate(template, vars) {
    return template.replace(/\{(\w+)\}/g, (_, key) => (vars[key] !== undefined ? vars[key] : `{${key}}`));
  }

  /**
   * 获取模板渲染所需的变量集合
   * @param {Object} room - 直播间信息对象
   * @param {string} room.room_name - 直播间名称
   * @param {string} room.room_url - 直播间URL
   * @param {Object} session - 录制会话对象
   * @param {Date|string} session.started_at - 会话开始时间
   * @param {string} [session.caption] - 会话标题/描述
   * @param {Date|string} [session.ended_at] - 会话结束时间（用于计算 duration_mins）
   * @param {number} [session.duration_seconds] - 会话时长秒数（优先于 ended_at 计算）
   * @returns {Object} 包含所有可用变量的对象
   *   补零时间: YYYY, MM, DD, HH, mm, ss, date, datetime
   *   不补零时间: H, M, D
   *   其他: room_name, room_url, caption, duration_mins
   */
  static getTemplateVars(room, session) {
    const date = session.started_at ? new Date(session.started_at) : new Date();
    const pad = (n) => String(n).padStart(2, '0');

    // 计算时长（分钟）
    let duration_mins = '';
    if (session.duration_seconds > 0) {
      duration_mins = String(Math.round(session.duration_seconds / 60));
    } else if (session.ended_at && session.started_at) {
      const diffMs = new Date(session.ended_at).getTime() - new Date(session.started_at).getTime();
      if (diffMs > 0) duration_mins = String(Math.round(diffMs / 60000));
    }

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
      // 不补零的时间变量
      H: String(date.getHours()),
      M: String(date.getMinutes()),
      D: String(date.getDate()),
      // 时长
      duration_mins,
    };
  }

  /**
   * 检查会话是否已被删除
   * @param {string} sessionId - 录制会话ID
   * @returns {Promise<boolean>} 如果会话不存在或已删除返回true，否则返回false
   */
  static async isSessionDeleted(sessionId) {
    const r = await pool.query('SELECT deleted_at FROM recording_sessions WHERE id = $1', [sessionId]);
    return r.rows.length === 0 || r.rows[0].deleted_at != null;
  }

  /**
   * 执行上传操作
   * 收集录制文件、创建上传记录、调用biliup工具进行上传，并处理上传结果
   * @param {Object} session - 录制会话对象
   * @param {string} session.id - 会话ID
   * @param {string} session.room_url - 直播间URL
   * @param {string} session.room_name - 直播间名称
   * @param {Date|string} session.started_at - 会话开始时间
   * @param {Object} tmpl - 上传模板配置对象
   * @param {number} tmpl.id - 模板ID
   * @param {string} tmpl.name - 模板名称
   * @param {string} tmpl.cookies_path - B站cookies文件路径
   * @param {string} tmpl.title_template - 标题模板
   * @param {string} [tmpl.desc_template] - 描述模板
   * @param {string} [tmpl.tags] - 标签模板
   * @param {string} [tmpl.source] - 来源模板
   * @param {number} [tmpl.tid] - 分区ID
   * @param {number} [tmpl.copyright] - 版权声明
   * @param {boolean} [tmpl.is_only_self] - 是否仅自己可见
   * @param {string} [tmpl.cover] - 封面图片路径
   * @param {number} [tmpl.dtime] - 定时发布时间
   * @param {string} [tmpl.after_upload] - 上传后处理配置
   * @returns {Promise<void>}
   */
  static async executeUpload(session, tmpl) {
    let message;
    if (await this.isSessionDeleted(session.id)) {
      message = `[投稿] 会话 ${session.id} 已被删除，跳过执行`;
      console.log(message);
      return {
        error: true,
        message,
      };
    }

    // 渲染模板变量，生成投稿元数据
    const room = { room_url: session.room_url, room_name: session.room_name };
    const vars = this.getTemplateVars(room, session);
    const title = this.renderTemplate(tmpl.title_template, vars);
    const desc = this.renderTemplate(tmpl.desc_template || '', vars);
    const tags = this.renderTemplate(tmpl.tags || '', vars);
    const source = this.renderTemplate(tmpl.source || '{room_url}', vars);

    // 查询会话的录制文件
    let files = [];
    const recs = await pool.query(
      `SELECT DISTINCT ON (file_path) * FROM recording_files
       WHERE session_id = $1 AND status IN ('completed', 'interrupted')
       ORDER BY file_path`,
      [session.id]
    );
    files = recs.rows.map((r) => r.file_path).filter(Boolean);

    // 读取碎片大小阈值
    const thresholdValue = await DataService.getSetting('filtering_threshold', '10');
    const thresholdBytes = (parseInt(thresholdValue, 10) || 10) * 1024 * 1024;

    // 过滤掉小于阈值或不存在的文件
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
      message = `[投稿] 会话 ${session.id} 无有效文件（或均小于碎片阈值${thresholdValue}MB），跳过`;
      console.log(message);
      return {
        error: true,
        message,
      };
    }

    // 计算文件总大小
    const totalSize = files.reduce((sum, f) => {
      try {
        return sum + fs.statSync(f).size;
      } catch {
        return sum;
      }
    }, 0);

    // 创建上传记录
    const record = await pool.query(
      `INSERT INTO upload_records (session_id, template_id, room_url, title, status, file_count, total_size, upload_files)
       VALUES ($1,$2,$3,$4,'uploading',$5,$6,$7) RETURNING id`,
      [session.id, tmpl.id, session.room_url, title, files.length, totalSize, JSON.stringify(files)]
    );
    const recordId = record.rows[0].id;

    // 发送上传开始通知
    notify.uploadStart(session.room_name, tmpl.name, files.length, session.room_url);
    console.log(`[投稿] 会话 ${session.id} → 模板 ${tmpl.id}「${tmpl.name}」已启动`);

    // 后台执行上传，不阻塞 HTTP 响应
    this._runUpload(recordId, session, tmpl, files, title, desc, tags, source).catch((err) => {
      console.error(`[投稿] 会话 ${session.id} 后台上传异常:`, err);
    });

    return {
      error: false,
      message: `[投稿] ${session.id} → 模板 ${tmpl.id}「${tmpl.name}」已开始`,
    };
  }

  /**
   * 后台执行 biliup 上传流程
   */
  static async _runUpload(recordId, session, tmpl, files, title, desc, tags, source) {
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
        recordId,
      });

      // 构建命令字符串用于记录
      const biliupPath = process.env.BILIUP_PATH || 'biliup';
      const cmdParts = [biliupPath, '-u', tmpl.cookies_path, 'upload'];
      if (title) cmdParts.push('--title', title);
      if (desc) cmdParts.push(`--desc=${desc}`);
      if (tags) cmdParts.push('--tag', tags);
      if (source) cmdParts.push('--source', source);
      if (tmpl.tid) cmdParts.push('--tid', String(tmpl.tid));
      if (tmpl.copyright) cmdParts.push('--copyright', String(tmpl.copyright));
      if (tmpl.is_only_self) cmdParts.push('--is-only-self', String(tmpl.is_only_self));
      if (tmpl.cover) cmdParts.push('--cover', tmpl.cover);
      if (tmpl.dtime) cmdParts.push('--dtime', String(tmpl.dtime));
      cmdParts.push(...files);
      const cmdStr = cmdParts.join(' ');

      if (result.success) {
        await pool.query(
          `UPDATE upload_records SET status='success', command=$1, output=$2, bv_id=$3, completed_at=NOW() WHERE id=$4`,
          [cmdStr, result.output, result.bvId, recordId]
        );
        notify.uploadComplete(session.room_name, title, result.bvId, session.room_url);

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
          const finalOutput = result.output + `\n--- 投稿后处理 ---\n${JSON.stringify(postResult)}`;
          await pool.query(`UPDATE upload_records SET output=$1 WHERE id=$2`, [finalOutput, recordId]);
        }
      } else {
        await pool.query(
          `UPDATE upload_records SET status='failed', command=$1, output=$2, error_message=$3, completed_at=NOW() WHERE id=$4`,
          [cmdStr, result.output, result.error, recordId]
        );
        await notify.uploadFailed(session.room_name, tmpl.name, title, result.error, session.room_url);
      }

      console.log(`[投稿] biliup 日志: ${result.logPath}`);
    } catch (err) {
      console.error(`[投稿] _runUpload 异常:`, err);
      await pool
        .query(`UPDATE upload_records SET status='failed', error_message=$1, completed_at=NOW() WHERE id=$2`, [
          err.message,
          recordId,
        ])
        .catch(() => {});
    }
  }

  /**
   * 检查会话是否存在阻塞性的上传记录（正在上传或已成功）
   * @param {string} sessionId - 录制会话ID
   * @returns {Promise<boolean>} 如果存在阻塞记录返回true，否则返回false
   */
  static async hasBlockingUploadRecord(sessionId) {
    const r = await pool.query(
      `SELECT 1 FROM upload_records WHERE session_id = $1 AND status IN ('uploading', 'success') LIMIT 1`,
      [sessionId]
    );
    return r.rows.length > 0;
  }

  /**
   * 会话文件是否均已转码完成（无队列任务、无待转 FLV）
   * @param {string} sessionId - 录制会话ID
   * @returns {Promise<boolean>} 如果转码完成或未启用自动转码返回true，否则返回false
   */
  static async isSessionTranscodeComplete(sessionId) {
    const autoTranscode = await DataService.getSetting('auto_transcode', 'true');
    if (autoTranscode !== 'true') return true;

    if (await transcodeQueue.hasSessionPending(sessionId)) return false;

    // 从recording_files表获取文件路径
    const files = await pool.query(
      `SELECT file_path FROM recording_files
       WHERE session_id = $1 AND status NOT IN ('missing', 'deleted')`,
      [sessionId]
    );
    const paths = files.rows.map((r) => r.file_path).filter(Boolean);

    // 检查所有FLV/TS文件是否都有对应的MP4文件
    for (const fp of paths) {
      if (!/\.(flv|ts)$/i.test(fp)) continue;
      try {
        if (!fs.existsSync(fp)) continue;
        const mp4 = fp.replace(/\.(flv|ts)$/i, '.mp4');
        if (!fs.existsSync(mp4)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * 由看门狗调用：扫描已完成且转码就绪的会话，按直播间模板自动投稿
   * 查询最近7天内完成、未删除、配置了上传模板且没有成功/进行中上传记录的会话
   * 会话行用 rs.* 整行透传给 executeUpload，避免手工挑字段导致模板变量缺失（如 caption）
   * @returns {Promise<void>}
   */
  static async scanPendingAutoUpload() {
    try {
      const { rows } = await pool.query(
        `SELECT rs.*, r.room_name, r.upload_template_id
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

      // 遍历每个符合条件的会话，执行自动上传
      for (const row of rows) {
        if (await this.isUploadSkipped(row.id)) {
          continue;
        }
        if (!(await this.isSessionTranscodeComplete(row.id))) continue;

        const tmplResult = await pool.query('SELECT * FROM upload_templates WHERE id = $1', [row.upload_template_id]);
        if (tmplResult.rows.length === 0) continue;

        const tmpl = tmplResult.rows[0];
        if (!tmpl.cookies_path) continue;
        if (!(await this.checkUploadLimit(row.id))) continue;
        if (await this.hasBlockingUploadRecord(row.id)) continue;

        console.log(`[UploadService][投稿] 会话 ${row.id} 转码已完成，启动自动投稿`);
        await this.executeUpload(row, tmpl);
      }
    } catch (err) {
      console.error('[UploadService][投稿] 扫描失败:', err.message);
    }
  }
}

module.exports = UploadService;
