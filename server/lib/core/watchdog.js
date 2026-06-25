const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { SUPPORTED_EXT_REGEX, SUPPORTED_TRANSCODE_EXT, isDanmakuBurnFile } = require('../../config/config');
const pool = require('../../db/index');
const DataService = require('../../services/DataService');
const UploadService = require('../../services/UploadService');
const { getActiveDownloader } = require('./downloaders/DownloaderFactory');
const { scanRecordingFiles } = require('./scan-files');
const transcodeQueue = require('./TranscodeQueue');
const hlsGenerator = require('./hls-generator');
const recordingManager = require('./RecordingManager');
const danmakuAssGenerator = require('./danmaku/DanmakuAssGenerator');

let watchdogTimer = null;
// 看门狗内 ASS 补生成互斥锁，防止同一 session 被多轮看门狗重入
const _assProcessingSessions = new Set();

// 文件稳定性阈值判断，20秒内无新增
const STABILITY_MS = 20000;
// 修改时间阈值，30秒内无变化
const RECENTLY_ENDED_MS = 30000;

/**
 * 获取文件大小过滤阈值（单位：MB）。
 *
 * @returns {Promise<number>} 返回过滤阈值，默认为10MB
 */
async function getFilteringThreshold() {
  return parseInt(await DataService.getSetting('filtering_threshold', '10'), 10) || 10;
}

/**
 * 检查并处理僵死的录制任务。
 *
 * 该函数执行以下主要逻辑：
 * 1. 从配置中获取看门狗超时阈值（默认60秒）。
 * 2. 查询数据库中所有状态为"recording"的房间及其关联的活跃录制会话。
 * 3. 对每个房间进行双重检测：
 *    - 进程存活检测：通过向ffmpeg进程发送信号0来检查进程是否仍然运行。
 *    - 文件更新检测：根据录制模式（分段或单文件）检查输出文件的最后修改时间是否超过阈值。
 *      * 分段模式：扫描输出目录下所有视频文件（.mp4/.flv/.ts/.part），找到最新修改时间。
 *      * 单文件模式：直接检查输出文件的最后修改时间。
 * 4. 记录检测结果日志（当前仅记录，不执行清理操作）。
 *
 * 注意：实际的清理逻辑已被注释掉，包括终止进程、更新数据库状态、清理Redis缓存等。
 *
 * @returns {Promise<void>} 无返回值，错误会在内部捕获并打印日志
 */
