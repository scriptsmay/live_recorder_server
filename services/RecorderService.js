const path = require('path');
const fs = require('fs');
const dayjs = require('dayjs');
const pool = require('../db/index');
const redis = require('../db/redis');
const { createProcLog } = require('../lib/utils/proc-log');
const { getActiveDownloader } = require('../lib/core/downloaders/DownloaderFactory');
const transcoder = require('../lib/core/transcoder');
const transcodeQueue = require('../lib/core/TranscodeQueue');
const UploadService = require('./UploadService');
const notify = require('../lib/core/notify');

const DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR;
const ROOM_CACHE_TTL = 300;
const ACTIVE_TASK_TTL = 86400;

class RecorderService {
  static redisKey(roomUrl) {
    return `room:${roomUrl}`;
  }

  static activeTaskKey(roomKey) {
    return `active_task:${roomKey}`;
  }

  static async getRoomCache(roomUrl) {
    try {
      const data = await redis.get(this.redisKey(roomUrl));
      if (data) return JSON.parse(data);
    } catch (_) {}
    return null;
  }

  static async setRoomCache(room) {
    try {
      await redis.setEx(this.redisKey(room.room_url), ROOM_CACHE_TTL, JSON.stringify(room));
    } catch (_) {}
  }

  static async delRoomCache(roomUrl) {
    try {
      await redis.del(this.redisKey(roomUrl));
    } catch (_) {}
  }

  static async isActiveTask(roomKey) {
    try {
      const exists = await redis.exists(this.activeTaskKey(roomKey));
      return exists === 1;
    } catch (_) {
      return false;
    }
  }

  static async setActiveTask(roomKey, data) {
    try {
      await redis.setEx(this.activeTaskKey(roomKey), ACTIVE_TASK_TTL, JSON.stringify(data));
    } catch (_) {}
  }

  static async delActiveTask(roomKey) {
    try {
      await redis.del(this.activeTaskKey(roomKey));
    } catch (_) {}
  }

