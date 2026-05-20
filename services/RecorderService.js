const path = require('path');
const fs = require('fs');
const pool = require('../db/index');
const redis = require('../db/redis');
const { SUPPORTED_TRANSCODE_EXT } = require('../config/config');

const { templateToStrftime, generateFilename } = require('../lib/utils/tool');

const { getActiveDownloader } = require('../lib/core/downloaders/DownloaderFactory');
const recordingManager = require('../lib/core/RecordingManager');
const notify = require('../lib/core/notify');
const transcodeQueue = require('../lib/core/TranscodeQueue');
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
   * 清理文件名中的非法字符
   *
   * @param {string} name - 原始文件名
   * @returns {string} 清理后的文件名
   */
  static sanitizeFilename(name) {
    return name
      .replace(/[\\/:\*\?"<>\|\x00-\x1F\x7F]/g, '')
      .replace(/\s+/g, '_')
      .replace(/^_+|_+$/g, '');
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
   * 获取系统设置值
   *
   * @param {string} key - 设置键名
   * @param {string} defaultValue - 默认值
   * @returns {Promise<string>} 设置值或默认值
   */
  static async getSetting(key, defaultValue) {
    try {
      const ps = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
      if (ps.rows.length) {
        return ps.rows[0].value;
      }
    } catch (_) {}
    return defaultValue;
  }

  /**
   * 获取线程池大小配置
   *
   * @returns {Promise<number>} 线程池大小
   */
  static async getPoolSize() {
    const value = await this.getSetting('pool_size', '3');
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
            session = recent.rows[0];
            console.log(`[续播] 复用会话 ${recent.rows[0].id} (上次结束在延迟窗口内)`);
          }
          redis.del(lockKey).catch(() => {});
        }
      }
    } catch (_) {}

    return { reuseSession, resumeCount, session };
  }

  /**
   * 生成输出文件路径
   *
   * @param {Object} downloader - 下载器实例
   * @param {string} template - 文件名模板
   * @param {string} roomName - 房间名称
   * @param {string} title - 直播标题
   * @param {number} segmentDuration - 分段时长（秒）
   * @param {boolean} _reuseSession - 是否复用会话（预留参数）
   * @param {string} _roomOutputPath - 房间输出路径（预留参数）
   * @returns {string} 输出文件路径
   */
  static generateOutputPath(downloader, template, roomName, title, segmentDuration, _reuseSession, _roomOutputPath) {
    // useSegment 代表的是输出文件名是否会随时间变量变化
    // 有的下载器不支持分段下载， useSegment 为 false
    const useSegment = segmentDuration > 0 && downloader.isSegment();
    const ext = downloader.getExtension();

    let outputFilePattern;

    if (useSegment) {
      // 如果需要切片，则输出文件名使用ffmpeg segements 模板
      const strftimeName = templateToStrftime(template, roomName || title, ext);
      outputFilePattern = path.join(DOWNLOAD_DIR, strftimeName);
    } else {
      // 如果不切片，则使用 generateFilename 方法生成固定的文件名
      const filename = generateFilename(template, roomName || title, ext);
      outputFilePattern = path.join(DOWNLOAD_DIR, filename);
    }

    return outputFilePattern;
  }

  /**
   * 完成录制会话的后续处理
   *
   * @param {Object} params - 处理参数
   * @param {number} params.code - 进程退出码
   * @param {Object} params.engine - 下载器引擎实例
   * @param {Object} params.room - 房间信息对象
   * @param {string|number} params.sessionId - 会话ID
   * @param {Date} params.sessionStart - 会话开始时间
   * @param {boolean} params.reuseSession - 是否复用会话
   * @param {boolean} params.useSegment - 是否使用分段录制
   * @param {string} params.outputFilePattern - 输出文件路径模式
   * @param {string} params.roomKey - 房间唯一标识
   */
  static async finishSession({
    code,
    engine,
    room,
    sessionId,
    sessionStart,
    reuseSession,
    useSegment,
    outputFilePattern,
    roomKey,
  }) {
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

      if (useSegment) {
        await this._handleSegmentFinish({
          engine,
          room,
          sessionId,
          sessionStart,
          reuseSession,
          outputFilePattern,
        });
      } else {
        await this._handleNonSegmentFinish({
          room,
          sessionId,
          sessionStart,
          reuseSession,
          outputFilePattern,
          code,
        });
      }

      if (sessionId) {
        try {
          const sess = await pool.query(
            'SELECT status, total_segments, total_size FROM recording_sessions WHERE id = $1',
            [sessionId]
          );
          const segs = sess.rows[0]?.total_segments || 0;
          const mb = ((sess.rows[0]?.total_size || 0) / 1024 / 1024).toFixed(1);
          const status = sess.rows[0]?.status || 'completed';
          notify.recordingComplete(room.room_name, segs, mb, sessionId, room.room_url, status);
        } catch (_) {}
      }
    } catch (dbErr) {
      console.error('[RecorderService] 录制结束数据库更新失败:', dbErr);
    }
  }

  /**
   * 处理分段录制结束的逻辑
   *
   * @param {Object} params - 处理参数
   * @param {Object} params.engine - 下载器引擎实例
   * @param {Object} params.room - 房间信息对象
   * @param {string|number} params.sessionId - 会话ID
   * @param {Date} params.sessionStart - 会话开始时间
   * @param {boolean} params.reuseSession - 是否复用会话
   * @param {string} params.outputFilePattern - 输出文件路径模式
   */
  static async _handleSegmentFinish({ engine, room, sessionId, _sessionStart, reuseSession, outputFilePattern }) {
    const isEngineSegment = engine.isSegment();
    if (!isEngineSegment) {
      // 下载器不支持分段，则加入额外的切片处理
      const result = await recordingManager.startSegmentTask({
        inputFile: room.output_path,
        outputFilePattern,
        roomKey: room.room_url,
        segmentDuration: room.segment_duration || 0,
      });

      console.log(`[_handleSegmentFinish] 录制完成，处理切片结果: ${result}`);
    }

    const thresholdValue = await this.getSetting('filtering_threshold', '10');
    const thresholdBytes = (parseInt(thresholdValue, 10) || 10) * 1024 * 1024;
    let totalSize = 0;
    let newFileCount = 0;

    const flvFilesToTranscode = [];

    const sessionFiles = await pool.query(
      "SELECT file_path, file_size FROM recording_files WHERE session_id = $1 AND status = 'completed'",
      [sessionId]
    );

    for (const row of sessionFiles.rows) {
      const filePath = row.file_path;
      let fileSize = row.file_size;

      if (fileSize === 0) {
        try {
          fileSize = fs.statSync(filePath).size;
        } catch (_) {}
      }

      if (fileSize > 0 && fileSize < thresholdBytes) {
        try {
          fs.unlinkSync(filePath);
          console.log(
            `[finishSession] 碎片文件已删除: ${path.basename(filePath)} (${(fileSize / 1024 / 1024).toFixed(1)}MB < ${thresholdValue}MB)`
          );

          await pool.query('DELETE FROM recording_files WHERE file_path = $1', [filePath]);
          await pool.query('DELETE FROM recordings WHERE file_path = $1', [filePath]);
        } catch (err) {
          console.error(`[finishSession] 删除碎片文件失败: ${filePath}`, err.message);
        }
        continue;
      }

      if (fileSize > 0) {
        totalSize += fileSize;

        await pool.query(
          "UPDATE recordings SET file_size = $1, ended_at = NOW(), status = 'completed' WHERE file_path = $2",
          [fileSize, filePath]
        );

        newFileCount++;

        if (fileSize >= thresholdBytes && filePath.endsWith('.flv')) {
          flvFilesToTranscode.push(filePath);
        }
      }
    }

    if (sessionId) {
      let sessionStatus = 'completed';
      if (newFileCount === 0 && code !== 0) {
        sessionStatus = 'interrupted';
      }

      if (reuseSession) {
        await pool.query(
          `UPDATE recording_sessions
           SET ended_at = NOW(), status = $1,
               total_segments = total_segments + $2,
               total_size = total_size + $3
           WHERE id = $4 AND status = 'recording'`,
          [sessionStatus, newFileCount, totalSize, sessionId]
        );
        if (sessionStatus === 'interrupted') {
          const accumulated = await pool.query(
            'SELECT total_segments, total_size FROM recording_sessions WHERE id = $1',
            [sessionId]
          );
          if ((accumulated.rows[0]?.total_segments || 0) > 0 || (accumulated.rows[0]?.total_size || 0) > 0) {
            await pool.query(`UPDATE recording_sessions SET status = 'completed' WHERE id = $1`, [sessionId]);
          }
        }
      } else {
        await pool.query(
          `UPDATE recording_sessions
           SET ended_at = NOW(), status = $1,
               total_segments = $2,
               total_size = $3
           WHERE id = $4 AND status = 'recording'`,
          [sessionStatus, newFileCount, totalSize, sessionId]
        );
      }
    }

    if (newFileCount === 0) {
      console.log(`[RecorderService] 分段录制完成, 无有效文件`);
    } else {
      console.log(`[RecorderService] 分段录制完成, 共 ${newFileCount} 个文件, ${(totalSize / 1024 / 1024).toFixed(1)}MB`);
    }

    // 添加分段文件转码逻辑
    if (flvFilesToTranscode.length > 0) {
      const autoTranscode = await this.getSetting('auto_transcode', 'true');
      if (autoTranscode === 'true') {
        for (const flvPath of flvFilesToTranscode) {
          const mp4Path = flvPath.replace(SUPPORTED_TRANSCODE_EXT, '.mp4');
          transcodeQueue
            .enqueue({
              flvPath: flvPath,
              mp4Path: mp4Path,
              sessionId: sessionId,
            })
            .catch((err) => console.error('[转码队列] 入队异常:', err.message));
        }
      }
    }
  }

  /**
   * 处理非分段录制结束的逻辑
   *
   * @param {Object} params - 处理参数
   * @param {Object} params.room - 房间信息对象
   * @param {string|number} params.sessionId - 会话ID
   * @param {Date} params.sessionStart - 会话开始时间
   * @param {boolean} params.reuseSession - 是否复用会话
   * @param {string} params.outputFilePattern - 输出文件路径
   * @param {number} params.code - 进程退出码
   */
  static async _handleNonSegmentFinish({ room, sessionId, sessionStart, reuseSession, outputFilePattern, code }) {
    let fileSize = 0;
    let fileExists = false;
    try {
      const stat = fs.statSync(outputFilePattern);
      fileSize = stat.size;
      fileExists = true;
    } catch (statErr) {
      console.warn(`[RecorderService] 无法获取文件大小: ${outputFilePattern}`, statErr.message);
    }

    const thresholdValue = await this.getSetting('filtering_threshold', '10');
    const thresholdBytes = (parseInt(thresholdValue, 10) || 10) * 1024 * 1024;

    // if (fileExists && fileSize > 0 && fileSize < thresholdBytes) {
    //   try {
    //     fs.unlinkSync(outputFilePattern);
    //     console.log(
    //       `[finishSession] 非分段录制碎片文件已删除: ${path.basename(outputFilePattern)} (${(fileSize / 1024 / 1024).toFixed(1)}MB < ${thresholdValue}MB)`
    //     );
    //     fileSize = 0;
    //     fileExists = false;
    //   } catch (err) {
    //     console.error(`[finishSession] 删除非分段碎片文件失败: ${outputFilePattern}`, err.message);
    //   }
    // }

    if (fileExists && fileSize > 0) {
      const existingRec = reuseSession
        ? await pool.query('SELECT id FROM recordings WHERE session_id = $1 AND file_path = $2', [
            sessionId,
            outputFilePattern,
          ])
        : null;

      if (existingRec?.rows.length > 0) {
        await pool.query(`UPDATE recordings SET file_size = $1, ended_at = NOW(), status = 'completed' WHERE id = $2`, [
          fileSize,
          existingRec.rows[0].id,
        ]);
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
        let sessionStatus = 'completed';
        if (fileSize === 0 && code !== 0) {
          sessionStatus = 'interrupted';
        }

        if (reuseSession) {
          await pool.query(
            `UPDATE recording_sessions
             SET ended_at = NOW(), status = $1,
                 total_segments = total_segments + 1,
                 total_size = total_size + $2
             WHERE id = $3 AND status = 'recording'`,
            [sessionStatus, fileSize, sessionId]
          );
          if (sessionStatus === 'interrupted') {
            const accumulated = await pool.query(
              'SELECT total_segments, total_size FROM recording_sessions WHERE id = $1',
              [sessionId]
            );
            if ((accumulated.rows[0]?.total_segments || 0) > 0 || (accumulated.rows[0]?.total_size || 0) > 0) {
              await pool.query(`UPDATE recording_sessions SET status = 'completed' WHERE id = $1`, [sessionId]);
            }
          }
        } else {
          await pool.query(
            `UPDATE recording_sessions
             SET ended_at = NOW(), status = $1,
                 total_segments = 1,
                 total_size = $2
             WHERE id = $3 AND status = 'recording'`,
            [sessionStatus, fileSize, sessionId]
          );
        }
        await pool.query(
          `UPDATE recording_files SET file_size = $1, status = 'completed', completed_at = NOW()
           WHERE session_id = $2 AND file_path = $3`,
          [fileSize, sessionId, outputFilePattern]
        );
      }

      if (SUPPORTED_TRANSCODE_EXT.test(outputFilePattern)) {
        const autoTranscode = await this.getSetting('auto_transcode', 'true');
        if (autoTranscode === 'true') {
          if (fileSize >= thresholdBytes) {
            const mp4Path = outputFilePattern.replace(SUPPORTED_TRANSCODE_EXT, '.mp4');
            transcodeQueue
              .enqueue({
                flvPath: outputFilePattern,
                mp4Path: mp4Path,
                sessionId: sessionId,
              })
              .catch((err) => console.error('[转码队列] 入队异常:', err.message));
          }
        }
        // const completedSession = {
        //   id: sessionId,
        //   room_url: room.room_url,
        //   room_name: room.room_name,
        //   started_at: sessionStart,
        // };
        // UploadService.findAndAutoUpload(completedSession).catch((err) =>
        //   console.error('[自动投稿] 异常:', err.message)
        // );
      }
    }
  }

  /**
   * 启动录制任务
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

    if (!url || !title) {
      console.log('[RecorderService] 录制请求被拒: 缺少必填参数 (url/title)');
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

    const { reuseSession, resumeCount } = await this.checkReuseSession(room);

    console.log(`[开始] 直播间 ${roomKey} 开始录制${caption ? ' - ' + caption : ''}`);

    const downloader = await getActiveDownloader(room.polling_platform);
    const template = room.filename_template || '{room_name}_{datetime}';
    const segmentDuration = room.segment_duration || 0;
    const useSegment = segmentDuration > 0 && downloader.isSegment();

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

    const sessionStart = new Date();

    // 为什么不先新增会话数据库，再启动录制进程呢？
    try {
      // 一、新增一个录制会话
      let sessionId = await recordingManager.createSession({
        room,
        outputPath: outputFilePattern,
        sessionId: null,
        sessionStart,
        reuseSession,
        resumeCount,
        caption,
        streamUrl: url,
      });
      console.log(`[任务启动] 录制会话: ${sessionId}`);

      // 二、然后启动下载器模块的录制进程
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

      // 三、再去更新 session.pid
      await recordingManager.updateSessionPidToDatabase({
        roomId: room.id,
        sessionId,
        pid: dlProcess.pid,
      });

      console.log(`[RecorderService] 日志文件: ${logPath} `);

      // 业务逻辑统一监听 'segment' 事件
      downloader.on('segment', async (filePath) => {
        console.log(`[RecorderService] 监测到文件切片: ${filePath}`);
        // 这里处理你的分片入库逻辑
        await RecordingManager.addRecordingRecord(sessionId, filePath, 'recording');
      });

      downloader.on('file_created', async (filePath) => {
        console.log(`[RecorderService] 监测到文件创建: ${filePath}`);
        // 这里处理你的文件创建逻辑
        await RecordingManager.addRecordingRecord(sessionId, filePath, 'recording');
      });

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
          engine: downloader,
          room,
          sessionId,
          sessionStart,
          reuseSession,
          useSegment,
          outputFilePattern,
          roomKey,
        });
      };

      dlProcess.on('close', finishSessionWrapper);

      // 风险代码，先注释掉
      // if (dlProcess.exitCode !== null || dlProcess.signalCode !== null) {
      //   dlProcess.emit('close', dlProcess.exitCode);
      // }

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

  /**
   * 获取最大恢复重试次数配置
   *
   * @returns {Promise<number>} 最大重试次数
   */
  static async getMaxResumeRetries() {
    try {
      const r = await pool.query("SELECT value FROM settings WHERE key = 'max_resume_retries'");
      if (r.rows.length) return parseInt(r.rows[0].value, 10) || 3;
    } catch (_) {}
    return 3;
  }

  /**
   * 尝试恢复中断的录制会话
   *
   * @param {Object} session - 会话信息对象
   */
  static async tryResumeSession(session) {
    await recordingManager.resumeSession(session);
  }

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
        `SELECT id, room_url, room_name, ffmpeg_pid, output_path FROM rooms WHERE status IN ('recording', 'paused')`
      );

      for (const row of staleRooms.rows) {
        // 优先尝试续播
        const { reuseSession, session } = await this.checkReuseSession(row);
        let success = false;
        if (reuseSession) {
          try {
            await this.tryResumeSession(session);
            success = true;
          } catch (resumeErr) {
            console.error(`[清理] 尝试恢复录制会话失败: ${resumeErr}`);
            // 尝试恢复失败，将状态标记为 'interrupted'
            await pool.query(
              `UPDATE recording_sessions SET status = 'interrupted', updated_at = NOW() WHERE id = `,
              $0
            );
          }
        }
        // 成功恢复，跳过
        if (success) continue;

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
      // // 录制中状态的会话
      // const staleSessions = await pool.query(
      //   `SELECT rs.*, r.id as room_id, r.room_name FROM recording_sessions rs JOIN rooms r ON rs.room_url = r.room_url WHERE rs.status = 'recording'`
      // );

      // for (const session of staleSessions.rows) {
      //   // if ((session.retry_count || 0) < MAX_RESUME_RETRIES) {
      //   //   try {
      //   //     console.log(`[恢复] 尝试恢复会话 ${session.id} (直播间: ${session.room_url})`);
      //   //     await this.tryResumeSession(session);
      //   //     continue;
      //   //   } catch (err) {
      //   //     console.error(`[恢复] 会话 ${session.id} 恢复失败:`, err.message);
      //   //   }
      //   // }
      //   // 跳过恢复会话
      //   // 如果当前时间

      //   console.log(`[清理] 会话 ${session.id} 状态已标记为 interrupted`);
      //   await pool.query(`UPDATE recording_sessions SET ended_at = NOW(), status = 'interrupted' WHERE id = $1`, [
      //     session.id,
      //   ]);
      //   await pool.query(
      //     `UPDATE recording_files SET status = 'interrupted', completed_at = NOW()
      //      WHERE session_id = $1 AND status = 'recording'`,
      //     [session.id]
      //   );
      // }
    } catch (err) {
      console.error('[启动清理] 失败:', err);
    }
  }
}

module.exports = RecorderService;
