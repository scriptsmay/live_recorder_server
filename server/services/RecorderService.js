const path = require('path');
const fs = require('fs');
const pool = require('../db/index');
const redis = require('../db/redis');

const { generateOutputPath } = require('../lib/utils/tool');
const { downloadFile } = require('../lib/utils/download');
const { getActiveDownloader } = require('../lib/core/downloaders/DownloaderFactory');
const recordingManager = require('../lib/core/RecordingManager');
const notify = require('../lib/core/notify');
const DataService = require('./DataService');
const RecordingManager = require('../lib/core/RecordingManager');
const danmakuRecorder = require('../lib/core/danmaku/DanmakuRecorder');
const { SUPPORTED_EXT_REGEX } = require('../config/config');
const { normalizeRoomUrl } = require('../lib/utils/room-url');
const { detectPlatform } = require('../lib/utils/platform-detector');
const { isUnexpectedExit } = require('../lib/utils/exit-status');
const { fetchRoomCoverByUrl } = require('../lib/core/polling/checkers');

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

    // v1.12.0：rooms.room_url 有外键依赖，保留全表唯一约束——软删行仍占用 URL。
    // 查到时若为软删行则复活（清 deleted_at）；轮询路径的复活由 PollingManager
    // 「房间已删除，跳过录制」分支拦截，不会经此重建。
    const exist = await pool.query('SELECT * FROM rooms WHERE room_url = $1', [roomUrl]);
    if (exist.rows.length > 0) {
      const room = exist.rows[0];
      if (room.deleted_at != null) {
        await pool.query('UPDATE rooms SET deleted_at = NULL, updated_at = NOW() WHERE id = $1', [room.id]);
        room.deleted_at = null;
      }
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
   * @param {number|null} params.code - 进程退出码
   * @param {string|null} [params.signal] - 终止信号（正常退出为 null）
   * @param {string|number} params.sessionId - 会话ID
   * @param {boolean} [params.isManualStop] - 是否由人工停止流程发起
   */
  static async finishSession({ code, signal = null, sessionId, isManualStop = false }) {
    // 退出分类不依赖数据库，先算出来，保证 finally 兜底始终有判定可用
    const unexpectedExit = isUnexpectedExit({ code, signal, isManualStop });

    try {
      // I-R4：房间可能在录制期间被删除（软删后 getRoomByUrl 返回 null）。
      // 所有查询都放进 try 并容忍 null——否则这里抛出会变成未处理 rejection
      // （lifecycle 会 gracefulShutdown），且 finally 的终态兜底永远到不了。
      const session = await DataService.getSession(sessionId);
      if (!session) {
        console.error(`[finishSession] 会话 ${sessionId} 不存在，跳过收尾`);
        return;
      }
      const roomUrl = session.room_url;
      const sessionStart = session.started_at;
      const room = await DataService.getRoomByUrl(roomUrl);
      if (!room) {
        console.warn(`[finishSession] 会话 ${sessionId} 对应房间已删除，仍执行会话/文件收尾`);
      }
      const roomId = room?.id ?? null;
      const roomName = room?.room_name || roomUrl;

      let engineName = 'unknown';
      try {
        engineName = getActiveDownloader(room?.polling_platform || session.polling_platform)?.name || 'unknown';
      } catch (_) {}

      // 将分段时间写入数据库
      let trackerSegments = [];
      try {
        trackerSegments = await recordingManager.finalizeSession(sessionId, pool);
      } catch (err) {
        console.error(`[RecorderService] Failed to finalize segment times for session ${sessionId}:`, err);
        // 异常退出时尝试通过 ffprobe 补充分段时间
        const watchdog = require('../lib/core/watchdog');
        watchdog.backfillSegmentTimes(sessionId, pool).catch((e) => {
          console.error(`[RecorderService] backfillSegmentTimes failed:`, e.message);
        });
      }

      // 从会话中获取输出路径，避免生成新路径导致变量缺失问题
      const outputFilePattern = session.output_path || '[路径未知]';

      await this.delActiveTask(roomUrl);
      console.log(
        `[finishSession][${code}] 录制结束，路径: ${outputFilePattern} (日志: logs/${engineName}_${sessionId}.log)` +
          ` | 退出码: ${code === null || code === undefined ? 'null' : code}` +
          ` | 信号: ${signal || '无'}` +
          ` | 人工停止: ${isManualStop ? '是' : '否'}` +
          ` | 判定: ${unexpectedExit ? 'interrupted(非预期退出)' : 'completed(正常结束)'}`
      );

      if (roomId) {
        await pool.query(`UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`, [
          roomId,
        ]);
      }
      await this.delRoomCache(roomUrl);

      // 如果录制时长很短（小于5秒），不设置冷却期，以便快速重试获取新的流地址
      const sessionDuration = Date.now() - (sessionStart ? new Date(sessionStart).getTime() : Date.now());
      if (sessionDuration >= 5000) {
        // 设置录制冷却期（30秒），防止流地址失效导致频繁重启录制
        if (roomId) {
          const cooldownKey = `polling:recording_cooldown:${roomId}`;
          await redis.set(cooldownKey, Date.now().toString(), { EX: 30 }).catch(() => {});
        }
      } else {
        console.log(`[finishSession] 录制时长过短 (${sessionDuration}ms)，跳过冷却期，允许快速重试`);
        // 记录录制结束时间，供 PollingManager 检测是否需要立即重试
        if (roomId) {
          const lastEndKey = `polling:last_recording_end:${roomId}`;
          await redis.set(lastEndKey, Date.now().toString(), { EX: 10 }).catch(() => {});
        }
      }

      // 会话结束后启动转码任务、整理数据库各项状态
      const { fileSize, fileCount } = await this._handleSessionFinish({
        sessionId,
        code,
        signal,
        isManualStop,
        unexpectedExit,
      });

      // 停止弹幕采集
      await this._handleDanmakuFinish(sessionId, roomUrl, trackerSegments);

      try {
        const sess = await pool.query(
          'SELECT status, total_segments, total_size FROM recording_sessions WHERE id = $1',
          [sessionId]
        );
        const segs = fileCount || 0;
        const mb = ((fileSize || 0) / 1024 / 1024).toFixed(1);
        const status = sess.rows[0]?.status || 'completed';
        notify.recordingComplete(roomName, segs, mb, sessionId, roomUrl, status);
      } catch (_) {}
    } catch (dbErr) {
      console.error('[RecorderService] 录制结束数据库更新失败:', dbErr);
    } finally {
      // S4：会话状态更新是必达语义。_handleSessionFinish 若在 UPDATE 之前抛错，
      // 会话会永久停留在 recording（看门狗只扫描 rooms.status='recording'，
      // finalizeInterruptedSessions 只扫描 interrupted），进而让同房间自动投稿
      // 的 NOT EXISTS 守卫静默封锁该直播间。这里兜底收敛，绝不留 recording。
      try {
        await this._ensureSessionTerminal(sessionId, unexpectedExit);
      } catch (err) {
        console.error(`[RecorderService] 会话 ${sessionId} 终态兜底失败:`, err);
      }
    }
  }

  /**
   * 会话终态兜底：若会话仍是 recording，按退出判定写入终态。
   *
   * 正常结束/人工停止 → completed；非预期退出 → interrupted（等待 delay 窗口）。
   * ended_at NULL 的历史行也在此补齐，避免下游按 ended_at 过滤时漏掉。
   *
   * @param {string|number} sessionId
   * @param {boolean} unexpectedExit
   * @private
   */
  static async _ensureSessionTerminal(sessionId, unexpectedExit) {
    if (!sessionId) return;
    const status = unexpectedExit ? 'interrupted' : 'completed';
    const result = await pool.query(
      `UPDATE recording_sessions
       SET status = $1, ended_at = COALESCE(ended_at, NOW())
       WHERE id = $2 AND status = 'recording'
       RETURNING id`,
      [status, sessionId]
    );
    // rowCount / RETURNING rows 任一非空即说明本次真的写入了终态
    if (!(result.rowCount > 0 || result.rows.length > 0)) return;

    // 兜底不仅要收敛会话，还要收敛遗留文件：_handleSessionFinish 若在文件循环前抛错，
    // 文件会一直停在 recording，既不满足 checkSessionTranscode 的 rf.status='completed'，
    // 也不会被 finalizeInterruptedSessions（只扫 interrupted 文件）接管。
    // completed 兜底直接让文件进入转码/后续流程；interrupted 兜底仍等待 delay 窗口。
    const files = await pool.query(
      `UPDATE recording_files
       SET status = $1, ended_at = COALESCE(ended_at, NOW()),
           completed_at = CASE WHEN $1 = 'completed' THEN COALESCE(completed_at, NOW()) ELSE completed_at END
       WHERE session_id = $2 AND status = 'recording' AND deleted_at IS NULL`,
      [status, sessionId]
    );
    console.warn(
      `[RecorderService] 会话 ${sessionId} 在正常收尾流程中未完成状态更新，兜底置为 ${status}` +
        (unexpectedExit ? '（等待 delay 窗口后完成）' : '') +
        (files.rowCount > 0 ? `，同步收敛 ${files.rowCount} 个遗留文件` : '')
    );
    if (status === 'completed') {
      // 兜底完成时按正常路径立即入队转码，否则要等下一轮看门狗扫描。
      // 排除已有转码记录的文件，避免兜底重跑时重复入队。
      const rows = await pool.query(
        `SELECT rf.file_path FROM recording_files rf
         WHERE rf.session_id = $1 AND rf.status = 'completed' AND rf.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM transcode_records tr
             WHERE tr.original_path = rf.file_path AND tr.deleted_at IS NULL
           )`,
        [sessionId]
      );
      for (const row of rows.rows) {
        RecordingManager.addTranscodeQueue(sessionId, row.file_path);
      }
    }
  }

  /**
   * 把指定文件对齐到给定终态（并发收敛用）。
   *
   * 仅在 `_handleSessionFinish` 的终态写入被看门狗抢先时调用：本流程可能已把文件
   * 写成 completed，而会话实际落库为 interrupted，需要把文件改回 interrupted，
   * 保持「会话状态 = 文件状态」，避免转码在 interrupted 会话上运行。
   *
   * @param {string|number} sessionId
   * @param {'completed'|'interrupted'} status
   * @param {string[]} filePaths
   * @private
   */
  static async _alignFilesToSession(sessionId, status, filePaths) {
    if (!filePaths || filePaths.length === 0) return;
    await pool.query(
      `UPDATE recording_files
       SET status = $1,
           completed_at = CASE WHEN $1 = 'completed' THEN completed_at ELSE NULL END,
           checked_at = NOW()
       WHERE session_id = $2 AND file_path = ANY($3::text[]) AND deleted_at IS NULL`,
      [status, sessionId, filePaths]
    );
  }

  /**
   * 处理会话录制结束的业务逻辑
   *
   * 文件状态按退出性质区分：
   * - 正常退出 / 人工停止：有效文件 `completed`，立即入转码队列；
   * - 非预期退出：有效文件 `interrupted`，跳过即时转码，等待 delay 窗口后由看门狗
   *   `finalizeInterruptedSessions()` 统一完成并进入转码流程。
   *
   * 不分段录制没有 segment 事件，结束回调时 `recording_files` 可能为空；因此这里
   * 始终对 `output_dir` 做增量扫描：只补录尚未在 `recording_files` 中登记的文件，
   * 续播（同一会话多次启动）产生的新文件也会被拾取，不再依赖
   * `recordingFiles.length === 0` 的前置条件。
   *
   * @param {Object} params - 处理参数
   * @param {string|number} params.sessionId - 会话ID
   * @param {number|null} params.code - 进程退出码
   * @param {string|null} [params.signal] - 终止信号
   * @param {boolean} [params.isManualStop] - 是否人工停止
   * @param {boolean} [params.unexpectedExit] - 是否非预期退出（由 isUnexpectedExit 判定）
   *
   * @returns {Promise<{fileSize: number, fileCount: number}>} - 文件大小和文件数量
   */
  static async _handleSessionFinish({ sessionId, code, signal = null, isManualStop = false, unexpectedExit }) {
    if (typeof unexpectedExit !== 'boolean') {
      unexpectedExit = isUnexpectedExit({ code, signal, isManualStop });
    }

    // 单一写者：若会话已被其他路径（看门狗兜底、启动清理）写成终态，
    // 本次 close 只补充文件大小/统计，不得再改文件状态或入队转码，
    // 否则会出现「会话 interrupted + 文件 completed + 转码已入队」的分裂状态。
    const stateRes = await pool.query(`SELECT status FROM recording_sessions WHERE id = $1`, [sessionId]);
    const sessionStatusNow = stateRes.rows[0]?.status;
    const sessionFinalized = Boolean(sessionStatusNow) && sessionStatusNow !== 'recording';
    if (sessionFinalized) {
      console.warn(
        `[finishSession] 会话 ${sessionId} 已被其他路径置为 ${sessionStatusNow}，` +
          `close 回调只补统计、不改文件状态也不入队转码`
      );
    }

    // 已终态时沿用会话现有状态，避免把 interrupted 会话的文件写成 completed
    const fileStatus = sessionFinalized
      ? sessionStatusNow === 'interrupted'
        ? 'interrupted'
        : 'completed'
      : unexpectedExit
        ? 'interrupted'
        : 'completed';
    // 即时转码入队延迟到「会话终态写入成功」之后执行：先落库状态，再入队，
    // 避免 reaper 在同一窗口抢先置 interrupted 时留下「转码已入队」的分裂状态。
    const canEnqueueTranscode = !sessionFinalized && fileStatus === 'completed';
    // 本次实际改写过状态的文件路径（用于并发收敛时对齐）
    const touchedFilePaths = [];
    const thresholdValue = await DataService.getSetting('filtering_threshold', '10');
    const thresholdBytes = (parseInt(thresholdValue, 10) || 10) * 1024 * 1024;

    let fileSize = 0;
    let fileExists = false;
    let fileCount = 0;
    try {
      const { rows: recordingFiles } = await DataService.getRecordingFiles({ session_id: sessionId });
      console.log(`[finishSession] 会话 ${sessionId} 查询到 ${recordingFiles.length} 个录制文件记录`);

      const trackedPaths = new Set();

      for (const file of recordingFiles) {
        trackedPaths.add(file.file_path);
        let stat;
        try {
          stat = fs.statSync(file.file_path);
        } catch {
          console.warn(`[finishSession] 文件不存在，跳过: ${file.file_path}`);
          continue;
        }
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
        // v1.12.0：仅更新未删除行——软删行与重建行可能同路径。
        // 会话已被其他路径终态化时只补大小，不改状态。
        if (sessionFinalized) {
          await pool.query(
            `UPDATE recording_files SET file_size = $1 WHERE session_id = $2 AND file_path = $3 AND deleted_at IS NULL`,
            [stat.size, sessionId, file.file_path]
          );
        } else {
          await pool.query(
            `UPDATE recording_files
             SET file_size = $1, status = $2, ended_at = NOW(),
                 completed_at = CASE WHEN $2 = 'completed' THEN NOW() ELSE completed_at END
             WHERE session_id = $3 AND file_path = $4 AND deleted_at IS NULL`,
            [stat.size, fileStatus, sessionId, file.file_path]
          );
        }

        touchedFilePaths.push(file.file_path);
      }

      // 增量补录：扫描 output_dir，仅 INSERT 尚未在 recording_files 中登记的视频文件。
      // 覆盖不分段录制（无 segment 事件）以及续播后新增但未登记的文件。
      const sessRes = await pool.query(
        `SELECT output_dir, room_url, started_at FROM recording_sessions WHERE id = $1`,
        [sessionId]
      );
      const sessRow = sessRes.rows[0];

      if (sessRow && sessRow.output_dir && fs.existsSync(sessRow.output_dir)) {
        let nextSegIdx = recordingFiles.reduce((max, f) => Math.max(max, f.segment_index || 0), -1) + 1;
        const entries = fs.readdirSync(sessRow.output_dir);
        let backfilled = 0;
        for (const name of entries) {
          // 跳过隐藏文件（临时文件/系统文件）；HLS 目录由 isFile() 判定排除
          if (name.startsWith('.')) continue;
          if (!SUPPORTED_EXT_REGEX.test(name)) continue;

          const fp = path.join(sessRow.output_dir, name);
          if (trackedPaths.has(fp)) continue;

          let stat;
          try {
            stat = fs.statSync(fp);
          } catch {
            continue;
          }
          if (!stat.isFile() || stat.size < thresholdBytes) continue;

          const inserted = await pool.query(
            `INSERT INTO recording_files
               (session_id, room_url, file_path, file_name, file_size, status, started_at, ended_at, completed_at, segment_index, checked_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(),
                     CASE WHEN $6 = 'completed' THEN NOW() ELSE NULL END, $8, NOW())
             ON CONFLICT (file_path) WHERE deleted_at IS NULL DO NOTHING
             RETURNING id`,
            [sessionId, sessRow.room_url, fp, name, stat.size, fileStatus, sessRow.started_at, nextSegIdx]
          );

          // ON CONFLICT 命中说明已被并发路径登记，不重复计数/入队
          if (inserted.rows.length === 0) continue;

          fileCount++;
          fileSize += stat.size;
          fileExists = true;
          trackedPaths.add(fp);
          backfilled++;
          nextSegIdx++;

          touchedFilePaths.push(fp);
          console.log(
            `[finishSession] 补录文件: ${name} (${(stat.size / 1024 / 1024).toFixed(1)}MB, status=${fileStatus})`
          );
        }
        if (backfilled > 0) {
          console.log(`[finishSession] 会话 ${sessionId} 增量补录 ${backfilled} 个文件`);
        }
      }
    } catch (statErr) {
      console.warn(`[RecorderService] [会话${sessionId}] 无法获取文件大小`, statErr.message);
    }

    if (sessionId) {
      const sessionStatus = unexpectedExit ? 'interrupted' : 'completed';
      // 最终状态与实际应入队的文件路径；并发收敛时以落库状态为准
      let finalStatus = sessionStatus;
      let enqueuePaths = canEnqueueTranscode ? [...touchedFilePaths] : [];

      if (sessionFinalized) {
        // 状态已由其他路径写入，这里只补统计，不覆盖终态
        await pool.query(`UPDATE recording_sessions SET total_segments = $1, total_size = $2 WHERE id = $3`, [
          fileCount,
          fileSize,
          sessionId,
        ]);
        finalStatus = sessionStatusNow;
        enqueuePaths = [];
      } else {
        // 终态写入是「谁赢谁定」的临界点：进入本流程后会话可能被看门狗回收（reaper）
        // 抢先置为 interrupted。UPDATE ... RETURNING status 返回实际落库状态；
        // 若已被抢先，立即把本次写入的文件状态对齐到会话，并放弃转码入队，避免
        // 「会话 interrupted + 文件 completed + 转码进行中」的分裂。
        const finalResult = await pool.query(
          `UPDATE recording_sessions
               SET ended_at = NOW(), status = $1,
                   total_segments = $2,
                   total_size = $3
               WHERE id = $4 AND status = 'recording'
               RETURNING status`,
          [sessionStatus, fileCount, fileSize, sessionId]
        );

        // rowCount / RETURNING rows 任一非空即说明本次真的写入了终态
        const sessionWritten = finalResult.rowCount > 0 || finalResult.rows.length > 0;
        if (!sessionWritten) {
          const raced = await pool.query('SELECT status FROM recording_sessions WHERE id = $1', [sessionId]);
          const actual = raced.rows[0]?.status || 'unknown';
          console.warn(
            `[finishSession] 会话 ${sessionId} 在收尾期间被并发置为 ${actual}，` + `本次按该状态对齐文件并放弃即时转码`
          );
          finalStatus = actual;
          enqueuePaths = [];
          if (actual === 'interrupted') {
            await this._alignFilesToSession(sessionId, 'interrupted', touchedFilePaths);
          }
        }
      }

      // 状态落库后才入队：确保任何时刻都不会出现「会话 interrupted 而转码在跑」
      if (finalStatus === 'completed' && enqueuePaths.length > 0) {
        for (const fp of enqueuePaths) {
          RecordingManager.addTranscodeQueue(sessionId, fp);
        }
      }

      if (unexpectedExit) {
        console.log(
          `[finishSession] 会话 ${sessionId} 判定为非预期退出（退出码: ${code === null || code === undefined ? 'null' : code}, 信号: ${signal || '无'}），` +
            `有效文件 ${fileCount} 个标记为 interrupted，跳过即时转码；` +
            `延迟完成原因: 等待 delay 窗口内续播，超时后由看门狗 finalizeInterruptedSessions() 置为 completed`
        );
      }
    }

    if (fileCount === 0) {
      console.log(`[RecorderService] 会话录制完成, 无有效文件`);
    } else {
      console.log(`[RecorderService] 会话录制完成, 共 ${fileCount} 个文件, ${(fileSize / 1024 / 1024).toFixed(1)}MB`);
    }

    return { fileSize, fileExists, fileCount };
  }

  /**
   * 处理弹幕录制结束：停止采集、保留 JSONL 数据
   *
   * @param {number|string} sessionId - 录制会话 ID
   * @param {string} roomUrl - 房间 URL
   * @param {Array} [trackerSegments] - 从 RecordingManager tracker 获取的分段时间数据
   */
  static async _handleDanmakuFinish(sessionId, roomUrl, _trackerSegments = []) {
    try {
      // 停止弹幕采集。传入录制会话 ID 作为身份校验：若该房间已被新会话接管，
      // stopCapture 不会误停/误写新采集记录（注意是 sessionId，不是 captureId）。
      const { captureId, eventCount } = await danmakuRecorder.stopCapture(roomUrl, { sessionId });

      if (!captureId) {
        console.log(`[弹幕] 会话 ${sessionId} 采集未启动或已停止`);
        // 房间已被其他录制会话接管时，绝不触碰其活跃采集记录
        const active = danmakuRecorder.getSession(roomUrl);
        if (active && String(active.sessionId) !== String(sessionId)) {
          console.log(`[弹幕] 房间 ${roomUrl} 已由会话 ${active.sessionId} 接管，跳过收口`);
          return;
        }
        // 仅收口本会话仍为 recording 的行；若同房间已有新采集记录（续播），不动它
        await pool.query(
          `UPDATE danmaku_capture_records SET status = 'completed', ended_at = COALESCE(ended_at, NOW())
           WHERE session_id = $1 AND status = 'recording'`,
          [sessionId]
        );
        return;
      }

      if (eventCount === 0) {
        console.log(`[弹幕] 会话 ${sessionId} 无弹幕数据`);
        // 无数据也要更新状态为 completed
        await pool.query(
          `UPDATE danmaku_capture_records SET status = 'completed', ended_at = NOW(), event_count = 0
           WHERE id = $1`,
          [captureId]
        );
        return;
      }

      console.log(`[弹幕] 会话 ${sessionId} 采集停止: ${eventCount} 条事件, capture_id=${captureId}`);

      // 更新采集记录状态为 completed
      await pool.query(
        `UPDATE danmaku_capture_records SET status = 'completed', ended_at = NOW(), event_count = $1
         WHERE id = $2`,
        [eventCount, captureId]
      );
    } catch (err) {
      console.error('[弹幕] 处理弹幕结束失败:', err.message);
    }
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
  static async startRecording({ url, title, caption, room_url, roomCover }) {
    const normalizedRoomUrl = normalizeRoomUrl(room_url);
    console.log('[RecorderService] 收到录制请求:', {
      title,
      room_url: normalizedRoomUrl,
      url: url?.slice(0, 60),
      caption,
      roomCover: roomCover ? 'yes' : 'no',
    });

    if (!url || !title || !normalizedRoomUrl) {
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

    const roomKey = normalizedRoomUrl;

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

    return await this.startRoomRecording({ roomId: room.id, caption, url, roomCover });
  }

  /**
   * 解析录制会话的封面 URL
   *
   * 优先使用调用方传入的 roomCover（轮询路径 / API 请求体 cover_url）；
   * 缺失时按 room_url 反查平台 checker 自取一次（best-effort，失败返回空串）。
   *
   * @param {Object} params
   * @param {string} params.roomCover - 调用方传入的封面 URL（可为空）
   * @param {string} params.roomUrl - 房间 URL
   * @returns {Promise<string>} 封面 URL，取不到为空串
   */
  static async _resolveRecordingCover({ roomCover, roomUrl }) {
    if (roomCover) return roomCover;
    return fetchRoomCoverByUrl(roomUrl);
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
  static async startRoomRecording({ roomId, caption, url, resumeSessionId = null, roomCover = '' }) {
    const room = await DataService.getRoomById(roomId);
    const roomKey = room.room_url;
    console.log(`[任务启动] 直播间 ${roomKey} 开始录制${caption ? ' - ' + caption : ''}`);

    // 封面来源：入参缺失时按房间 URL 自取兜底（扩展/Webhook/前端手动触发均不带 cover_url）
    const coverUrl = await this._resolveRecordingCover({ roomCover, roomUrl: room.room_url });

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
          coverUrl,
        });
        // console.log(`[任务启动] 录制会话: ${sessionId}`);
      }

      // 二、使用 sessionId 生成输出路径
      const outputFilePattern = generateOutputPath(
        downloader,
        template,
        room.room_name,
        '',
        segmentDuration,
        null,
        sessionId
      );

      // 创建会话目录
      const sessionDir = require('path').dirname(outputFilePattern);
      if (!require('fs').existsSync(sessionDir)) {
        require('fs').mkdirSync(sessionDir, { recursive: true });
        console.log(`[任务启动] 创建会话目录: ${sessionDir}`);
      }

      // 下载直播间封面
      if (coverUrl) {
        try {
          const coverPath = await downloadFile(coverUrl, path.join(sessionDir, 'cover.ext'));
          await recordingManager.updateSessionCover(sessionId, coverPath);
          console.log(`[任务启动] 封面已下载: ${coverPath}`);
        } catch (coverErr) {
          console.warn(`[任务启动] 封面下载失败（不影响录制）: ${coverErr.message}`);
        }
      }

      // 三、更新会话的输出路径
      await recordingManager.updateSessionOutputPath(sessionId, outputFilePattern);

      // 四、异步流类型检测
      let streamType = 'flv';
      try {
        const detection = await downloader.detectStreamType(url);
        streamType = detection.type;
        console.log(`[流类型检测] ${url.slice(0, 60)} -> ${streamType} (via ${detection.metadata.source})`);
      } catch (err) {
        console.warn(`[流类型检测] 失败，使用默认类型 flv:`, err.message);
      }

      // 注册分段追踪
      const sessionStartMs = Date.now();
      recordingManager.registerSession(sessionId, sessionStartMs, { roomUrl: room.room_url });

      // 五、然后启动下载器模块的录制进程
      const { process: dlProcess, logPath } = recordingManager.startRecordingProcess({
        downloader,
        streamUrl: url,
        outputPath: outputFilePattern,
        options: {
          segmentDuration,
          platform: room.polling_platform,
          isStreamUrl: true,
          streamType,
        },
        sessionId,
      });

      // 监听分段事件
      dlProcess.on('segment', (filePath, elapsedMs) => {
        recordingManager.recordSegment(sessionId, filePath, elapsedMs);
      });

      // 定期更新心跳（防止超时清理）
      const heartbeatInterval = setInterval(() => {
        recordingManager.heartbeat(sessionId);
      }, 30 * 1000);
      console.log(
        `[任务启动] 文件名模板: ${template}` +
          `| 分段录制: ${useSegment ? segmentDuration + 's' : '关闭'}` +
          `| 输出文件路径: ${outputFilePattern}` +
          `| PID: ${dlProcess.pid}` +
          `| 日志路径: ${logPath}`
      );

      // 五、再去更新 session.pid
      await recordingManager.updateSessionPidToDatabase({
        roomId: room.id,
        sessionId,
        pid: dlProcess.pid,
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

      // 启动弹幕采集（如果全局启用或房间开启了浏览器插件弹幕采集）
      danmakuRecorder
        .startCapture({
          sessionId,
          roomId: room.id,
          roomUrl: room.room_url,
          // 不能只信 polling_platform：经 notify/live_download 直接建房的房间该列可能为 NULL，
          // 统一回退到按 URL 探测，避免把虎牙/B站等房间误标成 kuaishou 并启动无效采集。
          platform: room.polling_platform || detectPlatform(room.room_url) || 'kuaishou',
          recordingStartedAt: sessionStartMs,
          extensionDanmakuEnabled: room.extension_danmaku_enabled === true,
        })
        .catch((err) => {
          console.warn('[弹幕] 启动采集失败:', err.message);
        });

      const finishSessionWrapper = async (code, signal) => {
        // 人工停止标记在 stopRecordingProcess 发起停止时写入进程对象；
        // 超时兜底 SIGKILL 也保留该标记，close 时据此判定为正常结束。
        const isManualStop = dlProcess._manualStopped === true;
        if (code !== 0) {
          console.error(`FFmpeg 下载失败，退出码: ${code}, 信号: ${signal}, 人工停止: ${isManualStop}`);
        } else {
          console.log('FFmpeg 下载完成');
        }
        // 录制结束时清除心跳定时器
        clearInterval(heartbeatInterval);
        await this.finishSession({
          code,
          signal,
          sessionId,
          isManualStop,
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

  /**
   * 清理陈旧的录制任务和会话
   *
   * 用于处理系统异常重启或崩溃后遗留的录制状态：
   * 1. 查找所有状态为 'recording' 或 'paused' 的直播间
   *    - 优先通过 checkReuseSession 尝试续播复用旧会话
   *    - 终止残留的 ffmpeg 进程
   *    - 将房间状态重置为 'idle'
   * 2. 查找所有状态为 'recording' 的录制会话
   *    - 将会话和其未完成文件统一标记为 'interrupted'
   */
  static async cleanupStaleRecordings() {
    try {
      // v1.12.0：软删房间不参与启动清理——其残留 ffmpeg_pid 可能已被系统复用，不能贸然 kill
      const staleRooms = await pool.query(
        `SELECT id, room_url, room_name, ffmpeg_pid, polling_platform, output_path FROM rooms WHERE status IN ('recording', 'paused') AND deleted_at IS NULL`
      );

      for (const row of staleRooms.rows) {
        // 优先尝试续播
        const { reuseSession, resumeCount } = await this.checkReuseSession(row);
        if (reuseSession) {
          // 将旧会话状态标记为 'interrupted'
          await pool.query(`UPDATE recording_sessions SET status = 'interrupted', ended_at = NOW() WHERE id = $1`, [
            resumeCount,
          ]);
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

      // 录制中状态的会话：统一标记为 interrupted。
      // 会话恢复能力已由启动清理链中的「延迟续播」机制（checkReuseSession）承担，
      // 此处不再尝试 resumeSession，避免与续播逻辑重复。
      // v1.12.0：JOIN 过滤软删房间（其会话已随房间软删，不再回写 interrupted）
      const staleSessions = await pool.query(
        `SELECT rs.*, r.id as room_id, r.room_name, r.polling_platform FROM recording_sessions rs JOIN rooms r ON rs.room_url = r.room_url WHERE rs.status = 'recording' AND r.deleted_at IS NULL`
      );

      for (const session of staleSessions.rows) {
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

  /**
   * 启动回收：把上次进程遗留的孤儿 uploading 投稿标记为 failed
   *
   * biliup 子进程随进程被杀，而 enqueue / executeUpload 对 uploading 一律跳过（含 force），
   * 不回收就永久死锁。语义对齐录制侧「recording → interrupted」；只标失败，不自动重投。
   * @returns {Promise<{upload_records: number[], replay_upload_records: number[]}>} 各表回收的记录 ID
   */
  static async cleanupStaleUploads() {
    const ORPHAN_NOTE = '服务重启前上传中断（孤儿回收）';
    // 表名来自本常量白名单，不来自请求参数；两张表列名一致，可用同一语句模板
    const targets = [
      { table: 'upload_records', label: '常规投稿' },
      { table: 'replay_upload_records', label: '回放投稿' },
    ];
    const recovered = { upload_records: [], replay_upload_records: [] };

    try {
      for (const target of targets) {
        const result = await pool.query(
          `UPDATE ${target.table}
              SET status = 'failed', error_message = $1, completed_at = NOW()
            WHERE status = 'uploading' AND deleted_at IS NULL
            RETURNING id`,
          [ORPHAN_NOTE]
        );
        recovered[target.table] = result.rows.map((row) => row.id);
        if (result.rows.length > 0) {
          console.log(
            `[启动清理] ${target.label}回收孤儿投稿 ${result.rows.length} 条: ${result.rows.map((r) => r.id).join(', ')}`
          );
        }
      }

      const total = recovered.upload_records.length + recovered.replay_upload_records.length;
      if (total > 0) {
        const lines = [
          `常规投稿 ${recovered.upload_records.length} 条${recovered.upload_records.length ? `（ID: ${recovered.upload_records.join(', ')}）` : ''}`,
          `回放投稿 ${recovered.replay_upload_records.length} 条${recovered.replay_upload_records.length ? `（ID: ${recovered.replay_upload_records.join(', ')}）` : ''}`,
          '已标记为失败，可在对应页面手动重试；文件可能已变动，不自动重投。',
        ];
        await notify.send('upload_orphan_recovered', `服务重启：${total} 条投稿任务被中断`, lines.join('\n'));
      }
    } catch (err) {
      console.error('[启动清理] 投稿孤儿回收失败:', err);
    }

    return recovered;
  }
}

module.exports = RecorderService;
