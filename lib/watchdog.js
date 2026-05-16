const path = require('path');
const fs = require('fs');
const pool = require('../db/index');
const { scanRecordingFiles } = require('./scan-files');
const { getHeartbeatInfo, clearHeartbeat } = require('./heartbeat-tracker');
const { getWorkerPool } = require('./fs-worker-pool');

let watchdogTimer = null;

async function getSetting(key, def) {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (r.rows.length) return r.rows[0].value;
  } catch (_) {}
  return def;
}

async function getFilteringThreshold() {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key = 'filtering_threshold'");
    if (r.rows.length) return parseInt(r.rows[0].value, 10) || 10;
  } catch (_) {}
  return 10;
}

async function checkStaleRecordings() {
  try {
    const STALE_TIMEOUT_MS = parseInt(await getSetting('watchdog_timeout', '120'), 10) * 1000;
    const { rows: rooms } = await pool.query(
      `SELECT r.id, r.room_url, r.room_name, r.ffmpeg_pid, r.output_path, r.segment_duration,
              rs.id AS session_id
       FROM rooms r
       LEFT JOIN recording_sessions rs ON rs.room_url = r.room_url AND rs.status = 'recording'
       WHERE r.status = 'recording'`
    );

    for (const room of rooms) {
      let processAlive = false;
      if (room.ffmpeg_pid) {
        try {
          process.kill(room.ffmpeg_pid, 0);
          processAlive = true;
        } catch (_) {}
      }

      if (!processAlive) {
        console.log(`[看门狗] 进程僵死: ${room.room_name || room.room_url} (pid=${room.ffmpeg_pid})`);
        await _markStale(room, 'process_dead');
        continue;
      }

      const hb = getHeartbeatInfo(room.room_url);
      let isHeartbeatDead = false;

      if (hb && hb.age > STALE_TIMEOUT_MS) {
        console.log(`[看门狗] 心跳过时: ${room.room_name || room.room_url} (${hb.age}ms > ${STALE_TIMEOUT_MS}ms)`);
        isHeartbeatDead = true;
      }

      if (hb && hb.shouldReconnect) {
        console.log(`[看门狗] stream-gears 重试超限: ${room.room_name || room.room_url} (重试 ${hb.retryDuration}ms)`);
        isHeartbeatDead = true;
      }

      if (hb && hb.age <= STALE_TIMEOUT_MS) {
        continue;
      }

      if (isHeartbeatDead) {
        await _markStale(room, 'heartbeat_timeout');
        continue;
      }

      let fileStale = false;
      if (room.output_path) {
        const outputDir = path.dirname(room.output_path);
        const isSegmented = (room.segment_duration || 0) > 0;

        if (isSegmented) {
          let latestMtime = 0;
          try {
            const files = fs.readdirSync(outputDir);
            for (const f of files) {
              if (!f.endsWith('.mp4') && !f.endsWith('.flv') && !f.endsWith('.part') && !f.startsWith('.segments_'))
                continue;
              const stat = fs.statSync(path.join(outputDir, f));
              if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
            }
          } catch (_) {}
          if (latestMtime > 0 && Date.now() - latestMtime > STALE_TIMEOUT_MS) {
            fileStale = true;
          }
        } else {
          try {
            const stat = fs.statSync(room.output_path);
            if (stat.isFile() && Date.now() - stat.mtimeMs > STALE_TIMEOUT_MS) {
              fileStale = true;
            }
          } catch (_) {}
        }
      }

      if (fileStale) {
        console.log(`[看门狗] 文件过时: ${room.room_name || room.room_url} (pid=${room.ffmpeg_pid}) — mtime fallback`);
        await _markStale(room, 'file_stale');
      }
    }
  } catch (err) {
    console.error('[看门狗] 检查失败:', err.message);
  }
}

