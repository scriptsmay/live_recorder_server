const path = require('path');
const fs = require('fs');
const pool = require('../db/index');
const redis = require('../db/redis');

const { generateOutputPath } = require('../lib/utils/tool');
const { getActiveDownloader } = require('../lib/core/downloaders/DownloaderFactory');
const recordingManager = require('../lib/core/RecordingManager');
const notify = require('../lib/core/notify');
const DataService = require('./DataService');
const RecordingManager = require('../lib/core/RecordingManager');

const DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR;
const ROOM_CACHE_TTL = 300;
const ACTIVE_TASK_TTL = 86400;

/**
 * 录制服务 - 负责直播间录制的业务逻辑协调
 *
 * 主要职责：
 * 1. 管理房间状态和缓存
 * 2. 处理录制请求的验证和权限检查
 * 3. 协调录制进程的启动和结束
 * 4. 管理录制会话的生命周期
 * 5. 触发文件处理和自动上传
 */
class RecorderService {
  /**
   * 生成 Redis 房间缓存键
   *
   * @param {string} roomUrl - 房间URL
   * @returns {string} Redis key
   */
  static redisKey(roomUrl) {
    return `room:${roomUrl}`;
  }

  /**
   * 生成 Redis 活跃任务键
   *
   * @param {string} roomKey - 房间唯一标识
   * @returns {string} Redis key
   */
  static activeTaskKey(roomKey) {
    return `active_task:${roomKey}`;
  }

  /**
   * 获取房间缓存
   *
   * @param {string} roomUrl - 房间URL
   * @returns {Promise<Object|null>} 房间信息对象或 null
   */
  static async getRoomCache(roomUrl) {
    try {
      const data = await redis.get(this.redisKey(roomUrl));
      if (data) return JSON.parse(data);
    } catch (_) {}
    return null;
  }

  /**
   * 设置房间缓存
   *
   * @param {Object} room - 房间信息对象
   */
  static async setRoomCache(room) {
    try {
      await redis.setEx(this.redisKey(room.room_url), ROOM_CACHE_TTL, JSON.stringify(room));
    } catch (_) {}
  }

  /**
   * 删除房间缓存
   *
   * @param {string} roomUrl - 房间URL
   */
  static async delRoomCache(roomUrl) {
    try {
      await redis.del(this.redisKey(roomUrl));
    } catch (_) {}
  }

  /**
   * 检查是否存在活跃任务
   *
   * @param {string} roomKey - 房间唯一标识
   * @returns {Promise<boolean>} 是否存在活跃任务
   */
  static async isActiveTask(roomKey) {
    try {
      const exists = await redis.exists(this.activeTaskKey(roomKey));
      return exists === 1;
    } catch (_) {
      return false;
    }
  }

  /**
   * 设置活跃任务
   *
   * @param {string} roomKey - 房间唯一标识
   * @param {Object} data - 任务数据
   */
  static async setActiveTask(roomKey, data) {
    try {
      await redis.setEx(this.activeTaskKey(roomKey), ACTIVE_TASK_TTL, JSON.stringify(data));
    } catch (_) {}
  }

  /**
   * 删除活跃任务
   *
   * @param {string} roomKey - 房间唯一标识
   */
  static async delActiveTask(roomKey) {
    try {
      await redis.del(this.activeTaskKey(roomKey));
    } catch (_) {}
  }

  /**
   * 获取或创建房间记录
   *
   * @param {string} roomUrl - 房间URL
   * @param {string} roomName - 房间名称
   * @returns {Promise<Object>} 房间信息对象
   */
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

  /**
   * 获取线程池大小配置
   *
   * @returns {Promise<number>} 线程池大小
   */
  static async getPoolSize() {
    const value = await DataService.getSetting('pool_size', '3');
    return parseInt(value, 10) || 3;
  }

  /**
   * 获取当前活跃任务数量
   *
   * @returns {Promise<number>} 活跃任务数量
   */
  static async getActiveTasksCount() {
    try {
      const keys = await redis.keys('active_task:*');
      return keys.length;
    } catch (_) {
      return 0;
    }
  }

