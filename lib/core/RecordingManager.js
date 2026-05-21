const path = require('path');
const fs = require('fs');
const { SUPPORTED_TRANSCODE_EXT } = require('../../config/config');
const pool = require('../../db/index');
const redis = require('../../db/redis');
const { generateOutputPath } = require('../utils/tool');
const { createProcLog } = require('../utils/proc-log');
const transcodeQueue = require('./TranscodeQueue');
const segmenter = require('./segmenter');
const { getActiveDownloader } = require('./downloaders/DownloaderFactory');
const DataService = require('../../services/DataService');

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
   * 启动视频切割+转码任务
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
   * 将录制文件添加到转码队列
   *
   * 该方法会检查文件格式是否支持转码（flv或ts），并验证自动转码功能是否启用。
   * 如果条件满足，则生成对应的MP4输出路径，并将转码任务加入队列进行异步处理。
   *
   * @param {string} sessionId - 录制会话ID，用于标识和追踪转码任务
   * @param {string} filePath - 录制文件的完整路径，需要是flv或ts格式
   * @returns {Promise<void>} 无返回值，异常会在内部捕获并记录日志
   */
  async addTranscodeQueue(sessionId, filePath) {
    const autoTranscode = await DataService.getSetting('auto_transcode', 'true');
    // 仅处理支持转码的文件格式（flv或ts）
    if (SUPPORTED_TRANSCODE_EXT.test(filePath)) {
      if (autoTranscode === 'true') {
        // 生成对应的MP4输出路径
        const mp4Path = filePath.replace(SUPPORTED_TRANSCODE_EXT, '.mp4');
        transcodeQueue
          .enqueue({
            videoPathToTrans: filePath,
            mp4Path: mp4Path,
            sessionId: sessionId,
          })
          .catch((err) => console.error('[转码队列] 入队异常:', err.message));
      }
    }
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
   * 更新会话的输出路径
   *
   * @param {string|number} sessionId - 会话ID
   * @param {string} outputPath - 输出路径
   */
  async updateSessionOutputPath(sessionId, outputPath) {
    await pool.query(
      `UPDATE recording_sessions 
       SET output_path = $1, output_dir = $2 
       WHERE id = $3`,
      [outputPath, path.dirname(outputPath), sessionId]
    );
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

  /**
   * 创建录制中的新会话或复用会话
   * @param {*} param0
   * @returns
   */
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
        [room.room_url, sessionStart, outputPath ? path.dirname(outputPath) : null, caption || '', streamUrl]
      );
      finalSessionId = session.rows[0].id;
    }

    return finalSessionId;
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
   * @param {string} session.caption - 备注信息
   * @param {string} session.polling_platform - 直播平台
   * @returns {Promise<void>}
   */
  async resumeSession(sessionId) {
    if (!this.DOWNLOAD_DIR) {
      throw new Error('VIDEO_DOWNLOAD_DIR 未设置');
    }

    const session = await DataService.getSession(sessionId);
    const room = await DataService.getRoomByUrl(session.room_url);

    // 1. 准备参数
    const downloader = getActiveDownloader(room.polling_platform);
    const outputPath = generateOutputPath(
      downloader,
      room.filename_template,
      room.room_name,
      session.caption,
      room.segment_duration
    );

    // 2. 复用底层启动函数
    const { process: ffmpeg, logStream } = this.startRecordingProcess({
      downloader,
      streamUrl: session.stream_url,
      outputPath,
      options: { segmentDuration: session.segment_duration || 0 },
      sessionId: session.id,
    });

    if (ffmpeg.stderr) {
      ffmpeg.stderr.on('data', (chunk) => logStream.write(chunk));
    }
    if (ffmpeg.stdout) {
      ffmpeg.stdout.on('data', (chunk) => logStream.write(chunk));
    }

    // 3. 处理后续业务逻辑（原来的 close 回调）
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
      } catch (dbErr) {
        console.error(`[恢复] 会话 ${session.id} 结束处理失败:`, dbErr.message);
      }
    });

    // 保证录制进程有启动
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

    this.addTranscodeQueue(session.id, outputPath);
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
