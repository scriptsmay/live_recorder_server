/**
 * 一次性修复脚本：重置指定 session 的 segment_start_ms / segment_end_ms，
 * 然后用 ffprobe 按 ID 升序重新累加计算。
 *
 * 用法: node scripts/fix-segment-times.js [session_id]
 * 默认 session_id = 49
 */

const path = require('path');
const env = process.env.NODE_ENV || 'development';
require('../config/env').initEnv({ mode: env });

const pool = require('../db/index');
const { backfillSegmentTimes } = require('../lib/core/watchdog');

async function fix(sessionId) {
  console.log(`\n=== 修复 session ${sessionId} 的分段时间 ===\n`);

  // 1. 查看当前状态
  const before = await pool.query(
    `SELECT id, file_name, segment_start_ms, segment_end_ms, file_path
     FROM recording_files
     WHERE session_id = $1
     ORDER BY id ASC`,
    [sessionId]
  );

  if (before.rows.length === 0) {
    console.log(`session ${sessionId} 没有录制文件，无需修复`);
    process.exit(0);
  }

  console.log(`[修复前] 共 ${before.rows.length} 个分段：`);
  for (const row of before.rows) {
    console.log(
      `  id=${row.id}  ${row.file_name}  start=${row.segment_start_ms}ms  end=${row.segment_end_ms}ms`
    );
  }

  // 2. 重置为 0（让 backfillSegmentTimes 重新计算）
  const resetResult = await pool.query(
    `UPDATE recording_files
     SET segment_start_ms = 0, segment_end_ms = 0
     WHERE session_id = $1`,
    [sessionId]
  );
  console.log(`\n[重置] 已将 ${resetResult.rowCount} 条记录的 segment_start_ms / segment_end_ms 重置为 0`);

  // 3. 调用 backfillSegmentTimes 重新计算
  console.log('\n[重新计算] 使用 ffprobe 按 ID 升序逐个探测文件时长...\n');
  await backfillSegmentTimes(sessionId, pool);

  // 4. 查看修复后状态
  const after = await pool.query(
    `SELECT id, file_name, segment_start_ms, segment_end_ms
     FROM recording_files
     WHERE session_id = $1
     ORDER BY id ASC`,
    [sessionId]
  );

  console.log(`\n[修复后] 共 ${after.rows.length} 个分段：`);
  for (const row of after.rows) {
    const durationSec = ((row.segment_end_ms - row.segment_start_ms) / 1000).toFixed(1);
    console.log(
      `  id=${row.id}  ${row.file_name}  start=${row.segment_start_ms}ms  end=${row.segment_end_ms}ms  (时长 ${durationSec}s)`
    );
  }

  console.log('\n=== 修复完成 ===\n');
}

const sessionId = parseInt(process.argv[2] || '49', 10);
fix(sessionId)
  .catch((err) => {
    console.error('修复失败:', err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