async function _markStale(room, reason) {
  console.log(`[看门狗] 标记僵死: ${room.room_name || room.room_url} (原因: ${reason})`);

  if (room.ffmpeg_pid) {
    try {
      process.kill(room.ffmpeg_pid, 'SIGTERM');
    } catch (_) {}
    setTimeout(() => {
      try {
        process.kill(room.ffmpeg_pid, 'SIGKILL');
      } catch (_) {}
    }, 5000);
  }

  await pool.query(`UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`, [room.id]);
  const redis = require('../db/redis');
  try {
    await redis.del(`room:${room.room_url}`);
    await redis.del(`active_task:${room.room_url}`);
  } catch (_) {}

  clearHeartbeat(room.room_url);

  if (room.session_id) {
    let fileSize = 0;
    if (room.output_path) {
      try {
        const stat = fs.statSync(room.output_path);
        fileSize = stat.size;
      } catch (_) {}
    }
    await pool.query(
      `UPDATE recording_sessions SET ended_at = NOW(), status = 'interrupted', total_size = $1 WHERE id = $2`,
      [fileSize, room.session_id]
    );
    await pool.query(
      `UPDATE recording_files SET status = 'interrupted', checked_at = NOW()
       WHERE session_id = $1 AND status = 'recording'`,
      [room.session_id]
    );
  }
  console.log(`[看门狗] 清理完成: ${room.room_name || room.room_url}`);
}

async function scanActiveSegments() {
  try {
    const thresholdMB = await getFilteringThreshold();
    const thresholdBytes = thresholdMB * 1024 * 1024;

    const { rows: rooms } = await pool.query(
      `SELECT r.id, r.room_url, r.room_name, r.output_path,
              rs.id AS session_id, rs.total_segments
       FROM rooms r
       JOIN recording_sessions rs ON rs.room_url = r.room_url AND rs.status = 'recording'
       WHERE r.status = 'recording' AND r.output_path != ''`
    );

    for (const room of rooms) {
      const dir = path.dirname(room.output_path);
      if (!fs.existsSync(dir)) continue;
      let segIndex = room.total_segments || 0;

      const poolInstance = getWorkerPool();
      const fileEntries = await poolInstance.scan(dir, {
        filter: '\\.(flv|mp4)$',
        fallback: true,
      });

      for (const entry of fileEntries) {
        if (!/\.(flv|mp4)$/i.test(entry.name)) continue;
        const tracked = await pool.query('SELECT id FROM recording_files WHERE file_path = $1', [entry.path]);
        if (tracked.rows.length > 0) continue;
        if (entry.size < thresholdBytes && entry.size > 0) {
          console.log(
            `[分段追踪] ${room.room_name || room.room_url}: ${entry.name} 碎片(${(entry.size / 1024 / 1024).toFixed(1)}MB < ${thresholdMB}MB)，跳过`
          );
          continue;
        }
        const ins = await pool.query(
          `INSERT INTO recordings (session_id, segment_index, room_url, file_path, file_size, started_at, ended_at, status)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), 'completed')
           ON CONFLICT (file_path) DO NOTHING
           RETURNING id`,
          [room.session_id, segIndex, room.room_url, entry.path, entry.size]
        );
        if (ins.rows.length === 0) continue;
        await pool.query(
          `INSERT INTO recording_files (session_id, room_url, file_path, file_name, file_size, status, checked_at)
           VALUES ($1, $2, $3, $4, $5, 'completed', NOW())
           ON CONFLICT (file_path) DO NOTHING`,
          [room.session_id, room.room_url, entry.path, entry.name, entry.size]
        );
        await pool.query(
          `UPDATE recording_sessions SET total_segments = total_segments + 1, total_size = total_size + $1 WHERE id = $2`,
          [entry.size, room.session_id]
        );
        console.log(
          `[分段追踪] ${room.room_name || room.room_url}: ${entry.name} (${(entry.size / 1024 / 1024).toFixed(1)}MB)`
        );
        segIndex++;
      }
    }
  } catch (err) {
    console.error('[分段追踪] 失败:', err.message);
  }
}