async function checkStaleRecordings() {
  try {
    const STALE_TIMEOUT_MS = parseInt(await DataService.getSetting('watchdog_timeout', '60'), 10) * 1000;
    const { rows: rooms } = await pool.query(
      `SELECT r.id, r.room_url, r.room_name, r.ffmpeg_pid, r.output_path, r.polling_platform, r.segment_duration,
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
        const downloader = getActiveDownloader(room.polling_platform);
        console.log('[看门狗] downloader name:', downloader.name);
        // 这个是真分段
        const isSegmented = (room.segment_duration || 0) > 0;

        if (isSegmented) {
          let latestMtime = 0;
          try {
            const files = fs.readdirSync(outputDir);
            for (const f of files) {
              if (
                !f.endsWith('.mp4') &&
                !f.endsWith('.flv') &&
                !f.endsWith('.ts') &&
                !f.endsWith('.part') &&
                !f.startsWith('.segments_')
              )
                continue;
              if (isDanmakuBurnFile(f)) continue;
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

      console.log(
        `[看门狗] 检测: ${room.room_name || room.room_url} (pid=${room.ffmpeg_pid}, 进程=${processAlive}, 文件过时=${fileStale})`
      );
      // console.log('[看门狗] 但暂时不做任何处理.');

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
 * 扫描并处理处于活跃录制状态的会话分段文件。
 *
 * 该函数执行以下主要逻辑：
 * 1. 获取文件大小过滤阈值。
 * 2. 查询数据库中所有状态为"recording"或最近完成的会话及其关联的房间信息。
 * 3. 遍历每个会话的输出目录（基于 recording_sessions.output_dir），识别未被追踪的视频文件。
 * 4. 对符合条件的文件进行大小校验，跳过小于阈值的碎片文件。
 * 5. 将有效文件记录插入到 recordings 和 recording_files 表中，并更新会话统计信息。
 *
 * @async
 * @returns {Promise<void>} 无返回值，错误会在内部捕获并打印日志。
 */
async function scanActiveSegments() {
  try {
    const thresholdMB = await getFilteringThreshold();
    const thresholdBytes = thresholdMB * 1024 * 1024;

    const { rows: sessions } = await pool.query(
      `SELECT rs.id AS session_id, rs.total_segments, rs.output_dir, rs.ended_at,
              r.id AS room_id, r.room_url, r.room_name, r.output_path
       FROM recording_sessions rs
       JOIN rooms r ON rs.room_url = r.room_url
       WHERE (rs.status = 'recording' OR 
              (rs.status = 'completed' AND rs.ended_at >= NOW() - INTERVAL '5 minutes'))
         AND rs.output_dir IS NOT NULL`
    );

    for (const session of sessions) {
      const dir = session.output_dir;
      if (!fs.existsSync(dir)) continue;

      const isRecentlyEnded = session.ended_at && Date.now() - new Date(session.ended_at).getTime() < 300000;
      const stabilityMs = isRecentlyEnded ? RECENTLY_ENDED_MS : STABILITY_MS;

      let segIndex = session.total_segments || 0;

      const files = fs.readdirSync(dir);
      const seen = new Set();
      const uniqueFiles = files.filter((f) => {
        const k = f.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      const videoRe = SUPPORTED_EXT_REGEX;

      for (const f of uniqueFiles) {
        if (!videoRe.test(f)) continue;
        // 排除弹幕压制产物，避免重复计入会话统计和投稿文件
        if (isDanmakuBurnFile(f)) continue;

        const fp = path.join(dir, f);

        let stat;
        try {
          stat = fs.statSync(fp);
        } catch (_) {
          continue;
        }

        const tracked = await pool.query('SELECT id, file_size FROM recording_files WHERE file_path = $1', [fp]);

        if (tracked.rows.length > 0) {
          const fileId = tracked.rows[0].id;
          const oldSize = tracked.rows[0].file_size || 0;
          const newSize = stat.size;

          // 跳过已被文件管理模块标记为删除中/已删除的文件
          const managedCheck = await pool.query(
            `SELECT status FROM managed_files WHERE file_path = $1 AND status IN ('deleting', 'deleted')`,
            [fp]
          );
          if (managedCheck.rows.length > 0) continue;

          if (newSize !== oldSize) {
            await pool.query(`UPDATE recording_files SET file_size = $1, checked_at = NOW() WHERE id = $2`, [
              newSize,
              fileId,
            ]);

            const sizeDiff = newSize - oldSize;
            if (sizeDiff > 0) {
              await pool.query(`UPDATE recording_sessions SET total_size = total_size + $1 WHERE id = $2`, [
                sizeDiff,
                session.session_id,
              ]);
            }
          }
          continue;
        }

        if (Date.now() - stat.mtimeMs < stabilityMs) continue;

        if (stat.size < thresholdBytes && stat.size > 0) {
          console.log(
            `[分段追踪] ${session.room_name || session.room_url}: ${f} 碎片(${(stat.size / 1024 / 1024).toFixed(1)}MB < ${thresholdMB}MB)，跳过`
          );
          continue;
        }

        // 探测分段时长（秒）
        let durationSec = 0;
        try {
          durationSec = Math.round((await probeSegmentDuration(fp)) / 1000);
        } catch (_) {}

        // 检查文件管理模块是否已标记该文件为删除中/已删除，避免"复活"已删文件
        const managedCheck = await pool.query(
          `SELECT status FROM managed_files WHERE file_path = $1 AND status IN ('deleting', 'deleted')`,
          [fp]
        );
        if (managedCheck.rows.length > 0) continue;

        // segment times 已由 recordSegment() 写入，watchdog 只补充运行时数据
        await pool.query(
          `INSERT INTO recording_files (session_id, room_url, file_path, file_name, file_size, status, started_at, ended_at, segment_index, duration_seconds, checked_at)
           VALUES ($1, $2, $3, $4, $5, 'completed', NOW(), NOW(), $6, $7, NOW())
           ON CONFLICT (file_path) DO UPDATE SET
             duration_seconds = EXCLUDED.duration_seconds,
             file_size = EXCLUDED.file_size,
             status = 'completed',
             ended_at = NOW(),
             checked_at = NOW()`,
          [session.session_id, session.room_url, fp, f, stat.size, segIndex, durationSec]
        );

        await pool.query(
          `UPDATE recording_sessions SET total_segments = total_segments + 1, total_size = total_size + $1 WHERE id = $2`,
          [stat.size, session.session_id]
        );

        console.log(
          `[分段追踪] ${session.room_name || session.room_url}: ${f} (${(stat.size / 1024 / 1024).toFixed(1)}MB, ${durationSec}s)`
        );

        segIndex++;
      }
    }
  } catch (err) {
    console.error('[分段追踪] 失败:', err.message);
  }
}

/**
 * 清理视频下载目录中的碎片文件（基于 recording_sessions.output_dir）。
 *
 * 该函数执行以下主要逻辑：
 * 1. 获取VIDEO_DOWNLOAD_DIR环境变量指定的目录路径。
 * 2. 查询所有已完成或中断的会话，获取其输出目录。
 * 3. 遍历每个会话目录，检查其中的视频文件。
 * 4. 检查每个文件是否符合碎片文件的特征：
 *    - 文件大小小于配置的阈值
 *    - 文件最后修改时间超过2分钟
 *    - 文件创建时间与修改时间差超过5分钟
 * 5. 删除符合条件的碎片文件及其在数据库中的相关记录。
 * 6. 更新录制会话的分段总数和总大小统计信息。
 *
 * @returns {Promise<void>} 无返回值，错误会在内部捕获并打印日志
 */
async function cleanupFragmentFiles() {
  const dir = process.env.VIDEO_DOWNLOAD_DIR;
  if (!dir || !fs.existsSync(dir)) return;
  const thresholdMB = await getFilteringThreshold();
  const thresholdBytes = thresholdMB * 1024 * 1024;

  try {
    const { rows: sessions } = await pool.query(
      `SELECT id AS session_id, output_dir 
       FROM recording_sessions 
       WHERE status IN ('completed', 'interrupted') 
         AND output_dir IS NOT NULL`
    );

    for (const session of sessions) {
      const sessionDir = session.output_dir;
      if (!fs.existsSync(sessionDir)) continue;

      try {
        const entries = fs.readdirSync(sessionDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.segments_') || entry.name.startsWith('.DS_Store')) continue;
          if (!entry.isFile()) continue;

          const fp = path.join(sessionDir, entry.name);

          if (!SUPPORTED_EXT_REGEX.test(path.extname(fp))) continue;
          if (isDanmakuBurnFile(entry.name)) continue;

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

          // 先删磁盘文件，成功后再删 DB 记录（避免 unlink 失败时丢失 DB 追踪）
          try {
            fs.unlinkSync(fp);
            console.log(`[碎片清理] 已删除: ${path.basename(fp)} (${(size / 1024).toFixed(0)}KB)`);
          } catch (unlinkErr) {
            if (unlinkErr.code === 'ENOENT') {
              // 文件已被文件管理模块或其他进程提前删除，降级清理 DB 记录
              console.log(`[碎片清理] 文件已被其他进程删除: ${path.basename(fp)}`);
            } else {
              continue; // unlink 失败则跳过 DB 删除
            }
          }

          // 软删除：标记为 deleted 而非硬 DELETE，与 managed_files 协调
          const rec = await pool.query(
            `UPDATE recording_files SET status = 'deleted', checked_at = NOW()
             WHERE file_path = $1 AND status != 'deleted'
             RETURNING session_id, file_size`,
            [fp]
          );
          if (rec.rows.length > 0) {
            await pool.query(
              `UPDATE recording_sessions SET total_segments = GREATEST(total_segments - 1, 0), total_size = GREATEST(total_size - $1, 0) WHERE id = $2`,
              [rec.rows[0].file_size || 0, rec.rows[0].session_id]
            );
            // 同步更新 managed_files（H3 修复）
            await pool
              .query(
                `UPDATE managed_files
               SET status = 'deleted', exists_on_disk = false, deleted_at = NOW(), updated_at = NOW()
               WHERE file_path = $1 AND status NOT IN ('deleted', 'deleting')`,
                [fp]
              )
              .catch((err) => {
                console.warn(`[碎片清理] 更新 managed_files 失败: ${err.message}`);
              });
          }
        }
      } catch (_) {}
    }
  } catch (err) {
    console.error('[碎片清理] 失败:', err.message);
  }
}

/**
 * 同步数据库中记录的文件状态与磁盘实际文件的存在情况。
 *
 * 该函数执行以下主要逻辑：
 * 1. 查询数据库中所有状态不是'missing'或'deleted'的文件记录。
 * 2. 逐个检查这些文件在磁盘上是否仍然存在。
 * 3. 对于磁盘上不存在的文件，将其状态更新为'missing'。
 * 4. 统计并输出被标记为缺失的文件数量。
 *
 * @returns {Promise<void>} 无返回值，错误会在内部捕获并打印日志
 */
async function syncMissingFiles() {
  try {
    // 跳过已被文件管理模块标记为 deleting/deleted 的文件，避免覆写删除状态
    const { rows: files } = await pool.query(`
      SELECT rf.id, rf.file_path
      FROM recording_files rf
      LEFT JOIN managed_files mf ON mf.file_path = rf.file_path
      WHERE rf.status NOT IN ('missing', 'deleted')
        AND (mf.id IS NULL OR mf.status NOT IN ('deleting', 'deleted'))
    `);
    let count = 0;
    for (const row of files) {
      if (!fs.existsSync(row.file_path)) {
        // TOCTOU 防护：重新检查 managed_files 是否正在被删除（H4 修复）
        const recheck = await pool.query(
          `SELECT status FROM managed_files WHERE file_path = $1 AND status IN ('deleting', 'deleted')`,
          [row.file_path]
        );
        if (recheck.rows.length > 0) continue;

        await pool.query(
          `UPDATE recording_files SET status = 'missing', checked_at = NOW() WHERE id = $1 AND status NOT IN ('deleted', 'missing')`,
          [row.id]
        );
        count++;
      }
    }
    if (count > 0) console.log(`[文件同步] ${count} 个文件在磁盘上已不存在，标记为 missing`);
  } catch (err) {
    console.error('[文件同步] 失败:', err.message);
  }
}

/**
 * 将超时未完成的 interrupted 状态会话标记为 completed。
 *
 * 该函数执行以下主要逻辑：
 * 1. 从配置中获取下播延迟检测时间（默认60秒）。
 * 2. 查询数据库中所有状态为'interrupted'的录制会话。
 * 3. 检查每个会话的 ended_at 时间与当前时间的差值是否超过配置的延迟时间。
 * 4. 对于超时的会话，将其状态从'interrupted'更新为'completed'。
 * 5. 统计并输出被更新的会话数量。
 *
 * @returns {Promise<void>} 无返回值，错误会在内部捕获并打印日志
 */
async function finalizeInterruptedSessions() {
  try {
    const delaySec = parseInt(await DataService.getSetting('delay', '60'), 10);
    const delayMs = delaySec * 1000;

    const { rows: sessions } = await pool.query(
      `SELECT id, room_url, ended_at
       FROM recording_sessions
       WHERE status = 'interrupted' AND ended_at IS NOT NULL`
    );

    let updatedCount = 0;
    const now = Date.now();

    for (const session of sessions) {
      const endedAt = new Date(session.ended_at).getTime();
      const timeDiff = now - endedAt;

      if (timeDiff > delayMs) {
        await pool.query(`UPDATE recording_sessions SET status = 'completed' WHERE id = $1`, [session.id]);
        updatedCount++;
        console.log(
          `[会话完成] (ID=${session.id}): interrupted -> completed (结束于${Math.floor(timeDiff / 1000)}秒前)`
        );
      }
    }

    if (updatedCount > 0) {
      console.log(`[会话完成] 共更新 ${updatedCount} 个会话状态为 completed`);
    }
  } catch (err) {
    console.error('[会话完成] 失败:', err.message);
  }
}

/**
 * 检查已完成的会话中是否有待转码文件
 */
async function checkSessionTranscode() {
  try {
    const autoTranscode = await DataService.getSetting('auto_transcode', 'true');
    if (autoTranscode !== 'true') return;

    // 联合查询 recording_sessions 和 recording_files 表
    // 只处理已完成的录制文件，排除已删除/缺失的文件
    const { rows: files } = await pool.query(
      `SELECT r.id AS session_id, r.room_url, r.ended_at, rf.id AS file_id, rf.file_path
       FROM recording_sessions r
       JOIN recording_files rf ON rf.session_id = r.id
       LEFT JOIN managed_files mf ON mf.file_path = rf.file_path
       WHERE r.status = 'completed' AND r.ended_at IS NOT NULL
         AND rf.status = 'completed'
         AND (mf.status IS NULL OR mf.status NOT IN ('deleting', 'deleted'))`
    );
    for (const file of files) {
      const filePath = file.file_path;
      if (SUPPORTED_TRANSCODE_EXT.test(filePath)) {
        // 生成对应的MP4输出路径
        const mp4Path = filePath.replace(SUPPORTED_TRANSCODE_EXT, '.mp4');
        transcodeQueue
          .enqueue({
            videoPathToTrans: filePath,
            mp4Path: mp4Path,
            sessionId: file.session_id,
          })
          .catch((err) => console.error('[看门狗][转码队列] 入队异常:', err.message));
        console.log(`[看门狗][转码队列] 已添加文件 ${filePath} 到转码队列`);
      }
    }
  } catch (err) {
    console.error('[看门狗][检查待转码会话文件] 失败:', err.message);
  }
}

/**
 * 检查已完成的会话中是否有待生成 HLS 的文件
 */
async function checkSessionHLS() {
  try {
    const autoGenerateHLS = await DataService.getSetting('auto_generate_hls', 'true');
    if (autoGenerateHLS !== 'true') return;
    // console.log('[看门狗][HLS] 开始检查待生成 HLS 的文件');

    const { rows: recordings } = await pool.query(
      `SELECT rf.id, rf.file_path, rf.is_hls_ready, rf.hls_playlist_path
       FROM recording_files rf
       LEFT JOIN managed_files mf ON mf.file_path = rf.file_path
       WHERE rf.status = 'completed' AND rf.file_path IS NOT NULL
         AND (mf.status IS NULL OR mf.status NOT IN ('deleting', 'deleted'))`
    );

    for (const recording of recordings) {
      if (recording.is_hls_ready && recording.hls_playlist_path) {
        if (fs.existsSync(recording.hls_playlist_path)) {
          continue;
        }
      }

      if (!fs.existsSync(recording.file_path)) {
        continue;
      }

      if (!SUPPORTED_EXT_REGEX.test(recording.file_path)) {
        continue;
      }

      const result = await hlsGenerator.generateForRecording(recording.id);
      if (result.success) {
        console.log(`[看门狗][HLS] 已为文件 ${path.basename(recording.file_path)} 生成 HLS`);
      } else {
        console.warn(`[看门狗][HLS] 生成失败 ${path.basename(recording.file_path)}: ${result.error}`);
      }
    }
  } catch (err) {
    console.error('[看门狗][检查待生成HLS会话文件] 失败:', err.message);
  }
}

/**
 * 检查已完成的会话中是否有缺少分段 ASS 字幕的录制文件，并补充生成。
 *
 * 该函数主要处理以下场景：
 * - 看门狗 scanActiveSegments / scanRecordingFiles 补入的视频文件
 *   在正常流程 _handleDanmakuFinish 执行之后才进入 recording_files，
 *   导致其 danmaku_ass_path 为空。
 *
 * 竞态安全策略：
 * 1. 只处理 completed / interrupted 会话，不与录制中的 _handleDanmakuFinish 竞争
 * 2. 进程内 Set 互斥锁，防止同一 session 被多轮看门狗重入
 * 3. 写入前 double-check DB 中 danmaku_ass_path 是否已填充 + 磁盘文件是否已存在
 *
 * @returns {Promise<void>} 无返回值，错误会在内部捕获并打印日志
 */
async function checkSessionAss() {
  try {
    const autoAss = await DataService.getSetting('auto_generate_ass', 'true');
    if (autoAss !== 'true') return;

    // 查询已结束会话的录制文件，后续按磁盘确定性路径过滤缺少 ASS 的分段
    const { rows: files } = await pool.query(
      `SELECT rf.id, rf.file_path, rf.session_id, rf.segment_index,
              rf.segment_start_ms, rf.segment_end_ms, rf.danmaku_ass_path,
              rs.output_dir
       FROM recording_files rf
       JOIN recording_sessions rs ON rf.session_id = rs.id
       LEFT JOIN managed_files mf ON mf.file_path = rf.file_path
       WHERE rs.status IN ('completed', 'interrupted')
         AND rf.status = 'completed'
         AND rf.file_path IS NOT NULL
         AND (mf.status IS NULL OR mf.status NOT IN ('deleting', 'deleted'))`
    );

    if (files.length === 0) return;

    // 按 session 分组
    const sessionMap = new Map();
    for (const file of files) {
      // 跳过正在被本轮看门狗处理的 session（防重入）
      if (_assProcessingSessions.has(file.session_id)) continue;
      if (!file.output_dir) continue;

      const deterministicAss = path.join(file.output_dir, 'danmaku', 'segments', `${file.id}.ass`);
      const indexedAss = path.join(file.output_dir, 'danmaku', 'segments', `${file.segment_index}.ass`);
      const hasAss =
        (file.danmaku_ass_path && fs.existsSync(file.danmaku_ass_path)) ||
        fs.existsSync(deterministicAss) ||
        fs.existsSync(indexedAss);
      if (hasAss) continue;

      if (!sessionMap.has(file.session_id)) {
        sessionMap.set(file.session_id, []);
      }
      sessionMap.get(file.session_id).push(file);
    }

    for (const [sessionId, sessionFiles] of sessionMap) {
      _assProcessingSessions.add(sessionId);
      try {
        const outputDir = sessionFiles[0].output_dir;
        if (!outputDir) continue;

        const danmakuDir = path.join(outputDir, 'danmaku');
        // 优先新路径，兼容旧路径
        const newJsonlPath = path.join(danmakuDir, 'danmaku.jsonl');
        const oldJsonlPath = path.join(outputDir, 'danmaku.jsonl');
        const jsonlPath = fs.existsSync(newJsonlPath) ? newJsonlPath : oldJsonlPath;

        if (!fs.existsSync(jsonlPath)) {
          // 无 danmaku.jsonl，跳过
          continue;
        }

        // 查询所有需要补 ASS 的分段（含本轮未命中文件列表的、之前遗漏的）
        const segments = await pool.query(
          `SELECT id, segment_index, segment_start_ms, segment_end_ms, danmaku_ass_path
           FROM recording_files
           WHERE session_id = $1
             AND status = 'completed'
           ORDER BY id ASC`,
          [sessionId]
        );

        // 过滤掉已被其他流程填充的记录（double-check 竞态保护）
        const pendingSegments = [];
        for (const seg of segments.rows) {
          const recheck = await pool.query(`SELECT danmaku_ass_path FROM recording_files WHERE id = $1`, [seg.id]);
          const existing = recheck.rows[0]?.danmaku_ass_path;
          const deterministicAss = path.join(outputDir, 'danmaku', 'segments', `${seg.id}.ass`);
          const indexedAss = path.join(outputDir, 'danmaku', 'segments', `${seg.segment_index}.ass`);
          if (
            (existing && existing.length > 0 && fs.existsSync(existing)) ||
            fs.existsSync(deterministicAss) ||
            fs.existsSync(indexedAss)
          ) {
            continue;
          }
          pendingSegments.push(seg);
        }

        if (pendingSegments.length === 0) continue;

        const segOutputDir = path.join(danmakuDir, 'segments');
        const segResults = await danmakuAssGenerator.generateSegmentAss({
          jsonlPath,
          outputDir: segOutputDir,
          segments: pendingSegments,
        });

        let updated = 0;
        for (const seg of segResults) {
          // 仅在 DB 仍为空时才更新，避免覆盖其他流程的结果
          const current = await pool.query(`SELECT danmaku_ass_path FROM recording_files WHERE id = $1`, [seg.id]);
          const curPath = current.rows[0]?.danmaku_ass_path;
          if (curPath && curPath.length > 0) continue;

          await pool.query(`UPDATE recording_files SET danmaku_ass_path = $1 WHERE id = $2`, [seg.assPath, seg.id]);
          updated++;
        }

        if (updated > 0) {
          console.log(`[看门狗][ASS] 会话 ${sessionId}: 补充生成 ${updated} 个分段的 ASS 字幕`);
        }
      } catch (err) {
        console.error(`[看门狗][ASS] 会话 ${sessionId} 补生成失败:`, err.message);
      } finally {
        _assProcessingSessions.delete(sessionId);
      }
    }
  } catch (err) {
    console.error('[看门狗][ASS] 检查补生成失败:', err.message);
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
    const r = await scanRecordingFiles(true);
    const parts = [];

    if (r.associated) parts.push(`${r.associated} 关联`);
    if (r.orphaned) parts.push(`${r.orphaned} 孤⽂件`);

    if (parts.length) console.log(`[文件扫描] 完成: ${parts.join(', ')}`);
  } catch (err) {
    console.error('[文件扫描] 失败:', err.message);
  }
}

/**
 * 执行看门狗主循环，定期执行各项维护和检查任务。
 *
 * 该函数按顺序执行以下任务：
 * 1. 获取看门狗执行间隔配置（默认30秒）。
 * 2. 检查僵死的录制任务。
 * 3. 扫描活跃的分段文件。
 * 4. 清理碎片文件。
 * 5. 同步缺失文件状态。
 * 6. 完成超时的中断会话。
 * 7. 补充生成缺失的分段 ASS 字幕。
 * 8. 执行自动转码队列。
 * 9. 执行自动 HLS 生成。
 * 10. 扫描待自动投稿的文件。
 * 11. 设置定时器以指定的间隔再次执行本函数。
 *
 * @returns {Promise<void>} 无返回值，错误会在内部捕获并打印日志
 */
async function runWatchdog() {
  let intervalSec = 30;
  try {
    intervalSec = parseInt(await DataService.getSetting('watchdog_interval', '30'), 10);
    await checkStaleRecordings();
    await scanActiveSegments();
    await cleanupFragmentFiles();
    await syncMissingFiles();
    await finalizeInterruptedSessions();
    await checkSessionAss();
    await checkSessionTranscode();
    await checkSessionHLS();
    await UploadService.scanPendingAutoUpload();
  } catch (err) {
    console.error('[看门狗] 异常:', err.message);
  }
  watchdogTimer = setTimeout(runWatchdog, Math.max(intervalSec, 10) * 1000);
}

/**
 * 启动看门狗服务。
 *
 * 如果已有运行的定时器，先清除它，然后在100毫秒后启动看门狗主循环。
 *
 * @returns {void}
 */
function start() {
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(runWatchdog, 100);
}

/**
 * 停止看门狗服务。
 *
 * 清除当前的定时器并将定时器引用置为null。
 *
 * @returns {void}
 */
function stop() {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

/**
 * 通过 ffprobe 获取分段文件的时长（毫秒）
 *
 * @param {string} filePath - 分段文件路径
 * @returns {Promise<number>} 时长（毫秒）
 */
async function probeSegmentDuration(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath]);
    let output = '';
    proc.stdout.on('data', (d) => (output += d));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${code}`));
      try {
        const data = JSON.parse(output);
        resolve(parseFloat(data.format.duration) * 1000);
      } catch (e) {
        reject(e);
      }
    });
    proc.on('error', reject);
  });
}

