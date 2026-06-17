#!/usr/bin/env node

require('../config/env').initEnv();

const { Pool } = require('pg');
const targetPool = require('../db/index');

function parseArgs(argv) {
  const options = {
    dryRun: false,
    limit: null,
    principal: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--limit') options.limit = parseInt(argv[++i], 10) || null;
    else if (arg === '--principal') options.principal = argv[++i] || null;
  }
  return options;
}

function asShanghaiTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const iso = value
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');
    return `${iso}+08:00`;
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) return text;
  return `${text.replace('T', ' ')}+08:00`;
}

function timestampFromEpoch(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const millis = numeric < 10000000000 ? numeric * 1000 : numeric;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
  return `${parts}+08:00`;
}

function mapRecord(row) {
  return {
    principal_id: row.principal_id,
    principal_name: row.principal_name || row.name || '',
    replay_id: row.replay_id || row.external_id || row.id || '',
    play_url: row.play_url || row.url || '',
    m3u8_url: row.m3u8_url || '',
    video_file_name: row.video_file_name || row.filename || '',
    raw_file_path: row.raw_file_path || row.file_path || '',
    final_file_paths: row.final_file_paths || (row.file_path ? JSON.stringify([row.file_path]) : '[]'),
    file_size: parseInt(row.file_size, 10) || 0,
    bv_id: row.bv_id || '',
    status: 'backed_up',
    start_time:
      asShanghaiTimestamp(row.start_time) ||
      timestampFromEpoch(row.start_live_time) ||
      timestampFromEpoch(row.replay_time),
    duration: parseInt(row.duration, 10) || 0,
    uploaded_at: asShanghaiTimestamp(row.upload_time || row.uploaded_at),
    backed_up_at: asShanghaiTimestamp(row.backup_time || row.backed_up_at),
    error_message: row.error_message || '',
    created_at: asShanghaiTimestamp(row.created_at),
  };
}

async function getSourceColumns(sourcePool) {
  const result = await sourcePool.query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'records'`
  );
  return new Map(result.rows.map((row) => [row.column_name, row.data_type]));
}

async function fetchSourceRecords(sourcePool, options) {
  const columns = await getSourceColumns(sourcePool);
  const conditions = [];
  const params = [];
  if (options.principal) {
    params.push(options.principal);
    conditions.push(`principal_id = $${params.length}`);
  }
  let sql = 'SELECT * FROM records';
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
  const orderExpressions = [
    ['start_time', 'timestamp'],
    ['start_live_time', 'epoch'],
    ['replay_time', 'epoch'],
    ['created_at', 'timestamp'],
  ]
    .filter(([column]) => columns.has(column))
    .map(([column, kind]) => {
      if (kind === 'epoch' || ['bigint', 'integer', 'numeric'].includes(columns.get(column))) {
        return `to_timestamp(CASE WHEN ${column} > 10000000000 THEN ${column} / 1000.0 ELSE ${column} END)`;
      }
      return column;
    });
  if (orderExpressions.length) {
    sql += ` ORDER BY COALESCE(${orderExpressions.join(', ')}) DESC NULLS LAST`;
  }
  if (options.limit) {
    params.push(options.limit);
    sql += ` LIMIT $${params.length}`;
  }
  const result = await sourcePool.query(sql, params);
  return result.rows;
}

async function migrateRows(target, rows, options) {
  if (options.dryRun) {
    return { inserted: 0, skipped: 0, dryRun: true };
  }

  const client = await target.connect();
  let inserted = 0;
  let skipped = 0;
  try {
    await client.query('BEGIN');
    for (const row of rows.map(mapRecord)) {
      const result = await client.query(
        `INSERT INTO replay_records
         (principal_id, principal_name, replay_id, play_url, m3u8_url, video_file_name, raw_file_path,
          final_file_paths, file_size, bv_id, status, start_time, duration, uploaded_at, backed_up_at,
          error_message, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,COALESCE($17::timestamp, NOW()),NOW())
         ON CONFLICT (principal_id, replay_id) WHERE replay_id IS NOT NULL AND replay_id <> ''
         DO NOTHING
         RETURNING id`,
        [
          row.principal_id,
          row.principal_name,
          row.replay_id,
          row.play_url,
          row.m3u8_url,
          row.video_file_name,
          row.raw_file_path,
          row.final_file_paths,
          row.file_size,
          row.bv_id,
          row.status,
          row.start_time,
          row.duration,
          row.uploaded_at,
          row.backed_up_at,
          row.error_message,
          row.created_at,
        ]
      );
      if (result.rows.length) inserted++;
      else skipped++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { inserted, skipped, dryRun: false };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceUrl = process.env.WUYAN_REPLAY_DATABASE_URL;
  if (!sourceUrl) {
    throw new Error('缺少 WUYAN_REPLAY_DATABASE_URL');
  }

  const sourcePool = new Pool({ connectionString: sourceUrl });
  try {
    const rows = await fetchSourceRecords(sourcePool, options);
    console.log(`[迁移] 源记录数: ${rows.length}`);
    const result = await migrateRows(targetPool, rows, options);
    console.log(`[迁移] inserted=${result.inserted}, skipped=${result.skipped}, dryRun=${result.dryRun}`);
    rows
      .slice(0, 5)
      .map(mapRecord)
      .forEach((row) => {
        console.log(`[样本] ${row.principal_id}/${row.replay_id} ${row.start_time || '-'} ${row.status}`);
      });
  } finally {
    await sourcePool.end();
    await targetPool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[迁移] 失败:', err.message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  asShanghaiTimestamp,
  mapRecord,
  fetchSourceRecords,
  migrateRows,
};
