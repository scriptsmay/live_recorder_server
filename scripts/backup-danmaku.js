/**
 * 弹幕数据备份 / 迁移脚本
 *
 * 用法：
 *   node scripts/backup-danmaku.js migrate [--dry-run]   # 一次性迁移：复制 JSONL → DANMAKU_ARCHIVE_DIR，更新 DB raw_path
 *   node scripts/backup-danmaku.js backup  [--dry-run]   # 增量备份：同步 JSONL → DANMAKU_ARCHIVE_DIR，不修改 DB
 *
 * 环境变量：
 *   DANMAKU_ARCHIVE_DIR  归档目录，默认 /data/danmaku_archive
 *   VIDEO_DOWNLOAD_DIR   录制文件目录，用于定位原始 JSONL
 */

require('../server/config/env').initEnv();

const fs = require('fs');
const path = require('path');
const pool = require('../server/db');

const ARCHIVE_DIR = process.env.DANMAKU_ARCHIVE_DIR || '/data/danmaku_archive';

const args = process.argv.slice(2);
const mode = args.find((a) => a === 'migrate' || a === 'backup');
const dryRun = args.includes('--dry-run');

if (!mode) {
  console.log('用法:');
  console.log('  node scripts/backup-danmaku.js migrate [--dry-run]   # 一次性迁移（更新 DB）');
  console.log('  node scripts/backup-danmaku.js backup  [--dry-run]   # 增量备份（不修改 DB）');
  process.exit(1);
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

/**
 * 从 raw_path 推导归档目录下的目标路径
 * 新格式：VIDEO_DOWNLOAD_DIR/{sessionId}/danmaku/danmaku.jsonl
 * 旧格式：VIDEO_DOWNLOAD_DIR/{roomId}/{sessionId}/danmaku/danmaku.jsonl
 * 归档：DANMAKU_ARCHIVE_DIR/{sessionId}/danmaku.jsonl
 */
function archiveDestFor(rawPath) {
  const videoDir = process.env.VIDEO_DOWNLOAD_DIR || '/data/video_downloads';
  const rel = path.relative(videoDir, rawPath);
  const parts = rel.split(path.sep);

  // 新格式：sessionId/danmaku/danmaku.jsonl（2 级 + danmaku 子目录）
  if (parts.length >= 2 && parts[parts.length - 2] === 'danmaku') {
    const sessionId = parts.length >= 3 ? parts[1] : parts[0];
    return path.join(ARCHIVE_DIR, sessionId, 'danmaku.jsonl');
  }

  // fallback：保持相对路径
  return path.join(ARCHIVE_DIR, rel);
}

async function copyFile(src, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(src, dest);
}

async function main() {
  log(`模式: ${mode} | 归档目录: ${ARCHIVE_DIR} | dryRun: ${dryRun}`);

  // 查询所有有 raw_path 的弹幕采集记录
  const { rows } = await pool.query(`
    SELECT id, session_id, room_id, raw_path, status
    FROM danmaku_capture_records
    WHERE raw_path IS NOT NULL AND raw_path != ''
    ORDER BY id
  `);

  log(`共 ${rows.length} 条弹幕采集记录`);

  let copied = 0;
  let skipped = 0;
  let missing = 0;
  let updated = 0;
  let errors = 0;

  for (const row of rows) {
    const src = row.raw_path;
    const dest = archiveDestFor(src);

    // 检查源文件是否存在
    try {
      await fs.promises.access(src, fs.constants.R_OK);
    } catch {
      missing++;
      if (dryRun) log(`  [MISSING] #${row.id} ${src}`);
      continue;
    }

    // 检查目标是否已存在且大小一致（增量判断）
    let needCopy = true;
    try {
      const [srcStat, destStat] = await Promise.all([
        fs.promises.stat(src),
        fs.promises.stat(dest),
      ]);
      if (srcStat.size === destStat.size && srcStat.mtimeMs <= destStat.mtimeMs) {
        needCopy = false;
      }
    } catch {
      // 目标不存在，需要复制
    }

    if (!needCopy) {
      skipped++;
      continue;
    }

    if (dryRun) {
      log(`  [COPY] #${row.id} ${src} → ${dest}`);
      copied++;
      if (mode === 'migrate') updated++;
      continue;
    }

    try {
      await copyFile(src, dest);
      copied++;

      if (mode === 'migrate') {
        // 更新 DB 中的 raw_path 指向归档位置
        await pool.query('UPDATE danmaku_capture_records SET raw_path = $1 WHERE id = $2', [dest, row.id]);
        updated++;
        log(`  [MIGRATED] #${row.id} → ${dest}`);
      } else {
        log(`  [BACKED UP] #${row.id} → ${dest}`);
      }
    } catch (err) {
      errors++;
      log(`  [ERROR] #${row.id} ${err.message}`);
    }
  }

  log('---');
  log(`完成: 复制=${copied} 跳过(已存在)=${skipped} 源文件丢失=${missing} 错误=${errors}`);
  if (mode === 'migrate') {
    log(`DB 更新: ${updated} 条记录的 raw_path 已指向归档目录`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[backup-danmaku] 失败:', err.message);
  process.exit(1);
});