async function cleanupFragmentFiles() {
  const dir = process.env.VIDEO_DOWNLOAD_DIR;
  if (!dir || !fs.existsSync(dir)) return;
  const thresholdMB = await getFilteringThreshold();
  const thresholdBytes = thresholdMB * 1024 * 1024;

  try {
    const poolInstance = getWorkerPool();
    const fileEntries = await poolInstance.scan(dir, {
      filter: '\\.(flv|mp4)$',
      fallback: true,
    });

    for (const entry of fileEntries) {
      if (entry.size >= thresholdBytes) continue;
      if (Date.now() - entry.mtimeMs < 120000) continue;
      if (Math.abs(entry.ctimeMs - entry.mtimeMs) < 300000) continue;

      const fp = entry.path;
      const rec = await pool.query('DELETE FROM recordings WHERE file_path = $1 RETURNING session_id, file_size', [fp]);
      if (rec.rows.length > 0) {
        await pool.query(
          `UPDATE recording_sessions SET total_segments = GREATEST(total_segments - 1, 0), total_size = GREATEST(total_size - $1, 0) WHERE id = $2`,
          [rec.rows[0].file_size || 0, rec.rows[0].session_id]
        );
      }
      await pool.query('DELETE FROM recording_files WHERE file_path = $1', [fp]);
      try {
        fs.unlinkSync(fp);
        console.log(`[碎片清理] 已删除: ${entry.name} (${(entry.size / 1024).toFixed(0)}KB)`);
      } catch (_) {}
    }
  } catch (err) {
    console.error('[碎片清理] 失败:', err.message);
  }
}

async function runFileScan() {
  try {
    const r = await scanRecordingFiles(true);
    const parts = [];
    if (r.associated) parts.push(`${r.associated} 关联`);
    if (r.orphaned) parts.push(`${r.orphaned} 孤⽂件`);
    if (parts.length) console.log(`[文件扫描] 完成: ${parts.join(', ')}`);
  } catch (err) {
    console.error('[文件扫描] 失败:', err.message);
  }
}

async function checkDiskSpace() {
  const dir = process.env.VIDEO_DOWNLOAD_DIR;
  if (!dir || !fs.existsSync(dir)) return;
  try {
    const { execSync } = require('child_process');
    const output = execSync(`df -k "${dir}" | tail -1`, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 });
    const parts = output.toString().trim().split(/\s+/);
    const availKB = parseInt(parts[3], 10);
    if (isNaN(availKB)) return;
    const availGB = availKB / (1024 * 1024);
    if (availGB < 1) {
      console.error(`[磁盘监控] ⚠️ 剩余空间不足 1GB (${availGB.toFixed(1)}GB)，暂停新录制请求`);
      const redis = require('../db/redis');
      await redis.set('disk:critical', '1', { EX: 300 }).catch(() => {});
    } else if (availGB < 5) {
      console.warn(`[磁盘监控] ⚠️ 剩余空间 ${availGB.toFixed(1)}GB < 5GB`);
      const redis = require('../db/redis');
      await redis.set('disk:warning', '1', { EX: 300 }).catch(() => {});
    } else {
      const redis = require('../db/redis');
      await redis.del('disk:critical').catch(() => {});
      await redis.del('disk:warning').catch(() => {});
    }
  } catch (_) {}
}

async function runWatchdog() {
  let intervalSec = 30;
  try {
    intervalSec = parseInt(await getSetting('watchdog_interval', '30'), 10);
    await checkDiskSpace();
    await checkStaleRecordings();
    await scanActiveSegments();
    await cleanupFragmentFiles();
  } catch (err) {
    console.error('[看门狗] 异常:', err.message);
  }
  watchdogTimer = setTimeout(runWatchdog, Math.max(intervalSec, 10) * 1000);
}

function start() {
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(runWatchdog, 100);
}

function stop() {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

module.exports = { start, stop, runFileScan, checkStaleRecordings, scanActiveSegments, cleanupFragmentFiles };
