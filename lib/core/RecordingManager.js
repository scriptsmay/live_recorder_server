const path = require('path');
const { SUPPORTED_TRANSCODE_EXT } = require('../../config/config');
const pool = require('../../db/index');
const redis = require('../../db/redis');
const { createProcLog } = require('../utils/proc-log');
const transcodeQueue = require('./TranscodeQueue');
const segmenter = require('./segmenter');
const DataService = require('../../services/DataService');

const SEGMENT_TRACKER_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟无心跳则强制清理

/**
 * 录制管理器 - 负责 ffmpeg 外部调用的业务逻辑
 *
 * 主要职责：
 * 1. 管理录制进程的启动、监控和结束
 * 2. 处理分段录制的切片任务
 * 3. 管理录制会话的生命周期
 * 4. 处理录制完成后的文件转码和上传触发
 * 5. 追踪分段文件的时间信息
 */
class RecordingManager {
  constructor() {
    this.DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR;
    // 分段时间追踪器
    this.activeSegments = new Map();
    // 启动心跳超时清理
    this._startTrackerCleanup();
  }

  /**
   * 注册会话的分段追踪
   * @param {number} sessionId
   * @param {number} sessionStartMs - Date.now() 时间戳
   */
  registerSession(sessionId, sessionStartMs) {
    this.activeSegments.set(sessionId, {
      sessionStartMs,
      segments: [],
      lastHeartbeat: Date.now(),
    });
  }

  /**
   * 更新会话心跳（防止超时清理）
   * @param {number} sessionId
   */
  heartbeat(sessionId) {
    const tracker = this.activeSegments.get(sessionId);
    if (tracker) {
      tracker.lastHeartbeat = Date.now();
    }
  }

  /**
   * 记录分段文件创建
   * @param {number} sessionId
   * @param {string} filePath - 分段文件路径
   * @param {number} elapsedMs - 当前时间相对于会话开始的毫秒数
   */
  recordSegment(sessionId, filePath, elapsedMs) {
    const tracker = this.activeSegments.get(sessionId);
    if (!tracker) return;

    // 结束上一个分段
    if (tracker.segments.length > 0) {
      const lastSegment = tracker.segments[tracker.segments.length - 1];
      lastSegment.endMs = elapsedMs;
    }

    // 开始新分段
    tracker.segments.push({
      filePath,
      startMs: elapsedMs,
      endMs: null,
    });

    tracker.lastHeartbeat = Date.now();
  }

  /**
   * 结束会话，将所有分段的时间信息写入数据库
   * @param {number} sessionId
   * @param {object} pool - 数据库连接池
   * @returns {Promise<Array>} 写入成功的分段列表
   */
  async finalizeSession(sessionId, pool) {
    const tracker = this.activeSegments.get(sessionId);
    if (!tracker) return [];

    const segments = tracker.segments.map((seg) => ({
      ...seg,
      endMs: seg.endMs || null,
    }));

    // 在清理 tracker 之前写入数据库
    let totalAffected = 0;
    for (const seg of segments) {
      const result = await pool.query(
        `UPDATE recording_files
         SET segment_start_ms = $1, segment_end_ms = $2
         WHERE file_path = $3`,
        [seg.startMs, seg.endMs || 0, seg.filePath]
      );
      totalAffected += result.rowCount;
    }

    if (segments.length > 0) {
      console.log(
        `[RecordingManager] 分段时间写入: ${segments.length} 个分段, 匹配 ${totalAffected} 条记录`
      );
      if (totalAffected < segments.length) {
        console.warn(
          `[RecordingManager] ${segments.length - totalAffected} 个分段未匹配到 recording_files 记录，` +
          `将通过 segmentTimes 直接传递给 ASS 生成器`
        );
      }
    }

    // 清理 tracker
    this.activeSegments.delete(sessionId);
    return segments;
  }

  /**
   * 获取指定 session 的分段时间信息（供 watchdog 协同使用）
   * @param {number} sessionId
   * @param {string} filePath
   * @returns {{ startMs: number, endMs: number | null } | null}
   */
  getSegmentTime(sessionId, filePath) {
    const tracker = this.activeSegments.get(sessionId);
    if (!tracker) return null;
    return tracker.segments.find((s) => s.filePath === filePath) || null;
  }

  /**
   * 启动 tracker 超时清理（防止内存泄漏）
   * @private
   */
  _startTrackerCleanup() {
    setInterval(
      () => {
        const now = Date.now();
        for (const [sessionId, tracker] of this.activeSegments.entries()) {
          if (now - tracker.lastHeartbeat > SEGMENT_TRACKER_TIMEOUT_MS) {
            console.warn(`[RecordingManager] Tracker for session ${sessionId} timed out, cleaning up`);
            this.activeSegments.delete(sessionId);
          }
        }
      },
      5 * 60 * 1000
    ); // 每 5 分钟检查一次
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
    if (autoTranscode !== 'true') {
      console.log(`自动转码已禁用，跳过转码任务，源文件: ${filePath}`);
      return;
    }
    // 仅处理支持转码的文件格式（flv或ts）
    if (SUPPORTED_TRANSCODE_EXT.test(filePath)) {
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
      streamType: options.streamType,
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
   * 优雅停止录制进程
   * 先发 SIGTERM，超时后发 SIGKILL
   */
  stopRecordingProcess(dlProcess, timeoutMs = 10000) {
    if (!dlProcess || dlProcess.killed || dlProcess.exitCode !== null) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const forceKillTimer = setTimeout(() => {
        console.warn(`[RecordingManager] FFmpeg (PID:${dlProcess.pid}) 未响应 SIGTERM，强制终止`);
        try {
          dlProcess.kill('SIGKILL');
        } catch (_) {}
      }, timeoutMs);

      dlProcess.once('exit', () => {
        clearTimeout(forceKillTimer);
        resolve();
      });

      try {
        dlProcess.kill('SIGTERM');
      } catch (_) {
        clearTimeout(forceKillTimer);
        resolve();
      }
    });
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
   * 通过调用 RecorderService.startRoomRecording() 复用完整的录制流程。
   * 适用于手动恢复已中断的录制会话（延迟窗口外）或启动时恢复遗留会话。
   *
   * @param {string|number} sessionId - 要恢复的会话ID
   * @returns {Promise<Object>} 录制结果
   */
  async resumeSession(sessionId) {
    if (!this.DOWNLOAD_DIR) {
      throw new Error('VIDEO_DOWNLOAD_DIR 未设置');
    }

    const session = await DataService.getSession(sessionId);
    if (!session) {
      throw new Error(`会话 ${sessionId} 不存在`);
    }

    const room = await DataService.getRoomByUrl(session.room_url);
    if (!room) {
      throw new Error(`直播间 ${session.room_url} 不存在`);
    }

    if (!session.stream_url) {
      throw new Error(`会话 ${sessionId} 缺少直播流地址，无法恢复`);
    }

    console.log(`[恢复会话] 尝试恢复会话 ${sessionId} (直播间: ${room.room_name || room.room_url})`);

    const RecorderService = require('../../services/RecorderService');

    const result = await RecorderService.startRoomRecording({
      roomId: room.id,
      caption: session.caption,
      url: session.stream_url,
      resumeSessionId: sessionId,
    });

    if (result.error) {
      console.error(`[恢复会话] 恢复失败: ${result.message}`);
      throw new Error(result.message);
    }

    console.log(`[恢复会话] 会话 ${sessionId} 已恢复，录制中`);
    return result;
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
}

module.exports = new RecordingManager();
