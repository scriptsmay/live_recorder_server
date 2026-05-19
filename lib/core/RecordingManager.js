const path = require('path');
const fs = require('fs');
const { SUPPORTED_TRANSCODE_EXT } = require('../../config/config');
const pool = require('../../db/index');
const redis = require('../../db/redis');
const { createProcLog } = require('../utils/proc-log');
const transcodeQueue = require('./TranscodeQueue');
const segmenter = require('./segmenter');
const { getActiveDownloader } = require('./downloaders/DownloaderFactory');

/**
 * 录制管理器 - 负责 ffmpeg 外部调用的业务逻辑
 *
 * 主要职责：
 * 1. 管理录制进程的启动、监控和结束
 * 2. 处理分段录制的切片任务
 * 3. 管理录制会话的生命周期
 * 4. 处理录制完成后的文件转码和上传触发
 */
class RecordingManager {
  constructor() {
    this.DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR;
  }

  /**
   * 启动分段录制任务
   *
   * @param {Object} params - 任务参数
   * @param {string} params.inputFile - 输入文件路径
   * @param {string} params.outputFilePattern - 输出文件模式（包含占位符）
   * @param {string} params.roomKey - 房间唯一标识
   * @param {number} params.segmentDuration - 分段时长（秒）
   * @returns {Promise<Object>} 任务执行结果，包含 success 和 logPath 或 error
   */
  async startSegmentTask({ inputFile, outputFilePattern, roomKey, segmentDuration }) {
    const result = await segmenter.segmentAndTranscode(
      inputFile,
      outputFilePattern,
      {
        segmentTime: segmentDuration,
      },
      roomKey
    );

    if (result.success) {
      console.log('切割转码完成，日志路径:', result.logPath);
    } else {
      console.error('任务失败:', result.error);
    }

    return result;
  }

  /**
   * 启动录制进程
   *
   * @param {Object} params - 启动参数
   * @param {Object} params.downloader - 下载器实例
   * @param {string} params.streamUrl - 直播流地址
   * @param {string} params.outputPath - 输出文件路径
   * @param {Object} params.options - 录制选项
   * @param {number} params.options.segmentDuration - 分段时长（秒），0表示不分段
   * @param {string} params.options.platform - 直播平台
   * @param {boolean} params.options.isStreamUrl - 是否为流地址
   * @param {string|number} params.sessionId - 会话ID
   * @returns {Object} 包含进程对象、日志流和日志路径的对象
   */
  startRecordingProcess({ downloader, streamUrl, outputPath, options = {}, sessionId }) {
    const dlArgs = downloader.buildArgs(streamUrl, outputPath, {
      segmentDuration: options.segmentDuration || 0,
      platform: options.platform,
      isStreamUrl: options.isStreamUrl,
    });

    const procLog = createProcLog(downloader.name, sessionId);
    const { stream: logStream, rename: renameLog, logCommand } = procLog;

    console.log(`[任务启动] 下载引擎: ${downloader.name}`);
    logCommand(downloader.name, dlArgs);

    const dlProcess = downloader.spawn(dlArgs);

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

    return {
      process: dlProcess,
      logStream,
      logPath: procLog.logPath,
      renameLog,
      destroyLog: () => procLog.destroy(),
    };
  }

  /**
   * 更新直播间、录制会话的进程PID
   */
  async updateSessionPidToDatabase({ roomId, sessionId, pid }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); // 开启事务

      // 更新房间状态和 PID
      await client.query(`UPDATE rooms SET status = 'recording', ffmpeg_pid = $1 WHERE id = $2`, [pid, roomId]);

      // 更新录制会话状态
      await client.query(`UPDATE recording_sessions SET status = 'recording' WHERE id = $1`, [sessionId]);

