/**
 * 开发环境脏数据清理脚本
 *
 * 在重启开发服务器后运行，清理孤儿进程、残留 .part 文件、孤文件记录。
 *
 * 用法: node scripts/cleanup-dev.js
 *
 * 清理内容：
 *   - 杀死残留的 stream-gears 和 ffmpeg 孤儿进程
 *   - dev_downloads/*.part → 重命名为 .flv
 *   - 删除孤文件（orphaned）和缺失文件（missing）的 DB 记录
 *   - 中断所有遗留的 recording 会话
 */

require('dotenv').config({ path: path.join(__dirname, '..', '.env.dev'), quiet: true });
require('dotenv').config({ quiet: true });

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const pool = require('../db/index');

const DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR || path.join(__dirname, '..', 'dev_downloads');

async function cleanup() {
  console.log('[cleanup-dev] 开始清理...');

  // 1. 杀死孤儿进程
  console.log('[cleanup-dev] 杀死孤儿进程...');
  try {
    execSync('pkill -f "ffmpeg -i" 2>/dev/null', { stdio: 'ignore' });
    execSync('pkill -f "stream_gears_wrapper" 2>/dev/null', { stdio: 'ignore' });
  } catch (_) {}

  // 2. 重命名 .part → .flv
  if (fs.existsSync(DOWNLOAD_DIR)) {
    console.log('[cleanup-dev] 重命名 .part 文件...');
    let count = 0;
    for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
      if (f.endsWith('.flv.part')) {
        const src = path.join(DOWNLOAD_DIR, f);
        const dst = path.join(DOWNLOAD_DIR, f.replace(/\.part$/, ''));
        try {
          fs.renameSync(src, dst);
          console.log(`  ${f} → ${path.basename(dst)}`);
          count++;
        } catch (e) {
          console.warn(`  ${f} 重命名失败: ${e.message}`);
        }
      }
    }
    if (count === 0) console.log('  无 .part 文件');
  }

  // 3. 清理 DB
  try {
    const d = await pool.connect();
    await d.query('BEGIN');

    // 3a. 删除孤文件 / 缺失记录
    const orphaned = await d.query("DELETE FROM recording_files WHERE status IN ('orphaned', 'missing') RETURNING id");
    if (orphaned.rowCount > 0) console.log(`[cleanup-dev] 删除 ${orphaned.rowCount} 条孤文件/缺失记录`);

    // 3b. 中断所有 open 的 recording 会话
    const sessions = await d.query(
      `UPDATE recording_sessions SET ended_at = NOW(), status = 'interrupted'
       WHERE status = 'recording' RETURNING id`
    );
    if (sessions.rowCount > 0) console.log(`[cleanup-dev] 中断 ${sessions.rowCount} 条遗留会话`);

    // 3c. 中断所有 open 的 recordings
    const recs = await d.query(
      `UPDATE recordings SET ended_at = NOW(), status = 'interrupted'
       WHERE status = 'recording' RETURNING id`
    );
    if (recs.rowCount > 0) console.log(`[cleanup-dev] 中断 ${recs.rowCount} 条遗留录制`);

    // 3d. 中断所有 open 的 recording_files
    const files = await d.query(
      `UPDATE recording_files SET status = 'interrupted', checked_at = NOW()
       WHERE status = 'recording' RETURNING id`
    );
    if (files.rowCount > 0) console.log(`[cleanup-dev] 中断 ${files.rowCount} 条遗留文件`);

    // 3e. 房间复位
    const rooms = await d.query(
      "UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, output_path = '' WHERE status IN ('recording', 'paused') RETURNING id"
    );
    if (rooms.rowCount > 0) console.log(`[cleanup-dev] 复位 ${rooms.rowCount} 个直播间`);

    await d.query('COMMIT');
    d.release();
  } catch (err) {
    console.error('[cleanup-dev] DB 清理失败:', err.message);
    process.exit(1);
  }

  // 4. 入盘文件扫描（补录遗留文件到 recording_files）
  if (fs.existsSync(DOWNLOAD_DIR)) {
    console.log('[cleanup-dev] 追踪遗留文件...');
    const tracked = (await pool.query('SELECT file_path FROM recording_files')).rows.map((r) => r.file_path);
    let count = 0;
    for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
      if (!/\.(flv|mp4)$/i.test(f)) continue;
      const fp = path.join(DOWNLOAD_DIR, f);
      if (tracked.includes(fp)) continue;
      let size = 0;
      try {
        size = fs.statSync(fp).size;
      } catch (_) {}
      await pool.query(
        "INSERT INTO recording_files (file_path, file_name, file_size, status, checked_at) VALUES ($1, $2, $3, 'completed', NOW())",
        [fp, f, size]
      );
      count++;
    }
    if (count > 0) console.log(`[cleanup-dev] 追踪 ${count} 个遗留文件`);
  }

  console.log('[cleanup-dev] 清理完成');
  process.exit(0);
}

cleanup();
