const path = require('path');
const fs = require('fs');
const pool = require('../../db/index');
const { scanRecordingFiles } = require('./scan-files');

let watchdogTimer = null;

const STABILITY_MS = 120000; // 文件稳定时间：2分钟内无修改才认为是完成的分段

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
    const STALE_TIMEOUT_MS = parseInt(await getSetting('watchdog_timeout', '60'), 10) * 1000;
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
        const redis = require('../../db/redis');
        try {
          await redis.del(`room:${room.room_url}`);
          await redis.del(`active_task:${room.room_url}`);
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

/**
 * 扫描并处理处于活跃录制状态的房间分段文件。
 *
 * 该函数执行以下主要逻辑：
 * 1. 获取文件大小过滤阈值。
 * 2. 查询数据库中所有状态为“recording”且已配置输出路径的房间及其会话信息。
 * 3. 遍历每个房间的输出目录，识别未被追踪的视频文件（.flv, .mp4）。
 * 4. 对符合条件的文件进行大小校验，跳过小于阈值的碎片文件。
 * 5. 将有效文件记录插入到 recordings 和 recording_files 表中，并更新会话统计信息。
 *
 * @async
 * @returns {Promise<void>} 无返回值，错误会在内部捕获并打印日志。
 */
async function scanActiveSegments() {
  try {
    // 获取文件大小过滤阈值（MB），并转换为字节
    const thresholdMB = await getFilteringThreshold();
    const thresholdBytes = thresholdMB * 1024 * 1024;

    // 查询所有正在录制的房间及其关联的录制会话信息
    // 同时处理刚刚完成的会话（结束时间在5分钟内），确保最后的切片也能被追踪
    const { rows: rooms } = await pool.query(
      `SELECT r.id, r.room_url, r.room_name, r.output_path,
              rs.id AS session_id, rs.total_segments
       FROM rooms r
       JOIN recording_sessions rs ON rs.room_url = r.room_url 
         AND (rs.status = 'recording' OR 
              (rs.status = 'completed' AND rs.ended_at >= NOW() - INTERVAL '5 minutes'))
       WHERE r.output_path != ''`
    );

    // 遍历每个房间，处理其输出目录下的视频文件
    for (const room of rooms) {
      const dir = path.dirname(room.output_path);
      if (!fs.existsSync(dir)) continue;

      // 初始化分段索引，基于会话中已有的分段数量
      let segIndex = room.total_segments || 0;

      // 读取目录文件并去重（忽略大小写差异）
      const files = fs.readdirSync(dir);
      const seen = new Set();
      const uniqueFiles = files.filter((f) => {
        const k = f.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      // 定义视频文件扩展名正则表达式
      const videoRe = /\.(flv|mp4)$/i;

      // 遍历去重后的文件列表，处理每个视频文件
      for (const f of uniqueFiles) {
        if (!videoRe.test(f)) continue;

        const fp = path.join(dir, f);

        // 检查文件是否已被追踪，若已存在则跳过
        const tracked = await pool.query('SELECT id FROM recording_files WHERE file_path = $1', [fp]);
        if (tracked.rows.length > 0) continue;

        // 检查文件 mtime，最近2分钟内有修改说明可能还在写入，跳过
        let stat;
        try {
          stat = fs.statSync(fp);
        } catch (_) {
          continue;
        }
        if (Date.now() - stat.mtimeMs < STABILITY_MS) continue;

        // 如果文件大小大于0但小于阈值，视为碎片文件并跳过
        if (stat.size < thresholdBytes && stat.size > 0) {
          console.log(
            `[分段追踪] ${room.room_name || room.room_url}: ${f} 碎片(${(stat.size / 1024 / 1024).toFixed(1)}MB < ${thresholdMB}MB)，跳过`
          );
          continue;
        }

        // 插入记录到 recordings 表，若冲突则忽略
        const ins = await pool.query(
          `INSERT INTO recordings (session_id, segment_index, room_url, file_path, file_size, started_at, ended_at, status)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), 'completed')
           ON CONFLICT (file_path) DO NOTHING
           RETURNING id`,
          [room.session_id, segIndex, room.room_url, fp, stat.size]
        );

        // 若插入失败（可能因并发导致冲突），则跳过后续处理
        if (ins.rows.length === 0) continue;

        // 插入文件追踪记录到 recording_files 表
        await pool.query(
          `INSERT INTO recording_files (session_id, room_url, file_path, file_name, file_size, status, checked_at)
           VALUES ($1, $2, $3, $4, $5, 'completed', NOW())
           ON CONFLICT (file_path) DO NOTHING`,
          [room.session_id, room.room_url, fp, f, stat.size]
        );

        // 更新会话的分段总数和总大小
        await pool.query(
          `UPDATE recording_sessions SET total_segments = total_segments + 1, total_size = total_size + $1 WHERE id = $2`,
          [stat.size, room.session_id]
        );

        console.log(`[分段追踪] ${room.room_name || room.room_url}: ${f} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);

        // 递增分段索引，用于下一个文件
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
        const s = fs.statSync(fp);
        if (Date.now() - s.mtimeMs < 120000) continue;
        if (Math.abs(s.ctimeMs - s.mtimeMs) < 300000) continue;
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

async function syncMissingFiles() {
  try {
    const { rows: files } = await pool.query(
      `SELECT id, file_path FROM recording_files WHERE status NOT IN ('missing', 'deleted')`
    );
    let count = 0;
    for (const row of files) {
      if (!fs.existsSync(row.file_path)) {
        await pool.query(`UPDATE recording_files SET status = 'missing', checked_at = NOW() WHERE id = $1`, [row.id]);
        count++;
      }
    }
    if (count > 0) console.log(`[文件同步] ${count} 个文件在磁盘上已不存在，标记为 missing`);
  } catch (err) {
    console.error('[文件同步] 失败:', err.message);
  }
}

/**
 * 执行文件扫描任务，检查录制文件的关联状态和孤立状态。
 * 扫描完成后会在控制台输出统计结果，若发生错误则记录错误信息。
 *
 * @returns {Promise<void>} 不返回任何值，仅通过控制台输出结果或错误。
 */
async function runFileScan() {
  try {
    // 执行文件扫描并获取包含关联文件和孤立文件统计的结果对象
    const r = await scanRecordingFiles(true);
    const parts = [];

    // 根据扫描结果构建状态描述片段
    if (r.associated) parts.push(`${r.associated} 关联`);
    if (r.orphaned) parts.push(`${r.orphaned} 孤⽂件`);

    // 如果存在任何统计项，则在控制台输出扫描完成信息
    if (parts.length) console.log(`[文件扫描] 完成: ${parts.join(', ')}`);
  } catch (err) {
    // 捕获并记录扫描过程中发生的错误
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
    await syncMissingFiles();
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

module.exports = {
  start,
  stop,
  runFileScan,
  checkStaleRecordings,
  scanActiveSegments,
  cleanupFragmentFiles,
  syncMissingFiles,
};
