const path = require('path');
const fs = require('fs');
const pool = require('../db/index');

const SCAN_COOLDOWN_MS = 5 * 60 * 1000;
let lastScanTime = 0;

/**
 * 扫描录像文件目录，将磁盘上的视频文件与数据库中的会话记录进行关联或标记为孤立文件。
 *
 * 该函数会执行以下操作：
 * 1. 检查冷却时间，避免频繁扫描。
 * 2. 遍历指定的视频下载目录，收集所有视频文件路径。
 * 3. 获取数据库中已跟踪的文件、房间目录映射以及录制会话信息。
 * 4. 对比磁盘文件与数据库记录：
 *    - 跳过已跟踪的文件。
 *    - 跳过正在活跃录制的目录中的文件。
 *    - 尝试根据文件时间和房间URL匹配对应的录制会话。
 *    - 如果匹配成功，将文件标记为 'completed' 并关联到会话和录像记录。
 *    - 如果无法匹配，将文件标记为 'orphaned'。
 *
 * @param {boolean} [force=false] - 是否强制立即扫描，忽略冷却时间限制。
 * @returns {Promise<Object>} 返回扫描结果对象，包含以下属性：
 *   - {boolean} skipped: 是否因冷却时间而跳过扫描。
 *   - {number} [nextScanIn]: 如果跳过，表示下次可扫描前的剩余秒数。
 *   - {number} associated: 本次扫描中新关联到会话的文件数量。
 *   - {number} orphaned: 本次扫描中新标记为孤立的文件数量。
 *   - {number} [missing]: 如果目录不存在，返回缺失文件计数（通常为0）。
 */
async function scanRecordingFiles(force = false) {
  const now = Date.now();
  if (!force && now - lastScanTime < SCAN_COOLDOWN_MS) {
    return { skipped: true, nextScanIn: Math.round((SCAN_COOLDOWN_MS - (now - lastScanTime)) / 1000) };
  }
  lastScanTime = now;

  const VIDEO_DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR;
  if (!VIDEO_DOWNLOAD_DIR || !fs.existsSync(VIDEO_DOWNLOAD_DIR)) return { missing: 0, orphaned: 0 };

  // 从数据库中获取所有非缺失且非删除状态的已跟踪文件，构建文件路径到记录的映射
  const tracked = await pool.query(
    `SELECT id, file_path, status FROM recording_files WHERE status NOT IN ('missing', 'deleted')`
  );
  const trackedSet = new Map();
  for (const row of tracked.rows) trackedSet.set(row.file_path, row);

  // 递归遍历视频下载目录，收集所有符合扩展名要求的视频文件路径
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

  // 获取所有具有输出路径的房间信息，用于后续通过目录路径反查房间URL
  const roomDirs = [];
  try {
    const rooms = await pool.query(`SELECT room_url, output_path FROM rooms WHERE output_path != ''`);
    for (const row of rooms.rows) {
      roomDirs.push({ dir: path.dirname(row.output_path), room_url: row.room_url });
    }
  } catch (_) {}

  // 获取所有录制会话列表，用于根据时间戳匹配视频文件
  let sessions = [];
  try {
    const r = await pool.query(
      `SELECT id, room_url, started_at, ended_at FROM recording_sessions WHERE deleted_at IS NULL ORDER BY started_at`
    );
    sessions = r.rows;
  } catch (_) {}

  // 获取当前正在录制或暂停状态的房间目录，这些目录中的新文件不应被立即处理
  const activeDirs = new Set();
  try {
    const rooms = await pool.query(
      `SELECT output_path FROM rooms WHERE status IN ('recording', 'paused') AND output_path != ''`
    );
    for (const row of rooms.rows) activeDirs.add(path.dirname(row.output_path));
  } catch (_) {}

  let associated = 0;
  let orphanCount = 0;

  // 遍历磁盘上的所有视频文件，判断其状态并进行相应的数据库更新
  for (const fp of diskFiles) {
    if (trackedSet.has(fp)) continue;
    if (activeDirs.has(path.dirname(fp))) continue;

    // 查找文件所在目录对应的房间信息
    const match = roomDirs.find((r) => path.dirname(fp) === r.dir);
    if (!match) {
      // 如果找不到对应的房间目录，则标记为孤立文件
      const stat = fs.statSync(fp);
      await pool.query(
        `INSERT INTO recording_files (file_path, file_name, file_size, status, checked_at)
         VALUES ($1, $2, $3, 'orphaned', NOW())`,
        [fp, path.basename(fp), stat.size]
      );
      orphanCount++;
      continue;
    }

    // 获取文件元数据，并根据创建/修改时间与房间会话时间窗口进行匹配
    const stat = fs.statSync(fp);
    const birthtime = stat.birthtimeMs || stat.ctimeMs;
    const mtime = stat.mtimeMs;
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
      // 如果找到匹配的会话，则将文件标记为已完成并关联到会话和录像记录
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
      // 如果未找到匹配的会话，则标记为孤立文件
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