      await client.query('COMMIT'); // 提交事务
    } catch (e) {
      await client.query('ROLLBACK'); // 出现错误则回滚
      console.error('更新数据库状态失败:', e);
      throw e; // 向上抛出错误，让调用者知道更新失败了
    } finally {
      client.release(); // 释放连接回连接池
    }
  }

  async createSession({ room, streamUrl, sessionId, outputPath, caption, reuseSession, resumeCount }) {
    let finalSessionId = sessionId;

    if (reuseSession) {
      // 恢复进程时直接进入录制状态
      const recent = await pool.query(
        `UPDATE recording_sessions SET status = 'recording', ended_at = NULL WHERE id = $1 RETURNING id`,
        [resumeCount]
      );
      finalSessionId = recent.rows[0]?.id || null;
    }

    if (!finalSessionId) {
      const sessionStart = new Date();

      // 新建会话是准备状态
      const session = await pool.query(
        `INSERT INTO recording_sessions (room_url, started_at, output_dir, status, caption, stream_url)
         VALUES ($1, $2, $3, 'pending', $4, $5)
         RETURNING id`,
        [room.room_url, sessionStart, path.dirname(outputPath), caption || '', streamUrl]
      );
      finalSessionId = session.rows[0].id;
    }

    return finalSessionId;
  }

  /**
   * 更新录制会话状态到数据库
   *
   * @param {Object} params - 更新参数
   * @param {Object} params.room - 房间信息
   * @param {string} params.outputPath - 输出文件路径
   * @param {number} params.pid - 进程ID
   * @param {string|number} params.sessionId - 会话ID
   * @param {Date} params.sessionStart - 会话开始时间
   * @param {boolean} params.reuseSession - 是否复用会话
   * @param {number} params.resumeCount - 续播计数
   * @param {string} params.caption - 备注信息
   * @param {string} params.streamUrl - 直播流地址
   * @returns {Promise<string|number>} 会话ID
   */
  async updateSessionToDatabase({
    room,
    outputPath,
    pid,
    sessionId,
    sessionStart,
    reuseSession,
    resumeCount,
    caption,
    streamUrl,
  }) {
    // 先更新直播间录制状态
    // const roomStatus = pid ? 'recording' : 'ide';
    await pool.query(
      `UPDATE rooms SET status = 'pending', output_path = $1, ffmpeg_pid = $2, updated_at = NOW() WHERE id = $3`,
      [outputPath, pid, room.id]
    );

    let finalSessionId = sessionId;

    if (reuseSession) {
      const recent = await pool.query(
        `UPDATE recording_sessions SET status = 'recording', ended_at = NULL WHERE id = $1 RETURNING id`,
        [resumeCount]
      );
      finalSessionId = recent.rows[0]?.id || null;
    }

    if (!finalSessionId) {
      const session = await pool.query(
        `INSERT INTO recording_sessions (room_url, started_at, output_dir, status, caption, stream_url)
         VALUES ($1, $2, $3, 'recording', $4, $5)
         RETURNING id`,
        [room.room_url, sessionStart, path.dirname(outputPath), caption || '', streamUrl]
      );
      finalSessionId = session.rows[0].id;
    }

    return finalSessionId;
  }

  /**
   * 初始化非分段录制的文件记录
   *
   * @param {Object} params - 参数
   * @param {string|number} params.sessionId - 会话ID
   * @param {Object} params.room - 房间信息
   * @param {string} params.outputPath - 输出文件路径
   */
  async initNonSegmentFileRecord({ sessionId, room, outputPath }) {
    try {
      const existing = await pool.query('SELECT id FROM recording_files WHERE file_path = $1', [outputPath]);
      if (existing.rows.length > 0) {
        await pool.query(
          `UPDATE recording_files SET status = 'recording', session_id = $1, checked_at = NOW() WHERE id = $2`,
          [sessionId, existing.rows[0].id]
        );
      } else {
        await pool.query(
          `INSERT INTO recording_files (session_id, room_url, file_path, file_name, status)
           VALUES ($1, $2, $3, $4, 'recording')`,
          [sessionId, room.room_url, outputPath, path.basename(outputPath)]
        );
      }
    } catch (dbErr) {
      console.warn('[RecordingManager] recording_files 写入失败:', dbErr.message);
    }
  }

  /**
   * 恢复录制会话
   *
   * @param {Object} session - 会话信息
   * @param {string|number} session.id - 会话ID
   * @param {string} session.room_url - 房间URL
   * @param {string} session.room_name - 房间名称
   * @param {number} session.room_id - 房间ID
   * @param {string} session.stream_url - 直播流地址
   * @param {string} session.filename_template - 文件名模板
   * @param {number} session.segment_duration - 分段时长
   * @param {number} session.retry_count - 重试次数
   * @param {Date} session.started_at - 开始时间
   * @returns {Promise<void>}
   */
  async resumeSession(session) {
    if (!this.DOWNLOAD_DIR) {
      throw new Error('VIDEO_DOWNLOAD_DIR 未设置');
    }

    const downloader = await getActiveDownloader();

    const segmentDuration = session.segment_duration || 0;
    const useSegment = segmentDuration > 0;
    const template = session.filename_template || '{room_name}_{datetime}';
    const retryCount = session.retry_count || 0;
    const ext = downloader.getExtension();

    let outputPath;
    if (useSegment) {
      const strftimeName = this._templateToStrftime(template, session.room_name || '', ext);
      outputPath = path.join(this.DOWNLOAD_DIR, strftimeName);
    } else {
      const base = this._generateFilename(template, session.room_name || '', ext);
      outputPath = path.join(this.DOWNLOAD_DIR, base);
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

      await this._delActiveTask(this._activeTaskKey(session.room_url));
      console.log(`[恢复] 会话 ${session.id} ffmpeg 退出 (code=${code}), 文件: ${outputPath} (日志: ${ffmpegLogPath})`);

      try {
        await pool.query(`UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`, [
          session.room_id,
        ]);
        await this._delRoomCache(session.room_url);

        if (useSegment) {
          await this._handleSegmentSessionEnd(session.id, code);
        } else {
          await this._handleNonSegmentSessionEnd(session, outputPath, code);
        }

        const UploadService = require('../../services/UploadService');
        const completedSession = {
          id: session.id,
          room_url: session.room_url,
          room_name: session.room_name,
          started_at: session.started_at,
        };
        UploadService.findAndAutoUpload(completedSession).catch((err) =>
          console.error('[自动投稿] 异常:', err.message)
        );
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
    await this._delRoomCache(session.room_url);

    await this._setActiveTask(this._activeTaskKey(session.room_url), {
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

  /**
   * 生成文件名（带时间戳）
   *
   * @param {string} template - 文件名模板
   * @param {string} roomName - 房间名称
   * @param {string} ext - 文件扩展名
   * @returns {string} 生成的文件名
   */
  _generateFilename(template, roomName, ext = '.mp4') {
    const dayjs = require('dayjs');
    const now = dayjs();
    const sanitizeFilename = (name) => {
      return name
        .replace(/[\\/:\*\?"<>\|\x00-\x1F\x7F]/g, '')
        .replace(/\s+/g, '_')
        .replace(/^_+|_+$/g, '');
    };

    const vars = {
      room_name: sanitizeFilename(roomName || 'unknown'),
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
    return sanitizeFilename(result) + ext;
  }

  /**
   * 将模板转换为 strftime 格式
   *
   * @param {string} template - 文件名模板
   * @param {string} roomName - 房间名称
   * @param {string} ext - 文件扩展名
   * @returns {string} strftime 格式的路径
   */
  _templateToStrftime(template, roomName, ext = '.mp4') {
    const sanitizeFilename = (name) => {
      return name
        .replace(/[\\/:\*\?"<>\|\x00-\x1F\x7F]/g, '')
        .replace(/\s+/g, '_')
        .replace(/^_+|_+$/g, '');
    };

    const roomNameSafe = sanitizeFilename(roomName || 'unknown').replace(/%/g, '%%');
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

  /**
   * Redis key 生成器 - 房间缓存
   *
   * @param {string} roomUrl - 房间URL
   * @returns {string} Redis key
   */
  _redisKey(roomUrl) {
    return `room:${roomUrl}`;
  }

  /**
   * Redis key 生成器 - 活跃任务
   *
   * @param {string} roomKey - 房间唯一标识
   * @returns {string} Redis key
   */
  _activeTaskKey(roomKey) {
    return `active_task:${roomKey}`;
  }

  /**
   * 删除活跃任务
   *
   * @param {string} roomKey - 房间唯一标识
   */
  async _delActiveTask(roomKey) {
    try {
      await redis.del(this._activeTaskKey(roomKey));
    } catch (_) {}
  }

  /**
   * 设置活跃任务
   *
   * @param {string} roomKey - 房间唯一标识
   * @param {Object} data - 任务数据
   */
  async _setActiveTask(roomKey, data) {
    try {
      await redis.setEx(this._activeTaskKey(roomKey), 86400, JSON.stringify(data));
    } catch (_) {}
  }

  /**
   * 删除房间缓存
   *
   * @param {string} roomUrl - 房间URL
   */
  async _delRoomCache(roomUrl) {
    try {
      await redis.del(this._redisKey(roomUrl));
    } catch (_) {}
  }

  /**
   * 处理分段录制会话结束
   *
   * @param {string|number} sessionId - 会话ID
   * @param {number} exitCode - 进程退出码
   */
  async _handleSegmentSessionEnd(sessionId, exitCode) {
    let totalSegments = 0;
    let totalSize = 0;

    const sessionFiles = await pool.query(
      "SELECT file_path, file_size FROM recording_files WHERE session_id = $1 AND status = 'completed'",
      [sessionId]
    );

    for (const row of sessionFiles.rows) {
      const filePath = row.file_path;
      let fileSize = row.file_size;

      if (fileSize === 0) {
        try {
          const stat = fs.statSync(filePath);
          fileSize = stat.size;

          await pool.query('UPDATE recording_files SET file_size = $1 WHERE file_path = $2', [fileSize, filePath]);
          await pool.query('UPDATE recordings SET file_size = $1 WHERE file_path = $2', [fileSize, filePath]);
        } catch (_) {
          continue;
        }
      }

      if (fileSize > 0) {
        totalSegments++;
        totalSize += fileSize;
      }
    }

    if (totalSegments > 0) {
      await pool.query(
        `UPDATE recording_sessions SET total_segments = total_segments + $1, total_size = total_size + $2 WHERE id = $3`,
        [totalSegments, totalSize, sessionId]
      );
    }

    let sessionStatus = 'completed';
    if (totalSegments === 0 && exitCode !== 0) {
      sessionStatus = 'interrupted';
    }

    await pool.query(`UPDATE recording_sessions SET ended_at = NOW(), status = $1 WHERE id = $2`, [
      sessionStatus,
      sessionId,
    ]);
  }

  /**
   * 处理非分段录制会话结束
   *
   * @param {Object} session - 会话信息
   * @param {string} outputPath - 输出文件路径
   * @param {number} exitCode - 进程退出码
   */
  async _handleNonSegmentSessionEnd(session, outputPath, exitCode) {
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

    let sessionStatus = 'completed';
    if (fileSize === 0 && exitCode !== 0) {
      sessionStatus = 'interrupted';
    }

    await pool.query(
      `UPDATE recording_sessions SET ended_at = NOW(), status = $1, total_segments = 1, total_size = $2 WHERE id = $3`,
      [sessionStatus, fileSize, session.id]
    );

    if (SUPPORTED_TRANSCODE_EXT.test(outputPath)) {
      try {
        const RecorderService = require('../../services/RecorderService');
        const autoTranscode = await RecorderService.getSetting('auto_transcode', 'true');
        if (autoTranscode === 'true') {
          const mp4Path = outputPath.replace(SUPPORTED_TRANSCODE_EXT, '.mp4');
          transcodeQueue
            .enqueue({
              flvPath: outputPath,
              mp4Path: mp4Path,
              sessionId: session.id,
            })
            .catch((err) => console.error('[恢复][转码队列] 入队异常:', err.message));
        }
      } catch (transcodeErr) {
        console.error('[恢复] 快速转码异常:', transcodeErr.message);
      }
    }
  }

  /**
   * 写入录制文件记录
   * @param {*} sessionId
   * @param {*} filePath
   * @param {*} status 文件状态 'recording' / 'completed' / `interrupted`
   */
  async addRecordingRecord(sessionId, filePath, status = 'recording') {
    // 根据 sessionId 查询到关联的 room 和 session 数据
    const { rows: rooms } = await pool.query(
      `SELECT 
          r.id AS room_id, 
          r.room_url, 
          r.room_name, 
          r.output_path,
          rs.id AS session_id
      FROM rooms r
      JOIN recording_sessions rs ON rs.room_url = r.room_url
      WHERE rs.id = $1;`,
      [sessionId]
    );
    const room = rooms[0];
    // 插入记录到 recordings 表，若冲突则忽略
    const ins = await pool.query(
      `INSERT INTO recordings (session_id, room_url, file_path, started_at, ended_at, status)
        VALUES ($1, $2, $3, NOW(), NOW(), $4)
        ON CONFLICT (file_path) DO NOTHING
        RETURNING id`,
      [room.session_id, room.room_url, filePath, status]
    );

    // 若插入失败（可能因并发导致冲突），则跳过后续处理
    if (ins.rows.length === 0) {
      console.log('[DB][recordings] 插入失败，可能因并发导致冲突');
    } else {
      console.log(`[DB][recordings] 插入成功：session_id=${room.session_id}, file_path=${filePath}`);
    }

    // 修改 recording_files 的插入逻辑
    try {
      const f = path.basename(filePath);
      // 执行插入并返回被修改的行，或者通过 RETURNING 检查状态
      const insRes = await pool.query(
        `INSERT INTO recording_files (session_id, room_url, file_path, file_name, status, started_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (file_path) 
     DO UPDATE SET status = EXCLUDED.status -- 如果冲突，更新状态看看？
     RETURNING *`, // 增加 RETURNING * 看看到底发生了什么
        [room.session_id, room.room_url, filePath, f, status]
      );

      if (insRes.rows.length > 0) {
        console.log('[DB][recordings_files] 插入或更新成功');
      }
    } catch (err) {
      console.log('[DB][recordings_files] 插入失败，错误详情:', err);
    }
  }
}

module.exports = new RecordingManager();
