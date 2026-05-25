const path = require('path');
const pool = require('../db');

async function migrateData() {
  console.log('开始迁移 recordings 数据到 recording_files 表...');

  // 获取 recordings 表的所有数据
  const { rows: recordings } = await pool.query('SELECT * FROM recordings');

  let migratedCount = 0;
  for (const rec of recordings) {
    // 检查 recording_files 表是否已经有该文件
    const { rows: existing } = await pool.query('SELECT id FROM recording_files WHERE file_path = $1', [rec.file_path]);

    if (existing.length === 0) {
      // 如果不存在，插入
      await pool.query(
        `INSERT INTO recording_files (
          session_id, room_url, file_path, file_name, file_size, status,
          started_at, ended_at, segment_index, duration_seconds,
          is_hls_ready, hls_playlist_path, hls_generated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          rec.session_id,
          rec.room_url,
          rec.file_path,
          path.basename(rec.file_path),
          rec.file_size,
          rec.status,
          rec.started_at,
          rec.ended_at,
          rec.segment_index,
          rec.duration_seconds,
          rec.is_hls_ready,
          rec.hls_playlist_path,
          rec.hls_generated_at,
        ]
      );
      migratedCount++;
    } else {
      // 如果存在，更新缺少的字段
      await pool.query(
        `UPDATE recording_files
         SET ended_at = $1, segment_index = $2, duration_seconds = $3
         WHERE file_path = $4`,
        [rec.ended_at, rec.segment_index, rec.duration_seconds, rec.file_path]
      );
    }
  }

  console.log(`迁移完成，共处理 ${recordings.length} 条记录，新增 ${migratedCount} 条`);
  await pool.end();
}

migrateData().catch(console.error);
