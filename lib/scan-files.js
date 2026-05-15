const path = require('path');
const fs = require('fs');
const pool = require('../db/index');

const SCAN_COOLDOWN_MS = 5 * 60 * 1000; // 5 分钟
let lastScanTime = 0;

async function scanRecordingFiles(force = false) {
  const now = Date.now();
  if (!force && now - lastScanTime < SCAN_COOLDOWN_MS) {
    return {
      skipped: true,
      nextScanIn: Math.round((SCAN_COOLDOWN_MS - (now - lastScanTime)) / 1000),
    };
  }
  lastScanTime = now;

  const VIDEO_DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR;
  if (!VIDEO_DOWNLOAD_DIR) return { missing: 0, orphaned: 0 };
  if (!fs.existsSync(VIDEO_DOWNLOAD_DIR)) return { missing: 0, orphaned: 0 };

  const tracked = await pool.query(
    `SELECT id, file_path, status FROM recording_files WHERE status NOT IN ('missing', 'deleted')`
  );
  const trackedSet = new Map();
  for (const row of tracked.rows) trackedSet.set(row.file_path, row);

  const diskFiles = new Set();
  const walkDir = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fp);
        continue;
      }
      if (/\.(mp4|flv|ts|mkv|avi|mov)$/i.test(entry.name)) diskFiles.add(fp);
    }
  };
  walkDir(VIDEO_DOWNLOAD_DIR);

  let missingCount = 0;
  for (const [fp, row] of trackedSet) {
    if (!diskFiles.has(fp)) {
      await pool.query(
        `UPDATE recording_files SET status = 'missing', file_size = 0, checked_at = NOW() WHERE id = $1`,
        [row.id]
      );
      missingCount++;
    }
  }

  // 获取当前活跃录制房间的输出目录，这些目录下的文件不应标记为孤文件
  const activeDirs = new Set();
  try {
    const rooms = await pool.query(
      `SELECT output_path FROM rooms WHERE status IN ('recording', 'paused') AND output_path != ''`
    );
    for (const row of rooms.rows) {
      activeDirs.add(path.dirname(row.output_path));
    }
  } catch (_) {}

  let orphanCount = 0;
  for (const fp of diskFiles) {
    if (!trackedSet.has(fp)) {
      // 活跃录制中的文件跳过，后续由 close handler 追踪
      if (activeDirs.has(path.dirname(fp))) continue;

      const stat = fs.statSync(fp);
      await pool.query(
        `INSERT INTO recording_files (file_path, file_name, file_size, status, checked_at)
         VALUES ($1, $2, $3, 'orphaned', NOW())`,
        [fp, path.basename(fp), stat.size]
      );
      orphanCount++;
    }
  }

  return { missing: missingCount, orphaned: orphanCount, skipped: false };
}

module.exports = { scanRecordingFiles };
