const path = require('path');
const fs = require('fs');
const pool = require('../db/index');

const SCAN_COOLDOWN_MS = 5 * 60 * 1000;
let lastScanTime = 0;

async function scanRecordingFiles(force = false) {
  const now = Date.now();
  if (!force && now - lastScanTime < SCAN_COOLDOWN_MS) {
    return { skipped: true, nextScanIn: Math.round((SCAN_COOLDOWN_MS - (now - lastScanTime)) / 1000) };
  }
  lastScanTime = now;

  const VIDEO_DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR;
  if (!VIDEO_DOWNLOAD_DIR || !fs.existsSync(VIDEO_DOWNLOAD_DIR)) return { missing: 0, orphaned: 0 };

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

  // 预加载所有房间的 output_dir → room_url 映射
  const roomDirs = [];
  try {
    const rooms = await pool.query(`SELECT room_url, output_path FROM rooms WHERE output_path != ''`);
    for (const row of rooms.rows) {
      roomDirs.push({ dir: path.dirname(row.output_path), room_url: row.room_url });
    }
  } catch (_) {}

  // 预加载所有会话的时间区间
  let sessions = [];
  try {
    const r = await pool.query(`SELECT id, room_url, started_at, ended_at FROM recording_sessions ORDER BY started_at`);
    sessions = r.rows;
  } catch (_) {}

  // 跳过活跃录制目录（等待 close handler 追踪）
  const activeDirs = new Set();
  try {
    const rooms = await pool.query(
      `SELECT output_path FROM rooms WHERE status IN ('recording', 'paused') AND output_path != ''`
    );
    for (const row of rooms.rows) activeDirs.add(path.dirname(row.output_path));
  } catch (_) {}

  let associated = 0;
  let orphanCount = 0;

  for (const fp of diskFiles) {
    if (trackedSet.has(fp)) continue;
    if (activeDirs.has(path.dirname(fp))) continue;

    // 尝试根据目录匹配房间
    const match = roomDirs.find((r) => path.dirname(fp) === r.dir);
    if (!match) {
      // 无匹配房间，直接标记为孤文件
      const stat = fs.statSync(fp);
      await pool.query(
        `INSERT INTO recording_files (file_path, file_name, file_size, status, checked_at)
         VALUES ($1, $2, $3, 'orphaned', NOW())`,
        [fp, path.basename(fp), stat.size]
      );
      orphanCount++;
      continue;
    }

    // 尝试自动关联到会话
    const stat = fs.statSync(fp);
    const birthtime = stat.birthtimeMs || stat.ctimeMs;
    const mtime = stat.mtimeMs;
    const roomSessions = sessions.filter((s) => s.room_url === match.room_url);

    let matchedSession = null;
    for (const s of roomSessions) {
      const sessionStart = new Date(s.started_at).getTime();
      const sessionEnd = s.ended_at ? new Date(s.ended_at).getTime() : Infinity;
      // 文件创建时间 >= 会话开始 && 文件修改时间 <= 会话结束（或会话未结束）
      if (birthtime >= sessionStart && mtime <= sessionEnd) {
        matchedSession = s;
        break;
      }
    }

    if (matchedSession) {
      await pool.query(
        `INSERT INTO recording_files (session_id, room_url, file_path, file_name, file_size, status, checked_at)
         VALUES ($1, $2, $3, $4, $5, 'completed', NOW())
         ON CONFLICT (file_path) DO NOTHING`,
        [matchedSession.id, match.room_url, fp, path.basename(fp), stat.size]
      );
      await pool.query(
        `INSERT INTO recordings (session_id, segment_index, room_url, file_path, file_size, started_at, ended_at, status)
         VALUES ($1, 0, $2, $3, $4, $5, NOW(), 'completed')
         ON CONFLICT (file_path) DO NOTHING`,
        [matchedSession.id, match.room_url, fp, stat.size, matchedSession.started_at]
      );
      associated++;
    } else {
      await pool.query(
        `INSERT INTO recording_files (file_path, file_name, file_size, status, checked_at)
         VALUES ($1, $2, $3, 'orphaned', NOW())`,
        [fp, path.basename(fp), stat.size]
      );
      orphanCount++;
    }
  }

  return { associated, orphaned: orphanCount, skipped: false };
}

module.exports = { scanRecordingFiles };
