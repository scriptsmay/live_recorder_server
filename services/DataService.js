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

    // 从 JSONL 文件修正弹幕条数（DB 中的 event_count 可能在服务重启后失准）
    await Promise.all(
      result.rows.map((row) => {
        if (row.danmaku_raw_path && require('fs').existsSync(row.danmaku_raw_path)) {
          return require('fs')
            .promises.readFile(row.danmaku_raw_path, 'utf-8')
            .then((content) => {
              row.danmaku_event_count = content.split('\n').filter(Boolean).length;
            })
            .catch(() => {});
        }
        return Promise.resolve();
      })
    );

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
      pool.query('SELECT * FROM danmaku_capture_records WHERE session_id = $1', [sid]),
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

    // 检查文件是否存在
    const fsModule = require('fs');
    const pathModule = require('path');
    const files = filesRes.rows.map((f) => {
      // danmaku_ass_exists: 从确定性路径检查（sessionDir/danmaku/segments/{segment_index}.ass）
      let danmakuAssExists = false;
      if (session.output_dir && f.segment_index != null) {
        const deterministicPath = pathModule.join(session.output_dir, 'danmaku', 'segments', `${f.segment_index}.ass`);
        danmakuAssExists = fsModule.existsSync(deterministicPath);
      }
      // 兼容旧数据：如果 DB 中仍有 danmaku_ass_path 且文件存在
      if (!danmakuAssExists && f.danmaku_ass_path && fsModule.existsSync(f.danmaku_ass_path)) {
        danmakuAssExists = true;
      }
      return {
        ...f,
        file_exists: f.file_path ? fsModule.existsSync(f.file_path) : false,
        danmaku_ass_exists: danmakuAssExists,
      };
    });

    // 弹幕采集记录：优先从 JSONL 文件计算真实条数（内存计数在服务重启后会丢失）
    const capture = captureRes.rows[0] || null;
    if (capture && capture.raw_path && require('fs').existsSync(capture.raw_path)) {
      try {
        const content = require('fs').readFileSync(capture.raw_path, 'utf-8');
        const lineCount = content.split('\n').filter(Boolean).length;
        capture.event_count = lineCount;
      } catch (_) {}
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

  static async getRecordings(options = {}) {
    const { room_url, thresholdBytes = 0, limit = 50, page } = options;
    const conditions = [];
    const params = [];

    if (thresholdBytes > 0) {
      conditions.push(`rf.file_size >= $${params.length + 1}`);
      params.push(thresholdBytes);
    }
    if (room_url) {
      conditions.push(`rf.room_url = $${params.length + 1}`);
      params.push(room_url);
    }

    let sql = `SELECT rf.*, rm.room_name, rs.started_at as session_started_at, rs.ended_at as session_ended_at
       FROM recording_files rf
       LEFT JOIN rooms rm ON rf.room_url = rm.room_url
       LEFT JOIN recording_sessions rs ON rf.session_id = rs.id`;

    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';

    if (page) {
      const pageSize = parseInt(limit, 10);
      sql += `${where} ORDER BY rf.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(pageSize, (parseInt(page, 10) - 1) * pageSize);
    } else {
      sql += `${where} ORDER BY rf.id DESC LIMIT $${params.length + 1}`;
      params.push(parseInt(limit, 10));
    }

    const result = await pool.query(sql, params);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM recording_files rf${where}`,
      params.slice(0, params.length - (page ? 2 : 1))
    );

    return {
      rows: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
    };
  }

  static async getRecordingFiles(options = {}) {
    const { status } = options;
    const sessionId = options.session_id ?? options.sessionId;
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push(`rf.status = $${params.length + 1}`);
      params.push(status);
    }
    if (sessionId) {
      conditions.push(`rf.session_id = $${params.length + 1}`);
      params.push(parseInt(sessionId, 10));
    }

    let sql = `SELECT rf.*, rs.output_dir as session_output_dir, dbr.status AS burn_status, dbr.output_path AS danmaku_burn_path
      FROM recording_files rf
      LEFT JOIN recording_sessions rs ON rf.session_id = rs.id
      LEFT JOIN danmaku_burn_records dbr ON dbr.recording_file_id = rf.id`;
    if (conditions.length) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    // 默认ID升序
    sql += ' ORDER BY rf.id ASC';

    const result = await pool.query(sql, params);
    return result.rows.map((rec) => {
      // 从确定性路径检查 ASS 文件是否存在，替代旧的 recording_files.danmaku_ass_path
      let danmaku_ass_exists = false;
      if (rec.session_output_dir && rec.segment_index != null) {
        const assPath = require('path').join(rec.session_output_dir, 'danmaku', 'segments', `${rec.segment_index}.ass`);
        danmaku_ass_exists = require('fs').existsSync(assPath);
      }
      return {
        ...rec,
        file_exists: rec.file_path ? require('fs').existsSync(rec.file_path) : false,
        is_danmaku_burned: rec.burn_status === 'completed',
        danmaku_burn_exists: rec.danmaku_burn_path ? require('fs').existsSync(rec.danmaku_burn_path) : false,
        danmaku_ass_exists,
      };
    });
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
