const fs = require('fs');
const path = require('path');
const pool = require('../db/index');
const redis = require('../db/redis');

class DataService {
  /** 执行自定义 SQL 查询 */
  static async query(sql, params = []) {
    const result = await pool.query(sql, params);
    return result;
  }

  static async getTemplates() {
    const result = await pool.query('SELECT * FROM upload_templates ORDER BY id');
    return result.rows;
  }

  static async getRooms(options = {}) {
    const { status, page = 1, limit = 50 } = options;
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push(`r.status = $${params.length + 1}`);
      params.push(status);
    }

    let sql = `SELECT r.*, t.name as upload_template_name FROM rooms r LEFT JOIN upload_templates t ON r.upload_template_id = t.id`;
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ` ORDER BY r.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit, 10), (parseInt(page, 10) - 1) * parseInt(limit, 10));

    const result = await pool.query(sql, params);

    const countParams = params.slice(0, params.length - 2);
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM rooms' + (conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''),
      countParams
    );

    const rows = await this._enrichWithLiveStatus(result.rows);

    return {
      rows,
      total: parseInt(countResult.rows[0].count, 10),
    };
  }

  static async getRoomById(id) {
    const result = await pool.query(
      `SELECT r.*, t.name as upload_template_name FROM rooms r LEFT JOIN upload_templates t ON r.upload_template_id = t.id WHERE r.id = $1`,
      [id]
    );
    if (!result.rows[0]) return null;
    const enriched = await this._enrichWithLiveStatus(result.rows);
    return enriched[0];
  }

  static async _enrichWithLiveStatus(rooms) {
    const pollingRooms = rooms.filter((r) => r.polling_enabled);
    if (pollingRooms.length === 0) return rooms;

    const redisKeys = pollingRooms.map((r) => `polling:live_status:${r.id}`);
    let liveStatusMap = {};

    try {
      const values = await Promise.all(redisKeys.map((k) => redis.get(k).catch(() => null)));
      for (let i = 0; i < pollingRooms.length; i++) {
        const raw = values[i];
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            liveStatusMap[pollingRooms[i].id] = parsed;
          } catch (_) {}
        }
      }
    } catch (_) {}

    return rooms.map((r) => {
      const live = liveStatusMap[r.id];
      if (live) {
        return {
          ...r,
          last_live_status: live.isLive,
          last_polled_at: live.lastPolledAt,
        };
      }
      return r;
    });
  }

  static async getRoomByUrl(roomUrl) {
    const result = await pool.query('SELECT * FROM rooms WHERE room_url = $1', [roomUrl]);
    return result.rows[0] || null;
  }

  static async getRoomList() {
    const result = await pool.query('SELECT id, room_url, room_name FROM rooms ORDER BY id DESC');
    return result.rows;
  }

  static async getSettings() {
    const result = await pool.query('SELECT * FROM settings ORDER BY id');
    const map = {};
    for (const row of result.rows) {
      map[row.key] = row.value;
    }
    return { rows: result.rows, map };
  }

  static async getSetting(key, defaultValue = null) {
    try {
      const result = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
      if (result.rows.length) return result.rows[0].value;
    } catch (_) {}
    return defaultValue;
  }

  static async getRoomTotal() {
    const result = await pool.query('SELECT COUNT(*) FROM rooms');
    return parseInt(result.rows[0]?.count || '0', 10);
  }

  static async getDashboardSummary(todayStart) {
    const [sessionStats, uploadStats, orphanedStats] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'completed') AS sessions_today,
           COALESCE(SUM(total_size) FILTER (WHERE status = 'completed'), 0) AS sessions_today_total_size,
           COUNT(*) FILTER (WHERE status = 'interrupted') AS interrupted_today
         FROM recording_sessions
         WHERE ended_at >= $1`,
        [todayStart]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'success') AS uploads_today,
           COUNT(*) FILTER (WHERE status = 'failed') AS uploads_failed_today
         FROM upload_records
         WHERE created_at >= $1`,
        [todayStart]
      ),
      pool.query(`SELECT COUNT(*) AS orphaned_files FROM recording_files WHERE status = 'orphaned'`),
    ]);

    const sessions = sessionStats.rows[0] || {};
    const uploads = uploadStats.rows[0] || {};
    const orphaned = orphanedStats.rows[0] || {};

    return {
      sessions_today: parseInt(sessions.sessions_today || '0', 10),
      sessions_today_total_size: parseInt(sessions.sessions_today_total_size || '0', 10),
      interrupted_today: parseInt(sessions.interrupted_today || '0', 10),
      uploads_today: parseInt(uploads.uploads_today || '0', 10),
      uploads_failed_today: parseInt(uploads.uploads_failed_today || '0', 10),
      orphaned_files: parseInt(orphaned.orphaned_files || '0', 10),
    };
  }

  static async getRecentActivity(limit = 10) {
    const result = await pool.query(
      `SELECT type, title, detail, timestamp, link
       FROM (
         SELECT 'session_completed' AS type,
                COALESCE(rm.room_name, rs.room_url, '未知直播间') || ' 录制完成' AS title,
                COALESCE(rs.total_segments::text, '0') || ' 个分段, ' ||
                  pg_size_pretty(COALESCE(rs.total_size, 0)::bigint) AS detail,
                rs.ended_at AS timestamp,
                '/sessions' AS link
         FROM recording_sessions rs
         LEFT JOIN rooms rm ON rs.room_url = rm.room_url
         WHERE rs.status = 'completed' AND rs.ended_at IS NOT NULL

         UNION ALL

         SELECT 'session_interrupted' AS type,
                COALESCE(rm.room_name, rs.room_url, '未知直播间') || ' 录制中断' AS title,
                COALESCE(rs.total_segments::text, '0') || ' 个分段' AS detail,
                rs.ended_at AS timestamp,
                '/sessions' AS link
         FROM recording_sessions rs
         LEFT JOIN rooms rm ON rs.room_url = rm.room_url
         WHERE rs.status = 'interrupted' AND rs.ended_at IS NOT NULL

         UNION ALL

         SELECT CASE WHEN ur.status = 'success' THEN 'upload_success'
                     ELSE 'upload_failed' END AS type,
                COALESCE(NULLIF(ur.title, ''), '未命名投稿') AS title,
                COALESCE(NULLIF(ur.bv_id, ''), ur.status) AS detail,
                ur.completed_at AS timestamp,
                '/upload-records' AS link
         FROM upload_records ur
         WHERE ur.status IN ('success', 'failed') AND ur.completed_at IS NOT NULL

         UNION ALL

         SELECT CASE WHEN tr.status = 'completed' THEN 'transcode_completed'
                     ELSE 'transcode_failed' END AS type,
                REGEXP_REPLACE(tr.original_path, '^.*/', '') AS title,
                CASE
                  WHEN COALESCE(rf.file_size, 0) > 0 THEN pg_size_pretty(rf.file_size::bigint)
                  WHEN tr.status = 'completed' THEN '转码完成'
                  ELSE '转码失败'
                END AS detail,
                tr.completed_at AS timestamp,
                '/transcode' AS link
         FROM transcode_records tr
         LEFT JOIN recording_files rf ON rf.file_path = tr.original_path
         WHERE tr.status IN ('completed', 'failed') AND tr.completed_at IS NOT NULL
       ) activities
       ORDER BY timestamp DESC
       LIMIT $1`,
      [parseInt(limit, 10) || 10]
    );

    return result.rows;
  }

  static _resolveSegmentAssPath(sessionOutputDir, file) {
    if (file.danmaku_ass_path && fs.existsSync(file.danmaku_ass_path)) {
      return file.danmaku_ass_path;
    }

    if (!sessionOutputDir || file.id == null) return null;

    const paths = [path.join(sessionOutputDir, 'danmaku', 'segments', `${file.id}.ass`)];
    if (file.segment_index != null && file.segment_index !== file.id) {
      paths.push(path.join(sessionOutputDir, 'danmaku', 'segments', `${file.segment_index}.ass`));
    }

    return paths.find((assPath) => fs.existsSync(assPath)) || null;
  }

  static _normalizeFileSegmentTimes(files) {
    let accumulatedMs = 0;

    return files.map((file) => {
      const normalized = { ...file };
      const startMs = Number(normalized.segment_start_ms) || 0;
      const endMs = Number(normalized.segment_end_ms) || 0;
      const durationMs = Number(normalized.duration_seconds || 0) * 1000;

      if (endMs <= startMs && durationMs > 0) {
        normalized.segment_start_ms = accumulatedMs;
        normalized.segment_end_ms = accumulatedMs + Math.round(durationMs);
      }

      const nextEnd = Number(normalized.segment_end_ms) || 0;
      if (nextEnd > accumulatedMs) {
        accumulatedMs = nextEnd;
      }

      return normalized;
    });
  }

  static async getSessions(options = {}) {
    const { room_url, room_id, status, limit = 50, page } = options;
    const conditions = ['s.deleted_at IS NULL'];
    const params = [];

    if (room_url) {
      conditions.push(`s.room_url = $${params.length + 1}`);
      params.push(room_url);
    }
    if (room_id) {
      conditions.push(`rm.id = $${params.length + 1}`);
      params.push(room_id);
    }
    if (status) {
      conditions.push(`s.status = $${params.length + 1}`);
      params.push(status);
    }

    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    // danmaku_capture_records 使用子查询取每个 session 最新的一条，避免一对多 JOIN 导致行扇出
    let sql = `SELECT s.*, rm.id as room_id, rm.room_name, dcr.status as danmaku_status, dcr.event_count as danmaku_event_count, dcr.raw_path as danmaku_raw_path, dcr.ass_path as danmaku_ass_path, dcr.error as danmaku_error, dbr.total as danmaku_burn_total, dbr.completed_count as danmaku_burn_completed, dbr.failed_count as danmaku_burn_failed FROM recording_sessions s LEFT JOIN rooms rm ON s.room_url = rm.room_url LEFT JOIN (SELECT DISTINCT ON (session_id) * FROM danmaku_capture_records ORDER BY session_id, id DESC) dcr ON s.id = dcr.session_id LEFT JOIN (SELECT session_id, COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'completed') as completed_count, COUNT(*) FILTER (WHERE status = 'failed') as failed_count FROM danmaku_burn_records GROUP BY session_id) dbr ON s.id = dbr.session_id${where} ORDER BY s.id DESC`;

    if (page) {
      const pageSize = parseInt(limit, 10);
      sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(pageSize, (parseInt(page, 10) - 1) * pageSize);
    } else {
      sql += ` LIMIT $${params.length + 1}`;
      params.push(parseInt(limit, 10));
    }

    const result = await pool.query(sql, params);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM recording_sessions s LEFT JOIN rooms rm ON s.room_url = rm.room_url ${where}`,
      params.slice(0, params.length - (page ? 2 : 1))
    );

    return {
      rows: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
    };
  }

  static async getSession(sessionId) {
    const result = await pool.query('SELECT * FROM recording_sessions WHERE id = $1', [parseInt(sessionId)]);
    return result.rows[0] || null;
  }

  /**
   * 获取会话详情（含弹幕录制、压制记录、分段文件）
   */
  static async getSessionDetail(sessionId) {
    const sid = parseInt(sessionId, 10);

    const [sessionRes, captureRes, burnRes, filesRes, roomRes] = await Promise.all([
      pool.query('SELECT * FROM recording_sessions WHERE id = $1', [sid]),
      pool.query('SELECT * FROM danmaku_capture_records WHERE session_id = $1 ORDER BY id DESC LIMIT 1', [sid]),
      pool.query(
        'SELECT dbr.*, rf.file_path as video_path FROM danmaku_burn_records dbr LEFT JOIN recording_files rf ON dbr.recording_file_id = rf.id WHERE dbr.session_id = $1 ORDER BY dbr.segment_index',
        [sid]
      ),
      pool.query('SELECT * FROM recording_files WHERE session_id = $1 ORDER BY id ASC', [sid]),
      pool.query(
        'SELECT rm.* FROM recording_sessions s LEFT JOIN rooms rm ON s.room_url = rm.room_url WHERE s.id = $1',
        [sid]
      ),
    ]);

    const session = sessionRes.rows[0] || null;
    if (!session) return null;

    const files = this._normalizeFileSegmentTimes(filesRes.rows).map((f) => {
      const assPath = this._resolveSegmentAssPath(session.output_dir, f);
      return {
        ...f,
        file_exists: f.file_path ? fs.existsSync(f.file_path) : false,
        danmaku_ass_path: assPath || f.danmaku_ass_path,
        danmaku_ass_exists: Boolean(assPath),
      };
    });

    // 弹幕采集记录：优先从 JSONL 文件计算真实条数（内存计数在服务重启后会丢失）
    const capture = captureRes.rows[0] || null;
    if (capture && capture.raw_path && fs.existsSync(capture.raw_path)) {
      try {
        const content = fs.readFileSync(capture.raw_path, 'utf-8');
        const lineCount = content.split('\n').filter(Boolean).length;
        capture.event_count = lineCount;
      } catch (_) {}
    }

    if (capture && capture.status === 'recording' && ['completed', 'interrupted'].includes(session.status)) {
      capture.status = 'completed';
      capture.ended_at = capture.ended_at || session.ended_at;
      pool
        .query(
          `UPDATE danmaku_capture_records
           SET status = 'completed',
               ended_at = COALESCE(ended_at, $1, NOW()),
               event_count = GREATEST(COALESCE(event_count, 0), $2)
           WHERE id = $3 AND status = 'recording'`,
          [session.ended_at, capture.event_count || 0, capture.id]
        )
        .catch(() => {});
    }

    return {
      session,
      room: roomRes.rows[0] || null,
      capture,
      burnRecords: burnRes.rows,
      files,
    };
  }

  static async getUploadRecords(options = {}) {
    const { session_id, status, limit = 50, page } = options;
    const conditions = [];
    const params = [];

    if (session_id) {
      conditions.push(`ur.session_id = $${params.length + 1}`);
      params.push(session_id);
    }
    if (status) {
      conditions.push(`ur.status = $${params.length + 1}`);
      params.push(status);
    }

    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    let sql = `SELECT ur.*, ut.name as template_name FROM upload_records ur LEFT JOIN upload_templates ut ON ur.template_id = ut.id${where} ORDER BY ur.id DESC`;

    if (page) {
      const pageSize = parseInt(limit, 10);
      sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(pageSize, (parseInt(page, 10) - 1) * pageSize);
    } else {
      sql += ` LIMIT $${params.length + 1}`;
      params.push(parseInt(limit, 10));
    }

    const result = await pool.query(sql, params);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM upload_records ur${where}`,
      params.slice(0, params.length - (page ? 2 : 1))
    );

    return {
      rows: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
    };
  }

  // static async getRecordings(options = {}) {
  //   const { room_url, thresholdBytes = 0, limit = 10, page } = options;
  //   const conditions = [];
  //   const params = [];

  //   if (thresholdBytes > 0) {
  //     conditions.push(`rf.file_size >= $${params.length + 1}`);
  //     params.push(thresholdBytes);
  //   }
  //   if (room_url) {
  //     conditions.push(`rf.room_url = $${params.length + 1}`);
  //     params.push(room_url);
  //   }

  //   let sql = `SELECT rf.*, rm.room_name, rs.started_at as session_started_at, rs.ended_at as session_ended_at
  //      FROM recording_files rf
  //      LEFT JOIN rooms rm ON rf.room_url = rm.room_url
  //      LEFT JOIN recording_sessions rs ON rf.session_id = rs.id`;

  //   const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';

  //   if (page) {
  //     const pageSize = parseInt(limit, 10);
  //     sql += `${where} ORDER BY rf.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  //     params.push(pageSize, (parseInt(page, 10) - 1) * pageSize);
  //   } else {
  //     sql += `${where} ORDER BY rf.id DESC LIMIT $${params.length + 1}`;
  //     params.push(parseInt(limit, 10));
  //   }

  //   const result = await pool.query(sql, params);

  //   const countResult = await pool.query(
  //     `SELECT COUNT(*) FROM recording_files rf${where}`,
  //     params.slice(0, params.length - (page ? 2 : 1))
  //   );

  //   return {
  //     rows: result.rows,
  //     total: parseInt(countResult.rows[0].count, 10),
  //   };
  // }

  /**
   * 获取录制文件列表及其相关元数据
   *
   * @param {Object} options - 查询选项对象
   * @param {string} [options.status] - 录制文件状态过滤条件
   * @param {string} [options.room_url] - 房间URL过滤条件
   * @param {number} [options.thresholdBytes=0] - 文件大小阈值（字节），仅返回大于等于该值的文件
   * @param {number|string} [options.limit] - 每页限制条数，若未提供则返回所有记录
   * @param {number|string} [options.page] - 页码，配合limit使用进行分页
   * @param {string} [options.order='desc'] - 排序方式，'asc' 或 'desc'，默认降序
   * @param {number|string} [options.session_id] - 会话ID，兼容 session_id 和 sessionId 两种写法
   * @returns {Promise<Object>} 包含录制文件列表和总数的对象
   * @returns {Array} return.rows - 录制文件记录数组，每条记录额外包含文件存在性检查字段
   * @returns {boolean} return.rows[].file_exists - 主录制文件是否存在
   * @returns {boolean} return.rows[].is_danmaku_burned - 弹幕是否已完成烧录
   * @returns {boolean} return.rows[].danmaku_burn_exists - 烧录后的弹幕文件是否存在
   * @returns {boolean} return.rows[].danmaku_ass_exists - 原始ASS弹幕文件是否存在
   * @returns {number} return.total - 符合条件的总记录数
   */
  static async getRecordingFiles(options = {}) {
    const { status, room_url, thresholdBytes = 0, limit, page, order = 'desc' } = options;
    const sessionId = options.session_id ?? options.sessionId;
    const conditions = [];
    const params = [];

    // 构建动态查询条件
    if (status) {
      conditions.push(`rf.status = $${params.length + 1}`);
      params.push(status);
    }
    if (sessionId) {
      conditions.push(`rf.session_id = $${params.length + 1}`);
      params.push(parseInt(sessionId, 10));
    }

    if (thresholdBytes > 0) {
      conditions.push(`rf.file_size >= $${params.length + 1}`);
      params.push(thresholdBytes);
    }
    if (room_url) {
      conditions.push(`rf.room_url = $${params.length + 1}`);
      params.push(room_url);
    }

    // 基础查询SQL，关联房间、会话和弹幕烧录记录表
    let sql = `SELECT rf.*, rm.room_name,  rs.output_dir as session_output_dir, dbr.status AS burn_status, dbr.output_path AS danmaku_burn_path
        FROM recording_files rf
        LEFT JOIN rooms rm ON rf.room_url = rm.room_url
        LEFT JOIN recording_sessions rs ON rf.session_id = rs.id
        LEFT JOIN danmaku_burn_records dbr ON dbr.recording_file_id = rf.id`;

    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';

    // 记录 WHERE 条件参数数量，后续计数查询需要用到
    const whereParamCount = params.length;

    // 根据是否提供limit参数决定构建分页查询还是全量查询
    if (limit) {
      if (page) {
        const pageSize = parseInt(limit, 10);
        sql += `${where} ORDER BY rf.id ${order.toLowerCase() === 'asc' ? 'ASC' : 'DESC'} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(pageSize, (parseInt(page, 10) - 1) * pageSize);
      } else {
        sql += `${where} ORDER BY rf.id ${order.toLowerCase() === 'asc' ? 'ASC' : 'DESC'} LIMIT $${params.length + 1}`;
        params.push(parseInt(limit, 10));
      }
    } else {
      // 默认ID升序
      sql += `${where} ORDER BY rf.id ${order.toLowerCase() === 'asc' ? 'ASC' : 'DESC'}`;
    }

    const result = await pool.query(sql, params);

    // 计数查询仅使用 WHERE 条件参数，排除分页追加的 LIMIT/OFFSET 参数
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM recording_files rf ${where}`,
      params.slice(0, whereParamCount)
    );

    return {
      rows: result.rows.map((rec) => {
        const assPath = this._resolveSegmentAssPath(rec.session_output_dir, rec);
        return {
          ...rec,
          danmaku_ass_path: assPath || rec.danmaku_ass_path,
          file_exists: rec.file_path ? fs.existsSync(rec.file_path) : false,
          is_danmaku_burned: rec.burn_status === 'completed',
          danmaku_burn_exists: rec.danmaku_burn_path ? fs.existsSync(rec.danmaku_burn_path) : false,
          danmaku_ass_exists: Boolean(assPath),
        };
      }),
      total: parseInt(countResult.rows[0].count, 10),
    };
  }

  static async getTranscodeRecords(options = {}) {
    const { status, limit = 50, page } = options;
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push(`tr.status = $${params.length + 1}`);
      params.push(status);
    }

    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    let sql = `SELECT tr.*, rs.room_url, rm.id AS room_id, rm.room_name
       FROM transcode_records tr
       LEFT JOIN recording_sessions rs ON tr.session_id = rs.id
       LEFT JOIN rooms rm ON rs.room_url = rm.room_url${where} ORDER BY tr.id DESC`;

    if (page) {
      const pageSize = parseInt(limit, 10);
      sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(pageSize, (parseInt(page, 10) - 1) * pageSize);
    } else {
      sql += ` LIMIT $${params.length + 1}`;
      params.push(parseInt(limit, 10));
    }

    const result = await pool.query(sql, params);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM transcode_records tr${where}`,
      params.slice(0, params.length - (page ? 2 : 1))
    );

    return {
      rows: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
    };
  }
}

module.exports = DataService;
