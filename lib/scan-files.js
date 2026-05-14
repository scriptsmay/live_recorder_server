const path = require('path');
const fs = require('fs');
const pool = require('../db/index');

async function scanRecordingFiles() {
  const VIDEO_DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR;
  if (!VIDEO_DOWNLOAD_DIR) return { missing: 0, orphaned: 0 };
  if (!fs.existsSync(VIDEO_DOWNLOAD_DIR)) return { missing: 0, orphaned: 0 };

  const tracked = await pool.query(`SELECT id, file_path, status FROM recording_files WHERE status NOT IN ('missing', 'deleted')`);
  const trackedSet = new Map();
  for (const row of tracked.rows) trackedSet.set(row.file_path, row);

  const diskFiles = new Set();
  const walkDir = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) { walkDir(fp); continue; }
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

  let orphanCount = 0;
  for (const fp of diskFiles) {
    if (!trackedSet.has(fp)) {
      const stat = fs.statSync(fp);
      await pool.query(
        `INSERT INTO recording_files (file_path, file_name, file_size, status, checked_at)
         VALUES ($1, $2, $3, 'orphaned', NOW())`,
        [fp, path.basename(fp), stat.size]
      );
      orphanCount++;
    }
  }

  return { missing: missingCount, orphaned: orphanCount };
}

module.exports = { scanRecordingFiles };
