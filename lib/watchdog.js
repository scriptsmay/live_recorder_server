const path = require('path');
const fs = require('fs');
const pool = require('../db/index');
const { scanRecordingFiles } = require('./scan-files');

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
    const STALE_FILE_TIMEOUT_MS = parseInt(await getSetting('watchdog_timeout', '60'), 10) * 1000;
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
          if (latestMtime > 0 && Date.now() - latestMtime > STALE_FILE_TIMEOUT_MS) {
            fileStale = true;
          }
        } else {
          try {
            const stat = fs.statSync(room.output_path);
            if (stat.isFile() && Date.now() - stat.mtimeMs > STALE_FILE_TIMEOUT_MS) {
              fileStale = true;
            }
          } catch (_) {}
        }
      }

      if (!processAlive || fileStale) {
        console.log(
          `[看门狗] 僵死录制: ${room.room_name || room.room_url} (pid=${room.ffmpeg_pid}, 进程=${processAlive}, 文件过时=${fileStale})`
        );

        if (processAlive && room.ffmpeg_pid) {
          try {
            process.kill(room.ffmpeg_pid, 'SIGTERM');
          } catch (_) {}
          setTimeout(() => {
            try {
              process.kill(room.ffmpeg_pid, 'SIGKILL');
            } catch (_) {}
          }, 5000);
        }

        await pool.query(`UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`, [
          room.id,
        ]);
        const redis = require('../db/redis');
        try {
          await redis.del(`room:${room.room_url}`);
        } catch (_) {}

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
    }
  } catch (err) {
    console.error('[看门狗] 检查失败:', err.message);
  }
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
      const files = fs.readdirSync(dir);
      const seen = new Set();
      const uniqueFiles = files.filter((f) => {
        const k = f.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const videoRe = /\.(flv|mp4)$/i;
      for (const f of uniqueFiles) {
        if (!videoRe.test(f)) continue;
        const fp = path.join(dir, f);
        const tracked = await pool.query('SELECT id FROM recording_files WHERE file_path = $1', [fp]);
        if (tracked.rows.length > 0) continue;
        let size = 0;
        try {
          size = fs.statSync(fp).size;
        } catch (_) {}
        if (size < thresholdBytes && size > 0) {
          console.log(
            `[分段追踪] ${room.room_name || room.room_url}: ${f} 碎片(${(size / 1024 / 1024).toFixed(1)}MB < ${thresholdMB}MB)，跳过`
          );
          continue;
        }
        const ins = await pool.query(
          `INSERT INTO recordings (session_id, segment_index, room_url, file_path, file_size, started_at, ended_at, status)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), 'completed')
           ON CONFLICT (file_path) DO NOTHING
           RETURNING id`,
          [room.session_id, segIndex, room.room_url, fp, size]
        );
        if (ins.rows.length === 0) continue;
        await pool.query(
          `INSERT INTO recording_files (session_id, room_url, file_path, file_name, file_size, status, checked_at)
           VALUES ($1, $2, $3, $4, $5, 'completed', NOW())
           ON CONFLICT (file_path) DO NOTHING`,
          [room.session_id, room.room_url, fp, f, size]
        );
        await pool.query(
          `UPDATE recording_sessions SET total_segments = total_segments + 1, total_size = total_size + $1 WHERE id = $2`,
          [size, room.session_id]
        );
        console.log(`[分段追踪] ${room.room_name || room.room_url}: ${f} (${(size / 1024 / 1024).toFixed(1)}MB)`);
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
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (_) {
      return;
    }
    const seen = new Set();
    const uniqueFiles = files.filter((f) => {
      const k = f.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    for (const f of uniqueFiles) {
      if (!/\.(flv|mp4)$/i.test(f)) continue;
      const fp = path.join(dir, f);
      let size;
      try {
        size = fs.statSync(fp).size;
      } catch (_) {
        continue;
      }
      if (size >= thresholdBytes) continue;
      try {
        if (Date.now() - fs.statSync(fp).mtimeMs < 120000) continue;
      } catch (_) {
        continue;
      }

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
        console.log(`[碎片清理] 已删除: ${f} (${(size / 1024).toFixed(0)}KB)`);
      } catch (_) {}
    }
  } catch (err) {
    console.error('[碎片清理] 失败:', err.message);
  }
}

async function runFileScan() {
  try {
    const r = await scanRecordingFiles(true);
    if (r.missing > 0 || r.orphaned > 0) {
      console.log(`[文件扫描] 完成: ${r.missing} 缺失, ${r.orphaned} 孤⽂件`);
    }
  } catch (err) {
    console.error('[文件扫描] 失败:', err.message);
  }
}

async function runWatchdog() {
  let intervalSec = 30;
  try {
    intervalSec = parseInt(await getSetting('watchdog_interval', '30'), 10);
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
