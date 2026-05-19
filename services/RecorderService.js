const path = require('path');
const fs = require('fs');
const dayjs = require('dayjs');
const pool = require('../db/index');
const redis = require('../db/redis');
const { createProcLog } = require('../lib/utils/proc-log');
const { getActiveDownloader } = require('../lib/core/downloaders/DownloaderFactory');
const transcodeQueue = require('../lib/core/TranscodeQueue');
const segmenter = require('../lib/core/segmenter');
const notify = require('../lib/core/notify');

const UploadService = require('./UploadService');

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

  static generateOutputPath(downloader, template, roomName, title, segmentDuration, _reuseSession, _roomOutputPath) {
    const useSegment = segmentDuration > 0;
    const ext = downloader.getExtension();

    let outputFilePattern;

    // 这里需要判断下载平台

    if (useSegment) {
      const strftimeName = this.templateToStrftime(template, roomName || title, ext);
      outputFilePattern = path.join(DOWNLOAD_DIR, strftimeName);
    } else {
      const filename = this.generateFilename(template, roomName || title, ext);
      outputFilePattern = path.join(DOWNLOAD_DIR, filename);
    }

    return outputFilePattern;
  }

  static async startSegmentTask({
    inputFile,
    outputFilePattern,
    roomKey,
    segmentDuration,
  }) {
    // const input = './recordings/live_stream.ts';
    // const outputPattern = './output/clip_%03d.mp4';

    // 2. 调用方法
    const result = await segmenter.segmentAndTranscode(
      inputFile,
      outputFilePattern,
      {
        segmentTime: segmentDuration, // 每 segmentDuration 秒切一片
      },
      roomKey // sessionId
    );

    if (result.success) {
      console.log('切割转码完成，日志路径:', result.logPath);
    } else {
      console.error('任务失败:', result.error);
    }
    return result;
  }

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
    console.log(`[${code}] 录制结束，路径: ${outputFilePattern} (日志: logs/${engine.name}_${sessionId}.log)`);

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
        // 处理录制完后切片的情况
        const cutAfterDownloaded = engine.getCutAfterDownloaded();
        if (cutAfterDownloaded) {
          // 录制完实际下载的文件名是啥？
          const result = await this.startSegmentTask({
            inputFile: '',
            outputFilePattern,
            roomKey,
            segmentDuration,
          });
          
          console.log(`[finishSession] 录制完成，处理切片结果: ${result}`);
        }

        const thresholdValue = await this.getSetting('filtering_threshold', '10');
        const thresholdBytes = (parseInt(thresholdValue, 10) || 10) * 1024 * 1024;
        let totalSize = 0;
        let newFileCount = 0;

        // 收集所有需要转码的FLV文件
        const flvFilesToTranscode = [];

        // 从数据库查询该会话已追踪的所有文件
        const sessionFiles = await pool.query(
          'SELECT file_path, file_size FROM recording_files WHERE session_id = $1 AND status = \'completed\'',
          [sessionId]
        );

        for (const row of sessionFiles.rows) {
          const filePath = row.file_path;
          let fileSize = row.file_size;

          // 如果数据库中文件大小为0，尝试重新获取
          if (fileSize === 0) {
            try {
              fileSize = fs.statSync(filePath).size;
            } catch (_) {}
          }

          // 小于阈值的文件直接删除，不进行保存和转码
          if (fileSize > 0 && fileSize < thresholdBytes) {
            try {
              fs.unlinkSync(filePath);
              console.log(
                `[finishSession] 碎片文件已删除: ${path.basename(filePath)} (${(fileSize / 1024 / 1024).toFixed(1)}MB < ${thresholdValue}MB)`
              );
              
              // 从数据库中删除该文件记录
              await pool.query('DELETE FROM recording_files WHERE file_path = $1', [filePath]);
              await pool.query('DELETE FROM recordings WHERE file_path = $1', [filePath]);
            } catch (err) {
              console.error(`[finishSession] 删除碎片文件失败: ${filePath}`, err.message);
            }
            continue;
          }

          // 只有大于等于阈值的文件才保留入库
          if (fileSize > 0) {
            totalSize += fileSize;

            // 更新 recordings 表中的文件大小
            await pool.query(
              'UPDATE recordings SET file_size = $1, ended_at = NOW(), status = \'completed\' WHERE file_path = $2',
              [fileSize, filePath]
            );
            
            newFileCount++;

            // 只有大于阈值的FLV文件才加入转码队列
            if (fileSize >= thresholdBytes && filePath.endsWith('.flv')) {
              flvFilesToTranscode.push(filePath);
            }
          }
        }

        // 会话结束时取消转码，改为让看门狗定时检测
        // 条件：转码开关启用 + 会话结束录制状态 + 查询会话下有待转码文件

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
            // 复用会话：只要有累积内容（含前几轮），就视为完成
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
        console.log(`[api] 分段录制完成, 共 ${newFileCount} 个文件, ${(totalSize / 1024 / 1024).toFixed(1)}MB`);

        // 只要有文件收集到就触发自动投稿（包括小于阈值的文件，因为它们也可能被转码）
        if (newFileCount > 0) {
          const completedSession = {
            id: sessionId,
            room_url: room.room_url,
            room_name: room.room_name,
            started_at: sessionStart,
          };
          UploadService.findAndAutoUpload(completedSession).catch((err) =>
            console.error('[自动投稿] 异常:', err.message)
          );
        }
      } else {
        let fileSize = 0;
        let fileExists = false;
        try {
          const stat = fs.statSync(outputFilePattern);
          fileSize = stat.size;
          fileExists = true;
        } catch (statErr) {
          console.warn(`[api] 无法获取文件大小: ${outputFilePattern}`, statErr.message);
        }

        // 获取阈值
        const thresholdValue = await this.getSetting('filtering_threshold', '10');
        const thresholdBytes = (parseInt(thresholdValue, 10) || 10) * 1024 * 1024;

        // 如果文件小于阈值，直接删除
        if (fileExists && fileSize > 0 && fileSize < thresholdBytes) {
          try {
            fs.unlinkSync(outputFilePattern);
            console.log(
              `[finishSession] 非分段录制碎片文件已删除: ${path.basename(outputFilePattern)} (${(fileSize / 1024 / 1024).toFixed(1)}MB < ${thresholdValue}MB)`
            );
            fileSize = 0;
            fileExists = false;
          } catch (err) {
            console.error(`[finishSession] 删除非分段碎片文件失败: ${outputFilePattern}`, err.message);
          }
        }

        if (fileExists && fileSize > 0) {
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
              // 复用会话：只要有累积内容（含前几轮），就视为完成
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

          if (/\.flv$/i.test(outputFilePattern)) {
            const autoTranscode = await this.getSetting('auto_transcode', 'true');
            if (autoTranscode === 'true') {
              // 只有大于等于阈值的文件才转码
              if (fileSize >= thresholdBytes) {
                const mp4Path = outputFilePattern.replace(/\.flv$/i, '.mp4');
                transcodeQueue
                  .enqueue({
                    flvPath: outputFilePattern,
                    mp4Path: mp4Path,
                    sessionId: sessionId,
                  })
                  .catch((err) => console.error('[转码队列] 入队异常:', err.message));
              }
            }
            const completedSession = {
              id: sessionId,
              room_url: room.room_url,
              room_name: room.room_name,
              started_at: sessionStart,
            };
            // 只有有文件存在时才触发自动投稿
            UploadService.findAndAutoUpload(completedSession).catch((err) =>
              console.error('[自动投稿] 异常:', err.message)
            );
          }
        }
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
      console.error('[api] 录制结束数据库更新失败:', dbErr);
    }
  }

  static async startRecording({ url, title, caption, room_url }) {
    console.log('[api] 收到录制请求:', {
      title,
      room_url,
      url: url?.slice(0, 60),
      caption,
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

    const downloader = await getActiveDownloader(room.polling_platform);
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

    const dlArgs = downloader.buildArgs(url, outputFilePattern, {
      segmentDuration,
      segmentListPath,
      platform: room.polling_platform,
      isStreamUrl: true,
    });

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
        outputFilePattern,
        roomKey,
      });
    };

    // 下载结束触发
    dlProcess.on('close', finishSessionWrapper);

    if (dlProcess.exitCode !== null || dlProcess.signalCode !== null) {
      dlProcess.emit('close', dlProcess.exitCode);
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
      outputPath = path.join(DOWNLOAD_DIR, base);
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

        if (useSegment) {

          // const thresholdValue = await this.getSetting('filtering_threshold', '10');
          // const thresholdBytes = (parseInt(thresholdValue, 10) || 10) * 1024 * 1024;
          let totalSegments = 0;
          let totalSize = 0;

          // 从数据库查询该会话已追踪的所有文件
          const sessionFiles = await pool.query(
            'SELECT file_path, file_size FROM recording_files WHERE session_id = $1 AND status = \'completed\'',
            [session.id]
          );

          for (const row of sessionFiles.rows) {
            const filePath = row.file_path;
            let fileSize = row.file_size;

            // 如果数据库中文件大小为0，尝试重新获取
            if (fileSize === 0) {
              try {
                const stat = fs.statSync(filePath);
                fileSize = stat.size;
                
                // 更新数据库中的文件大小
                await pool.query(
                  'UPDATE recording_files SET file_size = $1 WHERE file_path = $2',
                  [fileSize, filePath]
                );
                await pool.query(
                  'UPDATE recordings SET file_size = $1 WHERE file_path = $2',
                  [fileSize, filePath]
                );
              } catch (_) {
                continue;
              }
            }

            if (fileSize > 0) {
              totalSegments++;
              totalSize += fileSize;
            }
          }

          // 更新会话统计
          if (totalSegments > 0) {
            await pool.query(
              `UPDATE recording_sessions SET total_segments = total_segments + $1, total_size = total_size + $2 WHERE id = $3`,
              [totalSegments, totalSize, session.id]
            );
          }

          // 会话状态判断
          let sessionStatus = 'completed';
          if (totalSegments === 0 && code !== 0) {
            sessionStatus = 'interrupted';
          }

          await pool.query(`UPDATE recording_sessions SET ended_at = NOW(), status = $1 WHERE id = $2`, [
            sessionStatus,
            session.id,
          ]);
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

          // 会话状态判断
          let sessionStatus = 'completed';
          if (fileSize === 0 && code !== 0) {
            sessionStatus = 'interrupted';
          }

          await pool.query(
            `UPDATE recording_sessions SET ended_at = NOW(), status = $1, total_segments = 1, total_size = $2 WHERE id = $3`,
            [sessionStatus, fileSize, session.id]
          );

          if (/\.flv$/i.test(outputPath)) {
            try {
              const autoTranscode = await this.getSetting('auto_transcode', 'true');
              if (autoTranscode === 'true') {
                const mp4Path = outputPath.replace(/\.flv$/i, '.mp4');
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
    const MAX_RESUME_RETRIES = await this.getMaxResumeRetries();
    try {
      // 查询所有处于录制或暂停状态的房间
      const staleRooms = await pool.query(
        `SELECT id, room_url, room_name, ffmpeg_pid, output_path FROM rooms WHERE status IN ('recording', 'paused')`
      );

      // 清理每个陈旧房间的状态
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

      // 查询所有处于录制状态的会话
      const staleSessions = await pool.query(
        `SELECT rs.*, r.id as room_id, r.room_name FROM recording_sessions rs JOIN rooms r ON rs.room_url = r.room_url WHERE rs.status = 'recording'`
      );

      // 处理每个陈旧的录制会话
      for (const session of staleSessions.rows) {
        // 如果重试次数未达到上限，尝试恢复会话
        if ((session.retry_count || 0) < MAX_RESUME_RETRIES) {
          try {
            console.log(`[恢复] 尝试恢复会话 ${session.id} (直播间: ${session.room_url})`);
            await this.tryResumeSession(session);
            continue;
          } catch (err) {
            console.error(`[恢复] 会话 ${session.id} 恢复失败:`, err.message);
          }
        }

        // 标记会话和相关文件为中断状态
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














