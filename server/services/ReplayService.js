const path = require('path');
const fs = require('fs');
const pool = require('../db/index');
const DataService = require('./DataService');
const { sanitizeFilename } = require('../lib/utils/tool');
const { getReplayWorkDir } = require('../config/config');
const { publishReplayEventFireAndForget } = require('../lib/core/replay/replay-events');

const KUAISHOU_HOST_RE = /(?:^|\.)kuaishou\.com$/i;

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function extractPrincipalId(roomUrl) {
  if (!roomUrl) return null;
  try {
    const parsed = new URL(roomUrl);
    if (!KUAISHOU_HOST_RE.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] === 'u' && parts[1]) return parts[1];
    return parts[0] || null;
  } catch (_) {
    const match = String(roomUrl).match(/live\.kuaishou\.com\/(?:u\/)?([^/?#]+)/i);
    return match?.[1] || null;
  }
}

class ReplayService {
  static extractPrincipalId(roomUrl) {
    return extractPrincipalId(roomUrl);
  }

  static async getPrincipals() {
    // v1.12.0：主播列表只取未软删房间；回放统计同步过滤软删记录
    const rooms = await pool.query(
      `SELECT id, room_url, room_name
       FROM rooms
       WHERE room_url ILIKE '%live.kuaishou.com%' AND deleted_at IS NULL
       ORDER BY id DESC`
    );

    const principals = [];
    for (const room of rooms.rows) {
      const principalId = extractPrincipalId(room.room_url);
      if (!principalId) continue;
      principals.push({
        principal_id: principalId,
        room_id: room.id,
        room_url: room.room_url,
        room_name: room.room_name || principalId,
      });
    }

    if (principals.length === 0) return [];

    const ids = principals.map((p) => p.principal_id);
    const stats = await pool.query(
      `SELECT principal_id,
              COUNT(*)::int AS replay_count,
              MAX(start_time) AS latest_replay_time,
              (ARRAY_AGG(status ORDER BY COALESCE(start_time, created_at) DESC, id DESC))[1] AS latest_status
       FROM replay_records
       WHERE principal_id = ANY($1) AND deleted_at IS NULL
       GROUP BY principal_id`,
      [ids]
    );
    const statsMap = new Map(stats.rows.map((row) => [row.principal_id, row]));
    const nameResult = await pool.query(
      `SELECT principal_id, value
       FROM replay_settings
       WHERE key = 'principal_name' AND principal_id = ANY($1)`,
      [ids]
    );
    const nameMap = new Map(nameResult.rows.map((row) => [row.principal_id, row.value]));

    return principals.map((principal) => ({
      ...principal,
      principal_name: nameMap.get(principal.principal_id) || principal.room_name || principal.principal_id,
      replay_count: statsMap.get(principal.principal_id)?.replay_count || 0,
      latest_replay_time: statsMap.get(principal.principal_id)?.latest_replay_time || null,
      latest_status: statsMap.get(principal.principal_id)?.latest_status || null,
    }));
  }

  static async listRecords(principalId, options = {}) {
    const page = parsePositiveInt(options.page, 1);
    const pageSize = Math.min(parsePositiveInt(options.page_size || options.limit, 20), 100);
    // v1.12.0：列表与计数共用 conditions，均过滤软删行
    const conditions = ['principal_id = $1', 'deleted_at IS NULL'];
    const params = [principalId];

    if (options.status && options.status !== 'all') {
      params.push(options.status);
      conditions.push(`status = $${params.length}`);
    }
    if (options.date_from) {
      params.push(options.date_from);
      conditions.push(`start_time >= $${params.length}`);
    }
    if (options.date_to) {
      params.push(options.date_to);
      conditions.push(`start_time <= $${params.length}`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const dataParams = [...params, pageSize, (page - 1) * pageSize];
    const result = await pool.query(
      `SELECT *
       FROM replay_records
       ${where}
       ORDER BY COALESCE(start_time, created_at) DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      dataParams
    );
    const countResult = await pool.query(`SELECT COUNT(*) FROM replay_records ${where}`, params);

    return {
      rows: result.rows,
      total: parseInt(countResult.rows[0]?.count || '0', 10),
      page,
      page_size: pageSize,
    };
  }

  static async getRecord(id) {
    const result = await pool.query('SELECT * FROM replay_records WHERE id = $1 AND deleted_at IS NULL', [id]);
    return result.rows[0] || null;
  }

  static async getRecordByReplayId(principalId, replayId) {
    const result = await pool.query(
      'SELECT * FROM replay_records WHERE principal_id = $1 AND replay_id = $2 AND deleted_at IS NULL LIMIT 1',
      [principalId, replayId]
    );
    return result.rows[0] || null;
  }

  static async upsertRecord(record) {
    const principalId = record.principal_id;
    if (!principalId) throw new Error('缺少 principal_id');
    const replayId = record.replay_id || '';

    // v1.12.0：ON CONFLICT 谓词必须与部分唯一索引逐字一致（追加 deleted_at IS NULL）——
    // 不一致 PostgreSQL 直接报 42P10；软删行的同键回放改为插入新行
    const result = await pool.query(
      `INSERT INTO replay_records
       (principal_id, principal_name, replay_id, play_url, m3u8_url, poster, video_file_name, status, start_time, duration, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (principal_id, replay_id) WHERE replay_id IS NOT NULL AND replay_id <> '' AND deleted_at IS NULL
       DO UPDATE SET
         principal_name = COALESCE(NULLIF(EXCLUDED.principal_name, ''), replay_records.principal_name),
         play_url = COALESCE(NULLIF(EXCLUDED.play_url, ''), replay_records.play_url),
         m3u8_url = COALESCE(NULLIF(EXCLUDED.m3u8_url, ''), replay_records.m3u8_url),
         poster = COALESCE(NULLIF(EXCLUDED.poster, ''), replay_records.poster),
         video_file_name = COALESCE(NULLIF(EXCLUDED.video_file_name, ''), replay_records.video_file_name),
         start_time = COALESCE(EXCLUDED.start_time, replay_records.start_time),
         duration = COALESCE(NULLIF(EXCLUDED.duration, 0), replay_records.duration),
         updated_at = NOW()
       RETURNING *`,
      [
        principalId,
        record.principal_name || '',
        replayId,
        record.play_url || '',
        record.m3u8_url || '',
        record.poster || '',
        record.video_file_name || '',
        record.status || 'pending',
        record.start_time || null,
        parseInt(record.duration, 10) || 0,
      ]
    );
    return result.rows[0];
  }

  static async syncRecords({ principal_id: principalId, count = 1, dry_run: dryRun = false }) {
    if (!principalId) throw new Error('缺少 principal_id');
    const limit = parsePositiveInt(count, 1);
    if (dryRun) {
      return {
        dry_run: true,
        principal_id: principalId,
        requested_count: limit,
        created: 0,
        updated: 0,
      };
    }
    const { syncReplays } = require('../lib/core/replay/KuaishouReplayClient');
    const result = await syncReplays(principalId, limit);
    return {
      principal_id: principalId,
      requested_count: limit,
      created: result.created,
      updated: result.updated,
    };
  }

  static async updateRecordStatus(id, status, fields = {}) {
    const allowed = {
      m3u8_url: fields.m3u8_url,
      raw_file_path: fields.raw_file_path,
      cut_file_paths: fields.cut_file_paths,
      fixed_file_paths: fields.fixed_file_paths,
      final_file_paths: fields.final_file_paths,
      file_size: fields.file_size,
      bv_id: fields.bv_id,
      uploaded_at: fields.uploaded_at,
      backed_up_at: fields.backed_up_at,
      completed_at: fields.completed_at,
      error_message: fields.error_message,
      duration: fields.duration,
      resolution: fields.resolution,
      poster: fields.poster,
      poster_path: fields.poster_path,
    };
    const sets = ['status = $1', 'updated_at = NOW()'];
    const params = [status];
    for (const [key, value] of Object.entries(allowed)) {
      if (value === undefined) continue;
      params.push(Array.isArray(value) ? JSON.stringify(value) : value);
      sets.push(`${key} = $${params.length}`);
    }
    params.push(id);
    const result = await pool.query(
      `UPDATE replay_records SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    const updated = result.rows[0] || null;
    if (updated && fields.duration !== undefined) {
      publishReplayEventFireAndForget('replay_record_projection_changed', updated, {
        changed_fields: ['duration'],
      });
    }
    return updated;
  }

  static async markRecordsCompleted(ids) {
    const normalizedIds = [
      ...new Set((ids || []).map((id) => parseInt(id, 10)).filter((id) => Number.isFinite(id) && id > 0)),
    ];
    if (normalizedIds.length === 0) {
      return { updated: [], missing_ids: [] };
    }

    const result = await pool.query(
      `UPDATE replay_records
       SET status = 'completed',
           completed_at = COALESCE(completed_at, NOW()),
           error_message = '',
           updated_at = NOW()
       WHERE id = ANY($1::int[])
       RETURNING *`,
      [normalizedIds]
    );

    const updatedIds = new Set(result.rows.map((row) => Number(row.id)));
    return {
      updated: result.rows,
      missing_ids: normalizedIds.filter((id) => !updatedIds.has(id)),
    };
  }

  static async listUploads(principalId, options = {}) {
    const page = parsePositiveInt(options.page, 1);
    const pageSize = Math.min(parsePositiveInt(options.page_size || options.limit, 20), 100);
    // v1.12.0：投稿记录与关联回放记录均过滤软删行
    const result = await pool.query(
      `SELECT rur.*, rr.principal_id, rr.principal_name, rr.replay_id
       FROM replay_upload_records rur
       LEFT JOIN replay_records rr ON rr.id = rur.replay_record_id AND rr.deleted_at IS NULL
       WHERE rr.principal_id = $1 AND rur.deleted_at IS NULL
       ORDER BY rur.id DESC
       LIMIT $2 OFFSET $3`,
      [principalId, pageSize, (page - 1) * pageSize]
    );
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM replay_upload_records rur
       LEFT JOIN replay_records rr ON rr.id = rur.replay_record_id AND rr.deleted_at IS NULL
       WHERE rr.principal_id = $1 AND rur.deleted_at IS NULL`,
      [principalId]
    );
    return {
      rows: result.rows,
      total: parseInt(countResult.rows[0]?.count || '0', 10),
      page,
      page_size: pageSize,
    };
  }

  /**
   * 全表回放投稿记录（跨主播），供独立的「回放投稿」页面使用。
   *
   * 与 listUploads 的区别：listUploads 锁定单个 principalId（回放工具箱上下文），
   * 这里不按主播过滤，额外支持标题 / 状态 / 合集状态筛选与分页。
   */
  static async listAllUploads(options = {}) {
    const page = parsePositiveInt(options.page, 1);
    const pageSize = Math.min(parsePositiveInt(options.page_size || options.limit, 20), 100);
    // v1.12.0：列表与计数共用 conditions，均过滤软删投稿记录
    const conditions = ['rur.deleted_at IS NULL'];
    const params = [];

    if (options.status) {
      conditions.push(`rur.status = $${params.length + 1}`);
      params.push(options.status);
    }
    if (options.season_status) {
      conditions.push(`rur.season_status = $${params.length + 1}`);
      params.push(options.season_status);
    }
    // 标题模糊查询：大小写不敏感的子串匹配，通配符由服务端包裹，入参仍走占位符
    if (options.title) {
      conditions.push(`rur.title ILIKE $${params.length + 1}`);
      params.push(`%${options.title}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      // 合集名取自模板（记录表只有 season_id），供前端手动重试的确认框展示合集真名
      // v1.12.0：模板 JOIN 过滤软删模板
      `SELECT rur.*, rr.principal_id, rr.principal_name, rr.replay_id, ut.season_title, ut.section_id
       FROM replay_upload_records rur
       LEFT JOIN replay_records rr ON rr.id = rur.replay_record_id AND rr.deleted_at IS NULL
       LEFT JOIN upload_templates ut ON ut.id = rur.template_id AND ut.deleted_at IS NULL
       ${where}
       ORDER BY rur.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    const countResult = await pool.query(`SELECT COUNT(*) FROM replay_upload_records rur ${where}`, params);
    return {
      rows: result.rows,
      total: parseInt(countResult.rows[0]?.count || '0', 10),
      page,
      page_size: pageSize,
    };
  }

  static async getSettings(principalId) {
    const defaults = {
      principal_name: '',
      upload_template_id: '',
      auto_upload: await DataService.getSetting('replay_auto_upload', 'false'),
      max_count_per_run: await DataService.getSetting('replay_max_count_per_run', '1'),
    };
    const result = await pool.query('SELECT key, value FROM replay_settings WHERE principal_id = $1', [principalId]);
    const settings = { ...defaults };
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    return settings;
  }

  static async updateSettings(principalId, updates) {
    const allowed = new Set(['principal_name', 'upload_template_id', 'auto_upload', 'max_count_per_run']);
    const entries = Object.entries(updates || {}).filter(([key]) => allowed.has(key));
    const rows = [];
    for (const [key, value] of entries) {
      const result = await pool.query(
        `INSERT INTO replay_settings (key, principal_id, value, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (key, principal_id)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
         RETURNING *`,
        [key, principalId, String(value ?? '')]
      );
      rows.push(result.rows[0]);
    }
    return rows;
  }

  static getRecordWorkDir(record) {
    const recordDir = this.resolveRecordWorkDir(record);
    fs.mkdirSync(recordDir, { recursive: true });
    return recordDir;
  }

  static resolveRecordWorkDir(record) {
    const baseDir = path.resolve(getReplayWorkDir());
    const safePrincipal = sanitizeFilename(String(record.principal_id || 'unknown')) || 'unknown';
    const principalDir = path.join(baseDir, safePrincipal);
    const safeReplay = sanitizeFilename(record.replay_id || String(record.id || 'record')) || String(record.id);
    const recordDir = path.join(principalDir, safeReplay);
    const resolved = path.resolve(recordDir);
    if (!resolved.startsWith(baseDir + path.sep)) throw new Error('非法回放记录目录');
    return resolved;
  }
}

module.exports = ReplayService;
