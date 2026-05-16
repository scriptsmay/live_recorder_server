const path = require('path');
const fs = require('fs');
const pool = require('../db/index');
const FSWorkerPool = require('./fs-worker-pool');

const SCAN_COOLDOWN_MS = 5 * 60 * 1000;
let lastScanTime = 0;
let workerPool = null;

function getWorkerPool() {
  if (!workerPool) {
    workerPool = new FSWorkerPool(2);
  }
  return workerPool;
}

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

  const poolInstance = getWorkerPool();
  const fileEntries = await poolInstance.scan(VIDEO_DOWNLOAD_DIR, {
    filter: '\\.(mp4|flv|ts|mkv|avi|mov)$',
  });
  const diskFiles = new Map();
  for (const entry of fileEntries) {
    diskFiles.set(entry.path, entry);
  }

  const roomDirs = [];
  try {
    const rooms = await pool.query(`SELECT room_url, output_path FROM rooms WHERE output_path != ''`);
    for (const row of rooms.rows) {
      roomDirs.push({ dir: path.dirname(row.output_path), room_url: row.room_url });
    }
  } catch (_) {}

  let sessions = [];
  try {
    const r = await pool.query(`SELECT id, room_url, started_at, ended_at FROM recording_sessions ORDER BY started_at`);
    sessions = r.rows;
  } catch (_) {}

  const activeDirs = new Set();
  try {
    const rooms = await pool.query(
      `SELECT output_path FROM rooms WHERE status IN ('recording', 'paused') AND output_path != ''`
    );
    for (const row of rooms.rows) activeDirs.add(path.dirname(row.output_path));
  } catch (_) {}

  let associated = 0;
  let orphanCount = 0;

  for (const [fp, entry] of diskFiles) {
    if (trackedSet.has(fp)) continue;
    if (activeDirs.has(path.dirname(fp))) continue;

    const match = roomDirs.find((r) => path.dirname(fp) === r.dir);
    if (!match) {
      await pool.query(
        `INSERT INTO recording_files (file_path, file_name, file_size, status, checked_at)
         VALUES ($1, $2, $3, 'orphaned', NOW())`,
        [fp, entry.name, entry.size]
      );
      orphanCount++;
      continue;
    }

    const birthtime = entry.birthtimeMs || entry.ctimeMs;
    const mtime = entry.mtimeMs;
    const roomSessions = sessions.filter((s) => s.room_url === match.room_url);

    let matchedSession = null;
    for (const s of roomSessions) {
      const sessionStart = new Date(s.started_at).getTime();
      const sessionEnd = s.ended_at ? new Date(s.ended_at).getTime() : Infinity;
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
        [matchedSession.id, match.room_url, fp, entry.name, entry.size]
      );
      await pool.query(
        `INSERT INTO recordings (session_id, segment_index, room_url, file_path, file_size, started_at, ended_at, status)
         VALUES ($1, 0, $2, $3, $4, $5, NOW(), 'completed')
         ON CONFLICT (file_path) DO NOTHING`,
        [matchedSession.id, match.room_url, fp, entry.size, matchedSession.started_at]
      );
      associated++;
    } else {
      await pool.query(
        `INSERT INTO recording_files (file_path, file_name, file_size, status, checked_at)
         VALUES ($1, $2, $3, 'orphaned', NOW())`,
        [fp, entry.name, entry.size]
      );
      orphanCount++;
    }
  }

  return { associated, orphaned: orphanCount, skipped: false };
}

module.exports = { scanRecordingFiles };
