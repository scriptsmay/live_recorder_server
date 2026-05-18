const pool = require('../db/index');
const redis = require('../db/redis');

class DataService {
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
    sql += ` ORDER BY r.updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
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
    const result = await pool.query('SELECT room_url, room_name FROM rooms ORDER BY id DESC');
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

  static async getSetting(key) {
    const result = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return result.rows.length ? result.rows[0].value : null;
  }

  static async getSessions(options = {}) {
    const { room_url, status, limit = 50, page } = options;
    const conditions = ['s.deleted_at IS NULL'];
    const params = [];

    if (room_url) {
      conditions.push(`s.room_url = $${params.length + 1}`);
      params.push(room_url);
    }
    if (status) {
      conditions.push(`s.status = $${params.length + 1}`);
      params.push(status);
    }

    let sql = `
      SELECT s.*, rm.room_name
      FROM recording_sessions s
      LEFT JOIN rooms rm ON s.room_url = rm.room_url
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.id DESC
    `;

    if (page) {
      const pageSize = parseInt(options.limit || 20, 10);
      sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(pageSize, (parseInt(page, 10) - 1) * pageSize);
    } else {
      sql += ` LIMIT $${params.length + 1}`;
      params.push(parseInt(limit, 10));
    }

    const result = await pool.query(sql, params);
    return result.rows;
  }

  static async getUploadRecords(options = {}) {
    const { session_id, status, limit = 100 } = options;

    if (session_id || status) {
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
      let sql = 'SELECT * FROM upload_records';
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ` ORDER BY id DESC LIMIT $${params.length + 1}`;
      params.push(parseInt(limit, 10));
      const result = await pool.query(sql, params);
      return result.rows;
    }

    const result = await pool.query(
      `SELECT ur.*, ut.name as template_name
       FROM upload_records ur
       LEFT JOIN upload_templates ut ON ur.template_id = ut.id
       ORDER BY ur.id DESC
       LIMIT $1`,
      [parseInt(limit, 10)]
    );
    return result.rows;
  }

  static async getRecordings(options = {}) {
    const { room_url, thresholdBytes = 0, limit = 200 } = options;
    const conditions = [];
    const params = [];

    if (thresholdBytes > 0) {
      conditions.push(`r.file_size >= $${params.length + 1}`);
      params.push(thresholdBytes);
    }
    if (room_url) {
      conditions.push(`r.room_url = $${params.length + 1}`);
      params.push(room_url);
    }

    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT r.*, rm.room_name, rs.started_at as session_started_at, rs.ended_at as session_ended_at
       FROM recordings r
       LEFT JOIN rooms rm ON r.room_url = rm.room_url
       LEFT JOIN recording_sessions rs ON r.session_id = rs.id
       ${where}
       ORDER BY r.id DESC
       LIMIT $${params.length + 1}`,
      [...params, parseInt(limit, 10)]
    );
    return result.rows;
  }

  static async getRecordingFiles(options = {}) {
    const { status, session_id } = options;
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    }
    if (session_id) {
      conditions.push(`session_id = $${params.length + 1}`);
      params.push(parseInt(session_id));
    }

    let sql = 'SELECT * FROM recording_files';
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY id DESC';

    const result = await pool.query(sql, params);
    return result.rows;
  }
}

module.exports = DataService;
