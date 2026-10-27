const fs = require('fs');
const path = require('path');
const pool = require('../db/index');
const redis = require('../db/redis');
const transcodeQueue = require('../lib/core/TranscodeQueue');
const notify = require('../lib/core/notify');
const biliup = require('../lib/core/biliup');
const { afterUpload } = require('../lib/core/backup');
const DataService = require('./DataService');
const SeasonService = require('./SeasonService');

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
   * 解析投稿封面来源：模板勾选 use_room_cover 时优先直播间封面，模板固定封面兜底
   *
   * 两个来源都做 existsSync 检查：路径无效时静默跳过封面继续投稿，
   * 优于把无效路径传给 biliup 导致整个投稿失败。
   * @param {Object} tmpl - 上传模板配置对象
   * @param {boolean} [tmpl.use_room_cover] - 是否优先使用直播间封面
   * @param {string} [tmpl.cover] - 模板固定封面路径
   * @param {string|null} sourceCoverPath - 直播间封面本地路径（直播 = session.cover_path，回放 = record.poster_path）
   * @returns {{cover: string|null, source: 'room'|'template'|'none'}} source 用于预览展示与命令行排查
   */
  static resolveUploadCover(tmpl, sourceCoverPath) {
    if (tmpl.use_room_cover && sourceCoverPath && fs.existsSync(sourceCoverPath)) {
      return { cover: sourceCoverPath, source: 'room' };
    }
    if (tmpl.cover && fs.existsSync(tmpl.cover)) {
      return { cover: tmpl.cover, source: 'template' };
    }
    return { cover: null, source: 'none' };
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
   * 解析秒数设置值，非法/非数字/负数时回退默认值
   * @param {*} raw - settings 表中的原始字符串
   * @param {number} fallback - 解析失败时的回退值
   * @returns {number} 非负整数秒
   */
  static parseDurationSeconds(raw, fallback) {
    if (raw === null || raw === undefined) return fallback;
    const text = String(raw).trim();
    if (text === '') return fallback;
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0) return fallback;
    return Math.floor(value);
  }

  /**
   * 计算自动投稿有效冷静期：max(delay, auto_upload_grace_seconds)
   * 即使 delay 被调小或设为 0，自动投稿也至少等待 auto_upload_grace_seconds（默认 180s）。
   * @returns {Promise<number>} 有效冷静期秒数
   */
  static async getEffectiveGraceSeconds() {
    const [delayRaw, graceRaw] = await Promise.all([
      DataService.getSetting('delay', '60'),
      DataService.getSetting('auto_upload_grace_seconds', '180'),
    ]);
    // delay 非法时回退其自身默认 60；grace 非法时回退 180
    const delay = this.parseDurationSeconds(delayRaw, 60);
    const grace = this.parseDurationSeconds(graceRaw, 180);
    return Math.max(delay, grace);
  }

  /**
   * 自动投稿资格 SQL 片段（scan 与 execute 双查共用）
   * 依赖别名 rs（recording_sessions）、r（rooms），参数 $1 为有效冷静期秒数。
   *
   * 数据库时钟比较：ended_at 为 TIMESTAMP，禁止与 JS Date 直接比较，
   * 统一用 NOW() - INTERVAL '1 second' * $1 在 SQL 侧计算。
   * @returns {string} WHERE 条件片段
   */
  static _autoUploadEligibilitySql() {
    return `rs.status = 'completed'
      AND rs.deleted_at IS NULL
      AND rs.ended_at IS NOT NULL
      AND rs.ended_at < NOW() - INTERVAL '1 second' * $1
      AND rs.ended_at > NOW() - INTERVAL '7 days'
      AND r.deleted_at IS NULL
      AND r.upload_template_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM recording_sessions rs2
        WHERE rs2.room_url = rs.room_url
          AND rs2.status IN ('recording', 'pending')
          AND rs2.deleted_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM rooms r2
        WHERE r2.room_url = rs.room_url
          AND r2.status = 'recording'
          AND r2.deleted_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM upload_records ur
        WHERE ur.session_id = rs.id
          AND ur.status IN ('uploading', 'success')
          AND ur.deleted_at IS NULL
      )`;
  }

  /**
   * 重新校验单个会话当前是否仍具备自动投稿资格
   * 用于 executeUpload({ auto: true }) 在创建 upload_records 前的防竞态二次确认。
   * @param {number|string} sessionId - 录制会话ID
   * @param {number} graceSeconds - 有效冷静期秒数
   * @returns {Promise<boolean>} 仍有资格返回true
   */
  static async isAutoUploadEligible(sessionId, graceSeconds) {
    const { rows } = await pool.query(
      `SELECT rs.id FROM recording_sessions rs
       INNER JOIN rooms r ON r.room_url = rs.room_url
       WHERE rs.id = $2 AND ${this._autoUploadEligibilitySql()}
       LIMIT 1`,
      [graceSeconds, sessionId]
    );
    return rows.length > 0;
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
   * @param {string} [session.cover_path] - 会话封面本地路径（模板勾选 use_room_cover 时优先使用）
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
   * @param {boolean} [tmpl.use_room_cover] - 投稿优先使用直播间封面
   * @param {string} [tmpl.cover] - 固定封面路径（use_room_cover 命中时作兜底）
   * @param {number} [tmpl.dtime] - 定时发布时间
   * @param {string} [tmpl.after_upload] - 上传后处理配置
   * @param {Object} [options] - 可选执行参数
   * @param {boolean} [options.auto] - 是否为自动投稿；true 时在创建投稿记录前重查资格（防续播竞态）
   * @returns {Promise<Object>} 执行结果；自动投稿被并发录制打断时返回 { skipped: true, reason: 'active_session_running' }
   */
  static async executeUpload(session, tmpl, options = {}) {
    const isAuto = options.auto === true;
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
    // v1.12.0：DISTINCT ON 同样只取未删除行（软删行与重建行可能同路径）
    let files = [];
    const recs = await pool.query(
      `SELECT DISTINCT ON (file_path) * FROM recording_files
       WHERE session_id = $1 AND status IN ('completed', 'interrupted') AND deleted_at IS NULL
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

    // 自动投稿：紧邻 INSERT 前以会话最新状态二次确认资格，把扫描后重新开播/续播的竞态窗口压到最小。
    // 手动投稿不传 auto，保持即时执行能力。
    if (isAuto) {
      const graceSeconds = await this.getEffectiveGraceSeconds();
      if (!(await this.isAutoUploadEligible(session.id, graceSeconds))) {
        console.log(
          `[投稿] 会话 ${session.id} 自动投稿资格失效（同房间录制中/待录制或冷静期未满），跳过且不创建投稿记录`
        );
        return { skipped: true, reason: 'active_session_running' };
      }
    }

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
      // 封面解析：勾选 use_room_cover 时优先会话封面，模板固定封面兜底，无效路径静默跳过
      const coverResolution = this.resolveUploadCover(tmpl, session.cover_path);

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
        cover: coverResolution.cover,
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
      if (coverResolution.cover) cmdParts.push('--cover', coverResolution.cover);
      if (tmpl.dtime) cmdParts.push('--dtime', String(tmpl.dtime));
      cmdParts.push(...files);
      const cmdStr = cmdParts.join(' ');

      if (result.success) {
        await pool.query(
          `UPDATE upload_records SET status='success', command=$1, output=$2, bv_id=$3, completed_at=NOW() WHERE id=$4`,
          [cmdStr, result.output, result.bvId, recordId]
        );
        notify.uploadComplete(session.room_name, title, result.bvId, session.room_url);
        // 自动加入合集：内部含延迟与重试，不 await；自带 catch 防未处理拒绝触发进程退出
        SeasonService.scheduleAdd(recordId).catch((err) => console.error('[合集] 触发失败:', err.message));

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
    // v1.12.0：软删投稿记录不构成阻塞
    const r = await pool.query(
      `SELECT 1 FROM upload_records WHERE session_id = $1 AND status IN ('uploading', 'success') AND deleted_at IS NULL LIMIT 1`,
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
    // v1.12.0：软删文件不参与转码就绪判断
    const files = await pool.query(
      `SELECT file_path FROM recording_files
       WHERE session_id = $1 AND status NOT IN ('missing', 'deleted') AND deleted_at IS NULL`,
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
   * 资格条件见 `_autoUploadEligibilitySql()`：最近 7 天内完成、冷静期已过、
   * 同房间无 recording/pending 会话、直播间非 recording、无阻塞投稿记录。
   * 扫描结果仅作为候选，executeUpload({ auto: true }) 会再次校验。
   * 会话行用 rs.* 整行透传给 executeUpload，避免手工挑字段导致模板变量缺失（如 caption）
   * @returns {Promise<void>}
   */
  static async scanPendingAutoUpload() {
    try {
      const graceSeconds = await this.getEffectiveGraceSeconds();
      const { rows } = await pool.query(
        `SELECT rs.*, r.room_name, r.upload_template_id
         FROM recording_sessions rs
         INNER JOIN rooms r ON r.room_url = rs.room_url
         WHERE ${this._autoUploadEligibilitySql()}
         ORDER BY rs.ended_at DESC
         LIMIT 20`,
        [graceSeconds]
      );

      // 遍历每个符合条件的会话，执行自动上传
      for (const row of rows) {
        if (await this.isUploadSkipped(row.id)) {
          continue;
        }
        if (!(await this.isSessionTranscodeComplete(row.id))) continue;

        // v1.12.0：软删模板不触发自动投稿
        const tmplResult = await pool.query('SELECT * FROM upload_templates WHERE id = $1 AND deleted_at IS NULL', [
          row.upload_template_id,
        ]);
        if (tmplResult.rows.length === 0) continue;

        const tmpl = tmplResult.rows[0];
        if (!tmpl.cookies_path) continue;
        if (!(await this.checkUploadLimit(row.id))) continue;
        if (await this.hasBlockingUploadRecord(row.id)) continue;

        console.log(`[UploadService][投稿] 会话 ${row.id} 转码已完成，启动自动投稿`);
        await this.executeUpload(row, tmpl, { auto: true });
      }
    } catch (err) {
      console.error('[UploadService][投稿] 扫描失败:', err.message);
    }
  }
}

module.exports = UploadService;