  /**
   * 检查是否可以复用之前的录制会话（续播）
   *
   * @param {Object} room - 房间信息对象
   * @returns {Promise<Object>} 包含 reuseSession 和 resumeCount 的对象
   */
  static async checkReuseSession(room) {
    let reuseSession = false;
    let resumeCount = 0;
    let session = null;

    try {
      const delayValue = await DataService.getSetting('delay', '60');
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
            session = recent.rows[0];
            // 会话没有这个字段，所以把直播间的字段给会话
            session.polling_platform = room.polling_platform;
            console.log(`[续播] 复用会话 ${recent.rows[0].id} (上次结束在延迟窗口内)`);
          }
          redis.del(lockKey).catch(() => {});
        }
      }
    } catch (_) {}

    return { reuseSession, resumeCount, session };
  }

  /**
   * 完成录制会话的后续处理
   *
   * @param {Object} params - 处理参数
   * @param {number} params.code - 进程退出码
   * @param {string|number} params.sessionId - 会话ID
   * @param {boolean} params.reuseSession - 是否复用会话
   * @param {boolean} params.useSegment - 是否使用分段录制
   * @param {string} params.outputFilePattern - 输出文件路径模式
   * @param {string} params.roomKey - 房间唯一标识 room_url
   */
  static async finishSession({ code, sessionId }) {
    // 简化参数，几乎所有数据都可从数据库中查询到，需要保留 sessionId
    const session = await DataService.getSession(sessionId);
    const roomKey = session.room_url;
    const room = await DataService.getRoomByUrl(session.room_url);
    const sessionStart = session.started_at;
    const engine = getActiveDownloader(room.polling_platform);

    // 从会话中获取输出路径，避免生成新路径导致变量缺失问题
    const outputFilePattern = session.output_path || '[路径未知]';

    await this.delActiveTask(roomKey);
    console.log(
      `[finishSession][${code}] 录制结束，路径: ${outputFilePattern} (日志: logs/${engine.name}_${sessionId}.log)`
    );

    try {
      await pool.query(`UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`, [
        room.id,
      ]);
      await this.delRoomCache(room.room_url);

      // 如果录制时长很短（小于5秒），不设置冷却期，以便快速重试获取新的流地址
      const sessionDuration = Date.now() - sessionStart.getTime();
      if (sessionDuration >= 5000) {
        // 设置录制冷却期（30秒），防止流地址失效导致频繁重启录制
        const cooldownKey = `polling:recording_cooldown:${room.id}`;
        await redis.set(cooldownKey, Date.now().toString(), { EX: 30 }).catch(() => {});
      } else {
        console.log(`[finishSession] 录制时长过短 (${sessionDuration}ms)，跳过冷却期，允许快速重试`);
        // 记录录制结束时间，供 PollingManager 检测是否需要立即重试
        const lastEndKey = `polling:last_recording_end:${room.id}`;
        await redis.set(lastEndKey, Date.now().toString(), { EX: 10 }).catch(() => {});
      }

      // 会话结束后启动转码任务、整理数据库各项状态
      const { fileSize, fileCount } = await this._handleSessionFinish({
        sessionId,
        code,
      });

      if (sessionId) {
        try {
          const sess = await pool.query(
            'SELECT status, total_segments, total_size FROM recording_sessions WHERE id = $1',
            [sessionId]
          );
          const segs = fileCount || 0;
          const mb = ((fileSize || 0) / 1024 / 1024).toFixed(1);
          const status = sess.rows[0]?.status || 'completed';
          notify.recordingComplete(room.room_name, segs, mb, sessionId, room.room_url, status);
        } catch (_) {}
      }
    } catch (dbErr) {
      console.error('[RecorderService] 录制结束数据库更新失败:', dbErr);
    }
  }

  /**
   * 处理会话录制结束的业务逻辑
   *
   * @param {Object} params - 处理参数
   * @param {string|number} params.sessionId - 会话ID
   * @param {number} params.code - 进程退出码
   *
   * @returns {Promise<{fileSize: number, fileCount: number}>} - 文件大小和文件数量
   */
  static async _handleSessionFinish({ sessionId, code }) {
    const thresholdValue = await DataService.getSetting('filtering_threshold', '10');
    const thresholdBytes = (parseInt(thresholdValue, 10) || 10) * 1024 * 1024;

    let fileSize = 0;
    let fileExists = false;
    let fileCount = 0;
    try {
      const recordingFiles = await DataService.getRecordingFiles({ sessionId });

      for (const file of recordingFiles) {
        const stat = fs.statSync(file.file_path);
        if (stat.size < thresholdBytes) {
          try {
            fs.unlinkSync(file.file_path);
            console.log(
              `[finishSession] 碎片文件已删除: ${path.basename(file.file_path)} (${(stat.size / 1024 / 1024).toFixed(1)}MB < ${thresholdValue}MB)`
            );
          } catch (err) {
            console.error(`[finishSession] 删除碎片文件失败: ${file.file_path}`, err.message);
          }
          continue;
        }
        fileCount++;
        fileSize += stat.size;
        fileExists = true;

        // 有文件，更新数据库记录
        await pool.query("UPDATE recordings SET file_size = $1, ended_at = NOW(), status = 'completed' WHERE id = $2", [
          stat.size,
          file.id,
        ]);
        // 更新文件记录
        await pool.query(
          `UPDATE recording_files SET file_size = $1, status = 'completed', completed_at = NOW()
           WHERE session_id = $2 AND file_path = $3`,
          [stat.size, sessionId, file.file_path]
        );

        // 加入自动转码队列
        RecordingManager.addTranscodeQueue(sessionId, file.file_path);
      }
    } catch (statErr) {
      console.warn(`[RecorderService] [会话${sessionId}] 无法获取文件大小`, statErr.message);
    }

    if (sessionId) {
      let sessionStatus = 'completed';
      if (fileSize === 0 && code !== 0) {
        sessionStatus = 'interrupted';
      }

      await pool.query(
        `UPDATE recording_sessions
             SET ended_at = NOW(), status = $1,
                 total_segments = 1,
                 total_size = $2
             WHERE id = $3 AND status = 'recording'`,
        [sessionStatus, fileSize, sessionId]
      );
    }

    if (fileCount === 0) {
      console.log(`[RecorderService] 会话录制完成, 无有效文件`);
    } else {
      console.log(`[RecorderService] 会话录制完成, 共 ${fileCount} 个文件, ${(fileSize / 1024 / 1024).toFixed(1)}MB`);
    }

    return { fileSize, fileExists, fileCount };
  }

  /**
   * 启动录制任务，判断参数和前置条件
   *
   * @param {Object} params - 录制参数
   * @param {string} params.url - 直播流地址
   * @param {string} params.title - 直播标题
   * @param {string} params.caption - 备注信息
   * @param {string} params.room_url - 房间URL
   * @returns {Promise<Object>} 录制结果，包含错误信息和录制详情
   */
  static async startRecording({ url, title, caption, room_url }) {
    console.log('[RecorderService] 收到录制请求:', {
      title,
      room_url,
      url: url?.slice(0, 60),
      caption,
    });

    if (!url || !title || !room_url) {
      console.log('[RecorderService] 录制请求被拒: 缺少必填参数 (url/title/room_url)');
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

    const roomKey = room_url;

    if (await this.isActiveTask(roomKey)) {
      console.log('[RecorderService] 录制请求被拒: active_task 已存在 (roomKey=' + roomKey + ')');
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
      console.error('[RecorderService] 数据库操作失败:', dbErr);
      return { error: true, status: 200, code: 500, message: '数据库操作失败' };
    }

    if (room.monitoring_enabled === false) {
      console.log('[RecorderService] 录制请求被拒: monitoring_enabled=false (room=' + room.id + ')');
      return {
        error: true,
        status: 200,
        code: 400,
        status_str: 'Monitoring paused',
        message: `直播间 ${room.room_name || room.room_url} 已暂停监听`,
      };
    }

    if (room.status === 'recording' || room.status === 'paused') {
      console.log('[RecorderService] 录制请求被拒: 房间状态=' + room.status + ' (room=' + room.id + ')');
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

    return await this.startRoomRecording({ roomId: room.id, caption, url });
  }

  /**
   * 正式启动直播间录制流程
   * @param {Object} params - 录制参数
   * @param {string} params.roomId - 房间ID
   * @param {string} params.caption - 备注信息
   * @param {string} params.url - 直播流地址
   * @param {string} params.resumeSessionId - 恢复会话ID
   * @returns
   */
  static async startRoomRecording({ roomId, caption, url, resumeSessionId = null }) {
    const room = await DataService.getRoomById(roomId);
    const roomKey = room.room_url;
    console.log(`[任务启动] 直播间 ${roomKey} 开始录制${caption ? ' - ' + caption : ''}`);

    const downloader = getActiveDownloader(room.polling_platform);
    const template = room.filename_template || '{room_name}_{datetime}';
    const segmentDuration = room.segment_duration || 0;
    const useSegment = segmentDuration > 0 && downloader.isSegment();

    const sessionStart = new Date();

    // 先新增会话数据库，再启动录制进程
    try {
      let sessionId = null;
      let reuseSession = false;
      // 一、新增一个录制会话（先创建会话获取 sessionId）
      if (resumeSessionId) {
        console.log(`[任务启动] 恢复录制会话: ${resumeSessionId}`);
        sessionId = resumeSessionId;
        reuseSession = true;
      } else {
        const { reuseSession: resultReuseSession, resumeCount } = await this.checkReuseSession(room);
        reuseSession = resultReuseSession;
        // 创建会话时还没有输出路径，先传空路径，后续更新
        sessionId = await recordingManager.createSession({
          room,
          outputPath: null,
          sessionId: null,
          sessionStart,
          reuseSession,
          resumeCount,
          caption,
          streamUrl: url,
        });
        console.log(`[任务启动] 录制会话: ${sessionId}`);
      }

      // 二、使用 roomId 和 sessionId 生成带层级的输出路径
      const outputFilePattern = generateOutputPath(
        downloader,
        template,
        room.room_name,
        '',
        segmentDuration,
        null,
        room.id,
        sessionId
      );

      // 创建会话目录
      const sessionDir = require('path').dirname(outputFilePattern);
      if (!require('fs').existsSync(sessionDir)) {
        require('fs').mkdirSync(sessionDir, { recursive: true });
        console.log(`[任务启动] 创建会话目录: ${sessionDir}`);
      }

      console.log(`[任务启动] 文件名模板: ${template}`);
      console.log(`[任务启动] 分段录制: ${useSegment ? segmentDuration + 's' : '关闭'}`);
      console.log(`[任务启动] 视频将保存至: ${outputFilePattern}`);

      // 三、更新会话的输出路径
      await recordingManager.updateSessionOutputPath(sessionId, outputFilePattern);

      // 四、然后启动下载器模块的录制进程
      const { process: dlProcess, logPath } = recordingManager.startRecordingProcess({
        downloader,
        streamUrl: url,
        outputPath: outputFilePattern,
        options: {
          segmentDuration,
          platform: room.polling_platform,
          isStreamUrl: true,
        },
        sessionId,
      });
      console.log(`[任务启动] 输出文件路径: ${outputFilePattern} | PID: ${dlProcess.pid}`);

      // 五、再去更新 session.pid
      await recordingManager.updateSessionPidToDatabase({
        roomId: room.id,
        sessionId,
        pid: dlProcess.pid,
      });

      console.log(`[任务启动] 日志文件: ${logPath} `);

      // 更新 redis 缓存
      await this.setActiveTask(roomKey, {
        pid: dlProcess.pid,
        outputPath: outputFilePattern,
        roomId: room.id,
        sessionId,
        startTime: sessionStart,
        downloader: downloader.name,
      });

      const finishSessionWrapper = async (code, signal) => {
        if (code !== 0) {
          console.error(`FFmpeg 下载失败，退出码: ${code}, 信号: ${signal}`);
        } else {
          console.log('FFmpeg 下载完成');
        }
        await this.finishSession({
          code,
          sessionId,
        });
      };

      dlProcess.on('close', finishSessionWrapper);

      notify.recordingStart(room.room_name || title, caption, room.room_url);

      return {
        error: false,
        room,
        sessionId,
        outputFilePattern,
      };
    } catch (dbErr) {
      console.error('[RecorderService] 更新数据库状态失败:', dbErr);
      // dlProcess.kill();
      return { error: true, status: 500, code: 500, message: '更新数据库状态失败' };
    }
  }

  // static async resumeSession(sessionId) {
  //   const session = await DataService.getSession(sessionId);
  //   const room = await DataService.getRoomByUrl(session.room_url);

  //   const result = await this.startRoomRecording({
  //     roomId: room.id,
  //     caption: session.caption,
  //     url: session.stream_url,
  //   });
  //   if (result.error) {
  //     console.log(`[重启会话] 恢复录制失败: ${result.message}`);
  //   }
  // }

  // /**
  //  * 获取最大恢复重试次数配置
  //  *
  //  * @returns {Promise<number>} 最大重试次数
  //  */
  // static async getMaxResumeRetries() {
  //   const maxResumeRetries = await DataService.getSetting('max_resume_retries', 3);
  //   return parseInt(maxResumeRetries, 10) || 3;
  // }

  /**
   * 清理陈旧的录制任务和会话
   *
   * 该函数用于处理系统异常重启或崩溃后遗留的录制状态，主要执行以下操作：
   * 1. 查找所有状态为 'recording' 或 'paused' 的直播间房间
   *    - 终止相关的 ffmpeg 进程（如果存在）
   *    - 将房间状态重置为 'idle'
   * 2. 查找所有状态为 'recording' 的录制会话
   *    - 如果重试次数未达上限，尝试恢复会话
   *    - 如果恢复失败或重试次数已达上限，将会话和文件状态标记为 'interrupted'
   */
  static async cleanupStaleRecordings() {
    // const MAX_RESUME_RETRIES = await this.getMaxResumeRetries();
    try {
      const staleRooms = await pool.query(
        `SELECT id, room_url, room_name, ffmpeg_pid, polling_platform, output_path FROM rooms WHERE status IN ('recording', 'paused')`
      );

      for (const row of staleRooms.rows) {
        // 优先尝试续播
        const { reuseSession } = await this.checkReuseSession(row);
        if (reuseSession) {
          // 将状态标记为 'interrupted'
          await pool.query(`UPDATE recording_sessions SET status = 'interrupted', updated_at = NOW() WHERE id = `, $0);
        }

        if (row.ffmpeg_pid) {
          // 如果 ffmpeg 进程存在，就暂时不处理，等它自然退出试试
          console.log(`[清理] 提示，存在一个 ffmpeg 进程 (${row.ffmpeg_pid}) 正在运行，尝试停止它...`);
          try {
            process.kill(row.ffmpeg_pid, 'SIGTERM');
          } catch (_) {}
        }
        console.log(`[清理] 直播间 ${row.room_name || row.room_url} (ID:${row.id}) 状态已重置为 idle`);
        await pool.query(`UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`, [
          row.id,
        ]);
      }

      // TODO： 待验证 - 跳过处理会话
      // 录制中状态的会话
      const staleSessions = await pool.query(
        `SELECT rs.*, r.id as room_id, r.room_name, r.polling_platform FROM recording_sessions rs JOIN rooms r ON rs.room_url = r.room_url WHERE rs.status = 'recording'`
      );

      for (const session of staleSessions.rows) {
        // if ((session.retry_count || 0) < MAX_RESUME_RETRIES) {
        //   try {
        //     console.log(`[恢复] 尝试恢复会话 ${session.id} (直播间: ${session.room_url})`);
        //     await recordingManager.resumeSession(session);
        //     continue;
        //   } catch (err) {
        //     console.error(`[恢复] 会话 ${session.id} 恢复失败:`, err.message);
        //   }
        // }
        // // 跳过恢复会话
        // // 如果当前时间

        console.log(`[清理] 会话 ${session.id} 状态已标记为 interrupted`);
        await pool.query(`UPDATE recording_sessions SET ended_at = NOW(), status = 'interrupted' WHERE id = $1`, [
          session.id,
        ]);
        await pool.query(
          `UPDATE recording_files SET status = 'interrupted', completed_at = NOW()
           WHERE session_id = $1 AND status = 'recording'`,
          [session.id]
        );
      }
    } catch (err) {
      console.error('[启动清理] 失败:', err);
    }
  }
}

module.exports = RecorderService;