  static sanitizeFilename(name) {
    return name
      .replace(/[\\/:\*\?"<>\|\x00-\x1F\x7F]/g, '')
      .replace(/\s+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  static generateFilename(template, roomName, ext = '.mp4') {
    const now = dayjs();
    const vars = {
      room_name: this.sanitizeFilename(roomName || 'unknown'),
      datetime: now.format('YYYYMMDD_HHmmss'),
      YYYY: now.format('YYYY'),
      MM: now.format('MM'),
      DD: now.format('DD'),
      HH: now.format('HH'),
      mm: now.format('mm'),
      ss: now.format('ss'),
    };
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return this.sanitizeFilename(result) + ext;
  }

  static templateToStrftime(template, roomName, ext = '.mp4') {
    const roomNameSafe = this.sanitizeFilename(roomName || 'unknown').replace(/%/g, '%%');
    return (
      template
        .replace(/{room_name}/g, roomNameSafe)
        .replace(/{datetime}/g, '%Y%m%d_%H%M%S')
        .replace(/{YYYY}/g, '%Y')
        .replace(/{MM}/g, '%m')
        .replace(/{DD}/g, '%d')
        .replace(/{HH}/g, '%H')
        .replace(/{mm}/g, '%M')
        .replace(/{ss}/g, '%S') + ext
    );
  }

  static async getOrCreateRoom(roomUrl, roomName) {
    const cached = await this.getRoomCache(roomUrl);
    if (cached) return cached;

    const exist = await pool.query('SELECT * FROM rooms WHERE room_url = $1', [roomUrl]);
    if (exist.rows.length > 0) {
      const room = exist.rows[0];
      await this.setRoomCache(room);
      return room;
    }
    const result = await pool.query(
      `INSERT INTO rooms (room_url, room_name)
       VALUES ($1, $2)
       RETURNING *`,
      [roomUrl, roomName || '']
    );
    const room = result.rows[0];
    await this.setRoomCache(room);
    return room;
  }

  static async getSetting(key, defaultValue) {
    try {
      const ps = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
      if (ps.rows.length) {
        return ps.rows[0].value;
      }
    } catch (_) {}
    return defaultValue;
  }

  static async getPoolSize() {
    const value = await this.getSetting('pool_size', '3');
    return parseInt(value, 10) || 3;
  }

  static async getActiveTasksCount() {
    try {
      const keys = await redis.keys('active_task:*');
      return keys.length;
    } catch (_) {
      return 0;
    }
  }

  static async checkReuseSession(room) {
    let reuseSession = false;
    let resumeCount = 0;

    try {
      const delayValue = await this.getSetting('delay', '60');
      const delay = parseInt(delayValue, 10) || 60;
      if (delay > 0) {
        const lockKey = `lock:resume:${room.id}`;
        const lockAcquired = await redis.set(lockKey, '1', { EX: 10, NX: true }).catch(() => null);
        if (!lockAcquired) {
          console.log(`[续播] ${room.room_name || room.room_url} 续播锁占用中，跳过`);
        } else {
          const recent = await pool.query(
            `SELECT id, total_segments, total_size FROM recording_sessions
             WHERE room_url = $1 AND status IN ('completed', 'interrupted')
               AND deleted_at IS NULL
               AND ended_at > NOW() - INTERVAL '1 second' * $2
             ORDER BY ended_at DESC LIMIT 1`,
            [room.room_url, delay]
          );
          if (recent.rows.length > 0) {
            reuseSession = true;
            resumeCount = recent.rows[0].id;
            console.log(`[续播] 复用会话 ${recent.rows[0].id} (上次结束在延迟窗口内)`);
          }
          redis.del(lockKey).catch(() => {});
        }
      }
    } catch (_) {}

    return { reuseSession, resumeCount };
  }

  static generateOutputPath(downloader, template, roomName, title, segmentDuration, reuseSession, roomOutputPath) {
    const useSegment = segmentDuration > 0;
    const ext = downloader.getExtension();

    let outputFilePattern;

    if (useSegment) {
      const strftimeName = this.templateToStrftime(template, roomName || title, ext);
      outputFilePattern = path.join(DOWNLOAD_DIR, strftimeName);
    } else {
      const filename = this.generateFilename(template, roomName || title, ext);
      outputFilePattern = path.join(DOWNLOAD_DIR, filename);
    }

    if (reuseSession && !useSegment && roomOutputPath) {
      const prevOutput = roomOutputPath;
      if (fs.existsSync(path.dirname(prevOutput))) {
        console.log(`[续播] 复用上次文件路径: ${prevOutput}`);
        outputFilePattern = prevOutput;
      }
    }

    return outputFilePattern;
  }

  static async finishSession({
    code,
    engine,
    room,
    sessionId,
    sessionStart,
    reuseSession,
    useSegment,
    segmentListPath,
    outputFilePattern,
    roomKey,
  }) {
    await this.delActiveTask(roomKey);
    console.log(`[${code}] 录制结束，路径: ${outputFilePattern} (日志: logs/${engine.name}_${sessionId}.log)`);

    try {
      await pool.query(`UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`, [
        room.id,
      ]);
      await this.delRoomCache(room.room_url);

      if (useSegment) {
        let segmentFiles = [];
        if (segmentListPath && fs.existsSync(segmentListPath)) {
          const content = fs.readFileSync(segmentListPath, 'utf-8');
          const lines = content
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
          for (const line of lines) {
            segmentFiles.push(path.isAbsolute(line) ? line : path.join(DOWNLOAD_DIR, line));
          }
          try {
            fs.unlinkSync(segmentListPath);
          } catch (_) {}
        } else if (outputFilePattern) {
          try {
            const dir = path.dirname(outputFilePattern);
            const base = path.basename(outputFilePattern);
            const prefix = base.replace(/%[YmdHMS]/g, '.*').replace(/\.\w+$/, '');
            const ext = path.extname(base);
            const regex = new RegExp('^' + prefix + '.*' + ext.replace(/\./g, '\\.') + '$');
            const files = fs.readdirSync(dir);
            segmentFiles = files
              .filter((f) => regex.test(f))
              .sort()
              .map((f) => path.join(dir, f));
          } catch (err) {
            console.error('[api] 分段文件扫描失败:', err.message);
          }
        }

        const thresholdValue = await this.getSetting('filtering_threshold', '10');
        const thresholdBytes = (parseInt(thresholdValue, 10) || 10) * 1024 * 1024;
        let totalSize = 0;
        let newFileCount = 0;

        for (const filePath of segmentFiles) {
          const tracked = await pool.query('SELECT id FROM recording_files WHERE file_path = $1', [filePath]);
          if (tracked.rows.length > 0) continue;

          let fileSize = 0;
          try {
            fileSize = fs.statSync(filePath).size;
          } catch (_) {}
          if (fileSize < thresholdBytes && fileSize > 0) continue;
          totalSize += fileSize;

          await pool.query(
            `INSERT INTO recordings (session_id, segment_index, room_url, file_path, file_size, started_at, ended_at, status)
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'completed')
             ON CONFLICT (file_path) DO NOTHING`,
            [sessionId, newFileCount, room.room_url, filePath, fileSize, sessionStart]
          );
          await pool.query(
            `INSERT INTO recording_files (session_id, room_url, file_path, file_name, file_size, status, completed_at)
             VALUES ($1, $2, $3, $4, $5, 'completed', NOW())
             ON CONFLICT (file_path) DO NOTHING`,
            [sessionId, room.room_url, filePath, path.basename(filePath), fileSize]
          );
          newFileCount++;

          // 实时入队转码
          if (filePath.endsWith('.flv')) {
            const mp4Path = filePath.replace(/\.flv$/i, '.mp4');
            transcodeQueue
              .enqueue({
                flvPath: filePath,
                mp4Path: mp4Path,
                sessionId: sessionId,
              })
              .catch((err) => console.error('[转码队列] 入队异常:', err.message));
          }
        }

        if (sessionId) {
          if (reuseSession) {
            await pool.query(
              `UPDATE recording_sessions
               SET ended_at = NOW(), status = $1,
                   total_segments = total_segments + $2,
                   total_size = total_size + $3
               WHERE id = $4 AND status = 'recording'`,
              [code === 0 ? 'completed' : 'interrupted', newFileCount, totalSize, sessionId]
            );
          } else {
            await pool.query(
              `UPDATE recording_sessions
               SET ended_at = NOW(), status = $1,
                   total_segments = $2,
                   total_size = $3
               WHERE id = $4 AND status = 'recording'`,
              [code === 0 ? 'completed' : 'interrupted', newFileCount, totalSize, sessionId]
            );
          }
        }
        console.log(`[api] 分段录制完成, 共 ${segmentFiles.length} 个文件, ${(totalSize / 1024 / 1024).toFixed(1)}MB`);

        if (segmentFiles.length > 0) {
          const completedSession = {
            id: sessionId,
            room_url: room.room_url,
            room_name: room.room_name,
            started_at: sessionStart,
          };
          UploadService.findAndAutoUpload(completedSession).catch((err) => console.error('[自动投稿] 异常:', err.message));
        }
      } else {
        let fileSize = 0;
        try {
          const stat = fs.statSync(outputFilePattern);
          fileSize = stat.size;
        } catch (statErr) {
          console.warn(`[api] 无法获取文件大小: ${outputFilePattern}`, statErr.message);
        }

        const existingRec = reuseSession
          ? await pool.query('SELECT id FROM recordings WHERE session_id = $1 AND file_path = $2', [
              sessionId,
              outputFilePattern,
            ])
          : null;

        if (existingRec?.rows.length > 0) {
          await pool.query(
            `UPDATE recordings SET file_size = $1, ended_at = NOW(), status = 'completed' WHERE id = $2`,
            [fileSize, existingRec.rows[0].id]
          );
        } else {
          await pool.query(
            `INSERT INTO recordings (session_id, segment_index, room_url, file_path, file_size, started_at, ended_at, status)
             VALUES ($1, 0, $2, $3, $4, $5, NOW(), 'completed')`,
            [sessionId, room.room_url, outputFilePattern, fileSize, sessionStart]
          );
          await pool.query(
            `INSERT INTO recording_files (session_id, room_url, file_path, file_name, file_size, status, completed_at)
             VALUES ($1, $2, $3, $4, $5, 'completed', NOW())
             ON CONFLICT (file_path) DO NOTHING`,
            [sessionId, room.room_url, outputFilePattern, path.basename(outputFilePattern), fileSize]
          );
        }

        if (sessionId) {
          if (reuseSession) {
            await pool.query(
              `UPDATE recording_sessions
               SET ended_at = NOW(), status = $1,
                   total_segments = total_segments + 1,
                   total_size = total_size + $2
               WHERE id = $3 AND status = 'recording'`,
              [code === 0 ? 'completed' : 'interrupted', fileSize, sessionId]
            );
          } else {
            await pool.query(
              `UPDATE recording_sessions
               SET ended_at = NOW(), status = $1,
                   total_segments = 1,
                   total_size = $2
               WHERE id = $3 AND status = 'recording'`,
              [code === 0 ? 'completed' : 'interrupted', fileSize, sessionId]
            );
          }
          await pool.query(
            `UPDATE recording_files SET file_size = $1, status = 'completed', completed_at = NOW()
               WHERE session_id = $2 AND file_path = $3`,
            [fileSize, sessionId, outputFilePattern]
          );
        }

        if (/\.flv$/i.test(outputFilePattern)) {
          const mp4Path = outputFilePattern.replace(/\.flv$/i, '.mp4');
          transcodeQueue
            .enqueue({
              flvPath: outputFilePattern,
              mp4Path: mp4Path,
              sessionId: sessionId,
            })
            .catch((err) => console.error('[转码队列] 入队异常:', err.message));
          const completedSession = {
            id: sessionId,
            room_url: room.room_url,
            room_name: room.room_name,
            started_at: sessionStart,
          };
          UploadService.findAndAutoUpload(completedSession).catch((err) => console.error('[自动投稿] 异常:', err.message));
        }
      }

      if (sessionId) {
        try {
          const sess = await pool.query('SELECT total_segments, total_size FROM recording_sessions WHERE id = $1', [
            sessionId,
          ]);
          const segs = sess.rows[0]?.total_segments || 0;
          const mb = ((sess.rows[0]?.total_size || 0) / 1024 / 1024).toFixed(1);
          notify.recordingComplete(room.room_name, segs, mb, sessionId, room.room_url);
        } catch (_) {}
      }
    } catch (dbErr) {
      console.error('[api] 录制结束数据库更新失败:', dbErr);
    }
  }

  static async batchTranscodeSegmentFiles(segmentFiles, _sessionId) {
    try {
      const autoTranscode = await this.getSetting('auto_transcode', 'true');
      if (autoTranscode === 'true') {
        const deleteOriginals = await this.getSetting('transcode_delete_originals', 'true');
        const shouldDelete = deleteOriginals === 'true';

        console.log(`[api] 开始批量转码 ${segmentFiles.length} 个 FLV 分片`);
        let successCount = 0;

        for (const flvPath of segmentFiles) {
          const mp4Path = flvPath.replace(/\.flv$/i, '.mp4');
          const result = await transcoder.fastTranscode(flvPath, mp4Path);

          if (result.success) {
            successCount++;
            await pool.query(
              `UPDATE recording_files SET file_path = $1, file_name = $2, file_size = $3 WHERE file_path = $4`,
              [mp4Path, path.basename(mp4Path), result.outputSize, flvPath]
            );
            await pool.query(`UPDATE recordings SET file_path = $1, file_size = $2 WHERE file_path = $3`, [
              mp4Path,
              result.outputSize,
              flvPath,
            ]);
            if (shouldDelete) {
              try {
                fs.unlinkSync(flvPath);
              } catch (_) {}
            }
          } else {
            console.error(`[api] 分片转码失败: ${flvPath}, ${result.error}`);
          }
        }

        console.log(`[api] 批量转码完成: ${successCount}/${segmentFiles.length} 成功`);
      }
    } catch (transcodeErr) {
      console.error('[api] 批量转码异常:', transcodeErr.message);
    }
  }

  static async fastTranscodeSingleFile(flvPath, _sessionId) {
    try {
      const autoTranscode = await this.getSetting('auto_transcode', 'true');
      if (autoTranscode === 'true') {
        const deleteOriginals = await this.getSetting('transcode_delete_originals', 'true');
        const shouldDelete = deleteOriginals === 'true';

        const outputMp4 = flvPath.replace(/\.flv$/i, '.mp4');

        console.log(`[api] 开始快速转码: ${flvPath} → ${outputMp4}`);
        const result = await transcoder.fastTranscode(flvPath, outputMp4);

        if (result.success) {
          await pool.query(
            `UPDATE recording_files SET file_path = $1, file_name = $2, file_size = $3 WHERE file_path = $4`,
            [outputMp4, path.basename(outputMp4), result.outputSize, flvPath]
          );
          await pool.query(`UPDATE recordings SET file_path = $1, file_size = $2 WHERE file_path = $3`, [
            outputMp4,
            result.outputSize,
            flvPath,
          ]);
          if (shouldDelete) {
            try {
              fs.unlinkSync(flvPath);
            } catch (_) {}
          }
          console.log(`[api] 快速转码完成: ${outputMp4} (${(result.outputSize / 1024 / 1024).toFixed(1)}MB)`);
        } else {
          console.error(`[api] 快速转码失败: ${result.error}`);
        }
      }
    } catch (transcodeErr) {
      console.error('[api] 快速转码异常:', transcodeErr.message);
    }
  }

  static async startRecording({ url, title, caption, room_url }) {
    console.log('[api] 收到录制请求:', {
      title,
      room_url,
      url: url?.slice(0, 60),
    });

    if (!url || !title) {
      console.log('[api] 录制请求被拒: 缺少必填参数 (url/title)');
      return { error: true, status: 400, code: 400, message: '请提供直播流URL和标题。' };
    }
    if (!DOWNLOAD_DIR) {
      return {
        error: true,
        status: 200,
        code: 500,
        message: '请设置 VIDEO_DOWNLOAD_DIR 环境变量，并确保该目录已存在。',
      };
    }
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    }

    const roomKey = room_url || url;

    if (await this.isActiveTask(roomKey)) {
      console.log('[api] 录制请求被拒: active_task 已存在 (roomKey=' + roomKey + ')');
      return { error: true, status: 200, code: 400, status_str: 'Already recording', message: '请勿重复开启' };
    }

    const poolSize = await this.getPoolSize();
    const activeTasksCount = await this.getActiveTasksCount();

    if (activeTasksCount >= poolSize) {
      return {
        error: true,
        status: 200,
        code: 429,
        status_str: 'Pool full',
        message: `下载线程池已满 (${activeTasksCount}/${poolSize})，请等待其他录制完成`,
      };
    }

    let room;
    try {
      room = await this.getOrCreateRoom(roomKey, title);
    } catch (dbErr) {
      console.error('[api] 数据库操作失败:', dbErr);
      return { error: true, status: 200, code: 500, message: '数据库操作失败' };
    }

    if (room.monitoring_enabled === false) {
      console.log('[api] 录制请求被拒: monitoring_enabled=false (room=' + room.id + ')');
      return {
        error: true,
        status: 200,
        code: 400,
        status_str: 'Monitoring paused',
        message: `直播间 ${room.room_name || room.room_url} 已暂停监听`,
      };
    }

    if (room.status === 'recording' || room.status === 'paused') {
      console.log('[api] 录制请求被拒: 房间状态=' + room.status + ' (room=' + room.id + ')');
      return {
        error: true,
        status: 200,
        code: 400,
        status_str: 'Already recording',
        message: `直播间 ${room.room_name || room.room_url} 已在录制中`,
      };
    }

    await pool.query(
      `UPDATE recording_sessions SET ended_at = NOW(), status = 'interrupted'
       WHERE room_url = $1 AND status = 'recording'`,
      [room.room_url]
    );

    const { reuseSession, resumeCount } = await this.checkReuseSession(room);

    console.log(`[开始] 直播间 ${roomKey} 开始录制${caption ? ' - ' + caption : ''}`);

    const downloader = await getActiveDownloader();

    const template = room.filename_template || '{room_name}_{datetime}';
    const segmentDuration = room.segment_duration || 0;
    const useSegment = segmentDuration > 0;

    const outputFilePattern = this.generateOutputPath(
      downloader,
      template,
      room.room_name,
      title,
      segmentDuration,
      reuseSession,
      room.output_path
    );

    console.log(`[任务启动] 文件名模板: ${template}`);
    console.log(`[任务启动] 分段录制: ${useSegment ? segmentDuration + 's' : '关闭'}`);
    console.log(`[任务启动] 视频将保存至: ${outputFilePattern}`);

    let segmentListPath;
    if (useSegment) {
      segmentListPath = path.join(
        DOWNLOAD_DIR,
        `.segments_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`
      );
    }

    const dlArgs = downloader.buildArgs(url, outputFilePattern, { segmentDuration, segmentListPath });

    const procLog = createProcLog(downloader.name);
    const { stream: logStream, rename: renameLog, logCommand } = procLog;
    console.log(`[任务启动] 下载引擎: ${downloader.name}`);
    logCommand(downloader.name, dlArgs);

    const dlProcess = downloader.spawn(dlArgs);

    let sessionId = null;
    let sessionStart;

    if (dlProcess.stderr) {
      dlProcess.stderr.on('data', (chunk) => {
        logStream.write(chunk);
      });
    }

    if (dlProcess.stdout) {
      dlProcess.stdout.on('data', (chunk) => {
        logStream.write(chunk);
      });
    }

    dlProcess.on('error', (err) => {
      console.error(`${downloader.name} 启动失败:`, err);
    });

    sessionStart = new Date();
    try {
      await pool.query(
        `UPDATE rooms SET status = 'recording', output_path = $1, ffmpeg_pid = $2, updated_at = NOW() WHERE id = $3`,
        [outputFilePattern, dlProcess.pid, room.id]
      );
      await this.delRoomCache(room.room_url);

      if (reuseSession) {
        const recent = await pool.query(
          `UPDATE recording_sessions SET status = 'recording', ended_at = NULL WHERE id = $1
           RETURNING id`,
          [resumeCount]
        );
        sessionId = recent.rows[0]?.id || null;
      }

      if (!sessionId) {
        const session = await pool.query(
          `INSERT INTO recording_sessions (room_url, started_at, output_dir, status, caption, stream_url)
           VALUES ($1, $2, $3, 'recording', $4, $5)
           RETURNING id`,
          [room.room_url, sessionStart, path.dirname(outputFilePattern), caption || '', url]
        );
        sessionId = session.rows[0].id;
      }
      renameLog(sessionId);
      console.log(`[api] 日志文件: ${procLog.logPath}`);
    } catch (dbErr) {
      console.error('[api] 更新数据库状态失败:', dbErr);
      dlProcess.kill();
      return { error: true, status: 500, code: 500, message: '更新数据库状态失败' };
    }

    if (!useSegment) {
      try {
        const existing = await pool.query('SELECT id FROM recording_files WHERE file_path = $1', [outputFilePattern]);
        if (existing.rows.length > 0) {
          await pool.query(
            `UPDATE recording_files SET status = 'recording', session_id = $1, checked_at = NOW()
             WHERE id = $2`,
            [sessionId, existing.rows[0].id]
          );
        } else {
          await pool.query(
            `INSERT INTO recording_files (session_id, room_url, file_path, file_name, status)
             VALUES ($1, $2, $3, $4, 'recording')`,
            [sessionId, room.room_url, outputFilePattern, path.basename(outputFilePattern)]
          );
        }
      } catch (dbErr) {
        console.warn('[api] recording_files 写入失败:', dbErr.message);
      }
    }

    await this.setActiveTask(roomKey, {
      pid: dlProcess.pid,
      outputPath: outputFilePattern,
      roomId: room.id,
      sessionId,
      startTime: Date.now(),
      downloader: downloader.name,
    });

    const finishSessionWrapper = async (code, engine) => {
      if (!engine) engine = downloader;
      await this.finishSession({
        code,
        engine,
        room,
        sessionId,
        sessionStart,
        reuseSession,
        useSegment,
        segmentListPath,
        outputFilePattern,
        roomKey,
      });
    };

    if (dlProcess.exitCode !== null || dlProcess.signalCode !== null) {
      finishSessionWrapper(dlProcess.exitCode);
    } else {
      dlProcess.on('close', finishSessionWrapper);
    }

    notify.recordingStart(room.room_name || title, caption, room.room_url);

    return {
      error: false,
      room,
      sessionId,
      outputFilePattern,
    };
  }

  static async getMaxResumeRetries() {
    try {
      const r = await pool.query("SELECT value FROM settings WHERE key = 'max_resume_retries'");
      if (r.rows.length) return parseInt(r.rows[0].value, 10) || 3;
    } catch (_) {}
    return 3;
  }

  static async tryResumeSession(session) {
    if (!DOWNLOAD_DIR) throw new Error('VIDEO_DOWNLOAD_DIR 未设置');

    const downloader = await getActiveDownloader();

    const segmentDuration = session.segment_duration || 0;
    const useSegment = segmentDuration > 0;
    const template = session.filename_template || '{room_name}_{datetime}';
    const retryCount = session.retry_count || 0;
    const ext = downloader.getExtension();

    let outputPath;
    if (useSegment) {
      const strftimeName = this.templateToStrftime(template, session.room_name || '', ext);
      outputPath = path.join(DOWNLOAD_DIR, strftimeName);
    } else {
      const base = this.generateFilename(template, session.room_name || '', ext);
      const parsed = path.parse(base);
      outputPath = path.join(DOWNLOAD_DIR, `${parsed.name}_resume_${retryCount + 1}${parsed.ext}`);
    }

    const streamUrl = session.stream_url || session.room_url;
    const dlArgs = downloader.buildArgs(streamUrl, outputPath, { segmentDuration });

    const { stream: logStream, logPath: ffmpegLogPath, logCommand } = createProcLog(downloader.name, session.id);
    logCommand(downloader.name, dlArgs);

    const ffmpeg = downloader.spawn(dlArgs);

    if (ffmpeg.stderr) {
      ffmpeg.stderr.on('data', (chunk) => logStream.write(chunk));
    }
    if (ffmpeg.stdout) {
      ffmpeg.stdout.on('data', (chunk) => logStream.write(chunk));
    }

    let sessionFinalized = false;

    ffmpeg.on('close', async (code) => {
      if (sessionFinalized) return;
      sessionFinalized = true;

      await this.delActiveTask(this.activeTaskKey(session.room_url));
      console.log(`[恢复] 会话 ${session.id} ffmpeg 退出 (code=${code}), 文件: ${outputPath} (日志: ${ffmpegLogPath})`);

      try {
        await pool.query(`UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`, [
          session.room_id,
        ]);
        await this.delRoomCache(session.room_url);

        const status = code === 0 ? 'completed' : 'interrupted';

        if (useSegment) {
          const outputDir = path.dirname(outputPath);
          let totalSegments = 0;
          let totalSize = 0;

          try {
            const files = fs.readdirSync(outputDir);
            const videoRe = /\.(flv|mp4)$/i;

            for (const f of files) {
              if (!videoRe.test(f)) continue;
              const fp = path.join(outputDir, f);
              const tracked = await pool.query('SELECT id FROM recording_files WHERE file_path = $1', [fp]);
              if (tracked.rows.length > 0) continue;

              let stat;
              try {
                stat = fs.statSync(fp);
              } catch (_) {
                continue;
              }

              await pool.query(
                `INSERT INTO recordings (session_id, segment_index, room_url, file_path, file_size, started_at, ended_at, status)
                 VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), 'completed')
                 ON CONFLICT (file_path) DO NOTHING`,
                [session.id, totalSegments, session.room_url, fp, stat.size]
              );

              await pool.query(
                `INSERT INTO recording_files (session_id, room_url, file_path, file_name, file_size, status, completed_at)
                 VALUES ($1, $2, $3, $4, $5, 'completed', NOW())
                 ON CONFLICT (file_path) DO NOTHING`,
                [session.id, session.room_url, fp, f, stat.size]
              );

              totalSegments++;
              totalSize += stat.size;
            }
          } catch (_) {}

          if (totalSegments > 0) {
            await pool.query(
              `UPDATE recording_sessions SET total_segments = total_segments + $1, total_size = total_size + $2 WHERE id = $3`,
              [totalSegments, totalSize, session.id]
            );
          }

          await pool.query(`UPDATE recording_sessions SET ended_at = NOW(), status = $1 WHERE id = $2`, [
            status,
            session.id,
          ]);

          if (totalSegments > 0) {
            try {
              const files = fs.readdirSync(outputDir);
              const flvFiles = files
                .filter((f) => /\.flv$/i.test(f))
                .map((f) => path.join(outputDir, f))
                .sort();

              if (flvFiles.length > 0) {
                for (const flvPath of flvFiles) {
                  const mp4Path = flvPath.replace(/\.flv$/i, '.mp4');
                  transcodeQueue
                    .enqueue({
                      flvPath: flvPath,
                      mp4Path: mp4Path,
                      sessionId: session.id,
                    })
                    .catch((err) => console.error('[恢复][转码队列] 入队异常:', err.message));
                }
              }
            } catch (transcodeErr) {
              console.error('[恢复] 批量转码异常:', transcodeErr.message);
            }
          }
        } else {
          let fileSize = 0;
          try {
            const stat = fs.statSync(outputPath);
            fileSize = stat.size;
          } catch (_) {}

          await pool.query(
            `INSERT INTO recordings (session_id, segment_index, room_url, file_path, file_size, started_at, ended_at, status)
             VALUES ($1, 0, $2, $3, $4, $5, NOW(), 'completed')`,
            [session.id, session.room_url, outputPath, fileSize, session.started_at]
          );

          await pool.query(
            `INSERT INTO recording_files (session_id, room_url, file_path, file_name, file_size, status, completed_at)
             VALUES ($1, $2, $3, $4, $5, 'completed', NOW())
             ON CONFLICT (file_path) DO NOTHING`,
            [session.id, session.room_url, outputPath, path.basename(outputPath), fileSize]
          );

          await pool.query(
            `UPDATE recording_sessions SET ended_at = NOW(), status = $1, total_segments = 1, total_size = $2 WHERE id = $3`,
            [status, fileSize, session.id]
          );

          if (/\.flv$/i.test(outputPath)) {
            try {
              const mp4Path = outputPath.replace(/\.flv$/i, '.mp4');
              transcodeQueue
                .enqueue({
                  flvPath: outputPath,
                  mp4Path: mp4Path,
                  sessionId: session.id,
                })
                .catch((err) => console.error('[恢复][转码队列] 入队异常:', err.message));
            } catch (transcodeErr) {
              console.error('[恢复] 快速转码异常:', transcodeErr.message);
            }
          }
        }

        const completedSession = {
          id: session.id,
          room_url: session.room_url,
          room_name: session.room_name,
          started_at: session.started_at,
        };
        UploadService.findAndAutoUpload(completedSession).catch((err) => console.error('[自动投稿] 异常:', err.message));
      } catch (dbErr) {
        console.error(`[恢复] 会话 ${session.id} 结束处理失败:`, dbErr.message);
      }
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 2000);
      ffmpeg.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ffmpeg.on('close', (code) => {
        clearTimeout(timer);
        if (code !== null && code !== 0) reject(new Error(`ffmpeg exited with code ${code}`));
        else resolve();
      });
    });

    try {
      process.kill(ffmpeg.pid, 0);
    } catch (_) {
      throw new Error('ffmpeg exited during initialization');
    }

    await pool.query(
      `UPDATE rooms SET status = 'recording', output_path = $1, ffmpeg_pid = $2, updated_at = NOW() WHERE id = $3`,
      [outputPath, ffmpeg.pid, session.room_id]
    );
    await this.delRoomCache(session.room_url);

    await this.setActiveTask(this.activeTaskKey(session.room_url), {
      pid: ffmpeg.pid,
      outputPath,
      roomId: session.room_id,
      sessionId: session.id,
      startTime: Date.now(),
    });

    await pool.query(`UPDATE recording_sessions SET retry_count = $1 WHERE id = $2`, [
      (retryCount || 0) + 1,
      session.id,
    ]);

    console.log(`[恢复] 会话 ${session.id} ffmpeg 已启动 (PID: ${ffmpeg.pid}), 输出: ${outputPath}`);
  }

  static async cleanupStaleRecordings() {
    const MAX_RESUME_RETRIES = await this.getMaxResumeRetries();
    try {
      const staleRooms = await pool.query(
        `SELECT id, room_url, room_name, ffmpeg_pid, output_path FROM rooms WHERE status IN ('recording', 'paused')`
      );
      for (const row of staleRooms.rows) {
        if (row.ffmpeg_pid) {
          try {
            process.kill(row.ffmpeg_pid, 'SIGTERM');
          } catch (_) {}
        }
        console.log(`[清理] 直播间 ${row.room_name || row.room_url} (ID:${row.id}) 状态已重置为 idle`);
        await pool.query(`UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`, [
          row.id,
        ]);
      }

      const staleSessions = await pool.query(
        `SELECT rs.*, r.id as room_id, r.room_name FROM recording_sessions rs JOIN rooms r ON rs.room_url = r.room_url WHERE rs.status = 'recording'`
      );

      for (const session of staleSessions.rows) {
        if ((session.retry_count || 0) < MAX_RESUME_RETRIES) {
          try {
            console.log(`[恢复] 尝试恢复会话 ${session.id} (直播间: ${session.room_url})`);
            await this.tryResumeSession(session);
            continue;
          } catch (err) {
            console.error(`[恢复] 会话 ${session.id} 恢复失败:`, err.message);
          }
        }

        console.log(`[清理] 会话 ${session.id} 状态已标记为 interrupted`);
        await pool.query(`UPDATE recording_sessions SET ended_at = NOW(), status = 'interrupted' WHERE id = $1`, [
          session.id,
        ]);
      }
    } catch (err) {
      console.error('[启动清理] 失败:', err);
    }
  }
}

module.exports = RecorderService;