/**
 * 补充分段时间（当 RecordingManager tracker 丢失时使用 ffprobe 补充）
 *
 * @param {number} sessionId - 会话 ID
 * @param {object} pool - 数据库连接池
 * @returns {Promise<void>}
 */
async function backfillSegmentTimes(sessionId, pool) {
  try {
    const missing = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM recording_files
       WHERE session_id = $1
         AND (segment_end_ms = 0 OR (segment_index > 1 AND segment_start_ms = 0))`,
      [sessionId]
    );

    if (parseInt(missing.rows[0].cnt, 10) === 0) return;

    const rows = await pool.query(
      `SELECT file_path, segment_index, segment_start_ms, segment_end_ms
       FROM recording_files
       WHERE session_id = $1
       ORDER BY id ASC`,
      [sessionId]
    );

    if (rows.rows.length === 0) return;

    let accumulatedMs = 0;
    let updated = 0;
    for (const row of rows.rows) {
      try {
        if (row.segment_end_ms > row.segment_start_ms) {
          accumulatedMs = Math.max(accumulatedMs, row.segment_end_ms);
          continue;
        }

        const durationMs = Math.round(await probeSegmentDuration(row.file_path));
        const endMs = accumulatedMs + durationMs;
        await pool.query(
          `UPDATE recording_files
           SET segment_start_ms = $1, segment_end_ms = $2
           WHERE file_path = $3`,
          [accumulatedMs, endMs, row.file_path]
        );
        accumulatedMs = endMs;
        updated++;
      } catch (err) {
        console.warn(`[backfillSegmentTimes] 无法获取文件时长 ${row.file_path}: ${err.message}`);
      }
    }
    console.log(`[backfillSegmentTimes] 会话 ${sessionId} 已补充分段时间，共 ${updated} 个分段`);
  } catch (err) {
    console.error(`[backfillSegmentTimes] 会话 ${sessionId} 补充失败:`, err.message);
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
  finalizeInterruptedSessions,
  checkSessionAss,
  backfillSegmentTimes,
};
