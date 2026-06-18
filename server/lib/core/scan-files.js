const path = require('path');
const fs = require('fs');
const pool = require('../../db/index');
const { isDanmakuBurnFile } = require('../../config/config');

/**
 * 扫描录像文件目录的冷却时间（5分钟）
 */
const SCAN_COOLDOWN_MS = 5 * 60 * 1000;
let lastScanTime = 0;

/**
 * 扫描录像文件目录，将磁盘上的视频文件与数据库中的会话记录进行关联或标记为孤立文件。
 *
 * 目录结构：VIDEO_DOWNLOAD_DIR/[roomId]/[sessionId]/[filename]
 *
 * 该函数会执行以下操作：
 * 1. 检查冷却时间，避免频繁扫描。
 * 2. 遍历指定的视频下载目录，收集所有视频文件路径。
 * 3. 获取数据库中已跟踪的文件、房间信息以及录制会话信息。
 * 4. 对比磁盘文件与数据库记录：
 *    - 跳过已跟踪的文件。
 *    - 跳过正在活跃录制的会话目录中的文件。
 *    - 根据路径中的 roomId/sessionId 直接匹配对应的会话。
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
        if (entry.name === 'hls' || entry.name.startsWith('hls_')) continue;
        walkDir(fp);
        continue;
      }
      if (/\.(mp4|flv|ts|mkv|avi|mov)$/i.test(entry.name) && !isDanmakuBurnFile(entry.name)) diskFiles.add(fp);
    }
  };
  walkDir(VIDEO_DOWNLOAD_DIR);

  // 获取所有房间信息，用于根据 roomId 匹配房间
  const roomsById = new Map();
  try {
    const rooms = await pool.query(`SELECT id, room_url, room_name FROM rooms`);
    for (const row of rooms.rows) {
      roomsById.set(String(row.id), row);
    }
  } catch (_) {}

  // 获取所有录制会话列表，构建 sessionId 到会话的映射
  const sessionsById = new Map();
  try {
    const r = await pool.query(
      `SELECT id, room_url, started_at, ended_at, output_dir 
       FROM recording_sessions WHERE deleted_at IS NULL ORDER BY started_at`
    );
    for (const row of r.rows) {
      sessionsById.set(String(row.id), row);
    }
  } catch (_) {}

  // 获取当前正在录制或暂停状态的会话目录
  const activeDirs = new Set();
  try {
    const sessions = await pool.query(
      `SELECT output_dir FROM recording_sessions 
       WHERE status = 'recording' AND output_dir IS NOT NULL`
    );
    for (const row of sessions.rows) {
      if (row.output_dir) activeDirs.add(row.output_dir);
    }
  } catch (_) {}

  let associated = 0;
  let orphanCount = 0;

  // 遍历磁盘上的所有视频文件，判断其状态并进行相应的数据库更新
  for (const fp of diskFiles) {
    if (trackedSet.has(fp)) continue;

    const fileDir = path.dirname(fp);

    // 检查是否在活跃录制目录中
    if (activeDirs.has(fileDir)) continue;

    // 尝试从路径中解析 roomId 和 sessionId
    // 路径结构: VIDEO_DOWNLOAD_DIR/[roomId]/[sessionId]/[filename]
    const relativePath = path.relative(VIDEO_DOWNLOAD_DIR, fp);
    const parts = relativePath.split(path.sep);

    let matchedSession = null;
    let roomUrl = null;

    // 如果路径符合预期的层级结构
    if (parts.length >= 3) {
      const sessionId = parts[1];

      // 通过 sessionId 直接查找会话
      if (sessionsById.has(sessionId)) {
        matchedSession = sessionsById.get(sessionId);
        roomUrl = matchedSession.room_url;
      }
    }

    const stat = fs.statSync(fp);

    if (matchedSession && roomUrl) {
      // 如果找到匹配的会话，则将文件标记为已完成并关联到会话
      const insertRes = await pool.query(
        `INSERT INTO recording_files (session_id, room_url, file_path, file_name, file_size, status, started_at, ended_at, segment_index, checked_at)
         VALUES ($1, $2, $3, $4, $5, 'completed', $6, NOW(), 0, NOW())
         ON CONFLICT (file_path) DO NOTHING`,
        [matchedSession.id, roomUrl, fp, path.basename(fp), stat.size, matchedSession.started_at]
      );

      if (insertRes.rowCount > 0) {
        // 新插入的记录需要同步更新会话的分段计数和总大小
        await pool.query(
          `UPDATE recording_sessions SET total_segments = total_segments + 1, total_size = total_size + $1 WHERE id = $2`,
          [stat.size, matchedSession.id]
        );
      }

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
