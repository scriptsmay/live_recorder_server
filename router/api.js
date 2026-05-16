const path = require('path');
const fs = require('fs');
const axios = require('axios');
const express = require('express');
const router = express.Router();
const config = require('../config/config');
const dayjs = require('dayjs');
const pool = require('../db/index');
const redis = require('../db/redis');
const { findAndAutoUpload } = require('./upload');
const notify = require('../lib/notify');
const { createProcLog } = require('../lib/proc-log');
const { scanRecordingFiles } = require('../lib/scan-files');
const { getActiveDownloader } = require('../lib/downloaders/DownloaderFactory');
const { updateHeartbeat, clearHeartbeat } = require('../lib/heartbeat-tracker');
const { watchRoom, unwatchRoom } = require('../lib/file-watcher');

const DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR;

const ROOM_CACHE_TTL = 300; // 5 分钟
const ACTIVE_TASK_TTL = 86400; // 24 小时

function redisKey(roomUrl) {
  return `room:${roomUrl}`;
}

function activeTaskKey(roomKey) {
  return `active_task:${roomKey}`;
}

async function getRoomCache(roomUrl) {
  try {
    const data = await redis.get(redisKey(roomUrl));
    if (data) return JSON.parse(data);
  } catch (_) {}
  return null;
}

async function setRoomCache(room) {
  try {
    await redis.setEx(redisKey(room.room_url), ROOM_CACHE_TTL, JSON.stringify(room));
  } catch (_) {}
}

async function delRoomCache(roomUrl) {
  try {
    await redis.del(redisKey(roomUrl));
  } catch (_) {}
}

async function isActiveTask(roomKey) {
  try {
    const exists = await redis.exists(activeTaskKey(roomKey));
    return exists === 1;
  } catch (_) {
    return false;
  }
}

async function setActiveTask(roomKey, data) {
  try {
    await redis.setEx(activeTaskKey(roomKey), ACTIVE_TASK_TTL, JSON.stringify(data));
  } catch (_) {}
}

async function delActiveTask(roomKey) {
  try {
    await redis.del(activeTaskKey(roomKey));
  } catch (_) {}
}

function sanitizeFilename(name) {
  return name
    .replace(/[\\/:\*\?"<>\|\x00-\x1F\x7F]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function generateFilename(template, roomName, ext = '.mp4') {
  const now = dayjs();
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

function templateToStrftime(template, roomName, ext = '.mp4') {
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

async function getOrCreateRoom(roomUrl, roomName) {
  const cached = await getRoomCache(roomUrl);
  if (cached) return cached;

  const exist = await pool.query('SELECT * FROM rooms WHERE room_url = $1', [roomUrl]);
  if (exist.rows.length > 0) {
    const room = exist.rows[0];
    await setRoomCache(room);
    return room;
  }
  const result = await pool.query(
    `INSERT INTO rooms (room_url, room_name)
     VALUES ($1, $2)
     RETURNING *`,
    [roomUrl, roomName || '']
  );
  const room = result.rows[0];
  await setRoomCache(room);
  return room;
}

router.get('/', (req, res) => {
  res.status(200).json({
    message: '欢迎使用API服务。',
    status: 'ok',
    data: {
      apiList: [
        {
          name: '自动启动直播录制接口',
          description:
            `直播录制接口，请提供直播流URL、标题和直播间地址。录制文件将保存在目录：[${DOWNLOAD_DIR}]。` +
            `直播间将自动创建，支持自定义文件名模板。`,
          url: config.SITE_URL + 'api/notify/live_download',
          method: 'POST',
          params: [
            { name: 'url', description: '直播流URL', required: true },
            {
              name: 'title',
              description: '直播标题（用于直播间名称）',
              required: true,
            },
            {
              name: 'caption',
              description: '直播描述/备注（可选）',
              required: false,
            },
            {
              name: 'room_url',
              description: '直播间地址（唯一标识）',
              required: true,
            },
          ],
        },
      ],
    },
  });
});

/**
 * POST /api/notify/feishu_webhook 飞书机器人Webhook
 * @param {*} req body { title: '标题', content: '内容' }
 * @param {*} res
 */
router.post('/notify/feishu_webhook', async (req, res) => {
  try {
    let { title = '', content = '' } = req.query;
    console.log('[DEBUG]request data:----->', req.body);
    if (req.body.title) {
      title = req.body.title;
    }
    if (req.body.content) {
      content = req.body.content;
    }
    if (!title) {
      return res.status(400).json({
        error: '缺少必填参数 title',
      });
    }

    const sendContent = `${title}\n${content}\n${dayjs().format('YYYY-MM-DD HH:mm:ss')}`;
    // 转发请求
    const response = await axios({
      url: config.MESSAGE_FEISHU_WEBHOOK,
      method: 'post',
      data: {
        msg_type: 'text',
        content: {
          text: sendContent,
        },
      },
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // 将目标服务的响应返回给客户端
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error('转发请求时出错:', error);

    // 错误处理
    if (error.response) {
      // 目标服务器返回了错误响应
      res.status(error.response.status).json({
        error: '转发请求失败',
        details: error.response.data,
      });
    } else {
      // 其他类型的错误
      res.status(500).json({
        error: '内部服务器错误',
        details: error.message,
      });
    }
  }
});

router.get('/notify/status', async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ exists: false, message: '缺少 url 参数' });
  }

  try {
    const result = await pool.query('SELECT * FROM rooms WHERE room_url = $1', [url]);
    if (result.rows.length === 0) {
      return res.json({ exists: false });
    }

    const room = result.rows[0];
    let downloaderEngine = 'ffmpeg';
    try {
      const dl = await getActiveDownloader();
      downloaderEngine = dl.name;
    } catch (_) {}
    const data = {
      room: { id: room.id, room_url: room.room_url, room_name: room.room_name },
      downloader: downloaderEngine,
    };

    if (room.monitoring_enabled === false) {
      data.status = 'monitoring_paused';
      data.monitoring_paused = true;
    } else if (room.status === 'recording' || room.status === 'paused') {
      const session = await pool.query(
        `SELECT id, started_at FROM recording_sessions
         WHERE room_url = $1 AND status = 'recording'
         ORDER BY started_at DESC LIMIT 1`,
        [room.room_url]
      );
      data.status = room.status;
      if (session.rows.length) {
        data.session = {
          id: session.rows[0].id,
          started_at: session.rows[0].started_at,
        };
      }
    } else {
      data.status = 'idle';
    }

    res.json({ exists: true, data });
  } catch (err) {
    console.error('[api] 状态查询失败:', err);
    res.status(500).json({ exists: false, message: '查询失败' });
  }
});

router.post('/notify/live_download', async (req, res) => {
  console.log('[api] 收到录制请求:', {
    title: req.body?.title,
    room_url: req.body?.room_url,
    url: req.body?.url?.slice(0, 60),
  });

  if (!req.body || !req.body.url || !req.body.title) {
    console.log('[api] 录制请求被拒: 缺少必填参数 (body/url/title)');
    return res.status(400).json({
      status: 'Error',
      message: '请提供直播流URL和标题。',
    });
  }
  if (!DOWNLOAD_DIR) {
    return res.status(500).json({
      status: 'Error',
      message: '请设置 VIDEO_DOWNLOAD_DIR 环境变量，并确保该目录已存在。',
    });
  }
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }

  const { url, title, caption, room_url } = req.body;
  const roomKey = room_url || url;

  if (await isActiveTask(roomKey)) {
    console.log('[api] 录制请求被拒: active_task 已存在 (roomKey=' + roomKey + ')');
    return res.status(400).json({ status: 'Already recording', message: '请勿重复开启' });
  }

  let poolSize = 3;
  try {
    const ps = await pool.query("SELECT value FROM settings WHERE key = 'pool_size'");
    if (ps.rows.length) poolSize = parseInt(ps.rows[0].value, 10) || 3;
  } catch (_) {}
  let activeKeys = [];
  try {
    activeKeys = await redis.keys('active_task:*');
  } catch (_) {}
  if (activeKeys.length >= poolSize) {
    return res.status(429).json({
      status: 'Pool full',
      message: `下载线程池已满 (${activeKeys.length}/${poolSize})，请等待其他录制完成`,
    });
  }

  let room;
  try {
    room = await getOrCreateRoom(roomKey, title);
  } catch (dbErr) {
    console.error('[api] 数据库操作失败:', dbErr);
    return res.status(500).json({ status: 'Error', message: '数据库操作失败' });
  }

  if (room.monitoring_enabled === false) {
    console.log('[api] 录制请求被拒: monitoring_enabled=false (room=' + room.id + ')');
    return res.status(400).json({
      status: 'Monitoring paused',
      message: `直播间 ${room.room_name || room.room_url} 已暂停监听`,
    });
  }

  if (room.status === 'recording' || room.status === 'paused') {
    console.log('[api] 录制请求被拒: 房间状态=' + room.status + ' (room=' + room.id + ')');
    return res.status(400).json({
      status: 'Already recording',
      message: `直播间 ${room.room_name || room.room_url} 已在录制中`,
    });
  }

  // 关闭可能残留的旧会话（ffmpeg 异常退出时 session 状态未更新）
  await pool.query(
    `UPDATE recording_sessions SET ended_at = NOW(), status = 'interrupted'
     WHERE room_url = $1 AND status = 'recording'`,
    [room.room_url]
  );

  // 下播延迟检测：如果上次会话刚结束，续到同一个会话
  let reuseSession = false;
  let resumeCount = 0;
  try {
    const ps = await pool.query("SELECT value FROM settings WHERE key = 'delay'");
    const delay = parseInt(ps.rows[0]?.value, 10) || 60;
    if (delay > 0) {
      const lockKey = `lock:resume:${room.id}`;
      const lockAcquired = await redis.set(lockKey, '1', { EX: 10, NX: true }).catch(() => null);
      if (!lockAcquired) {
        console.log(`[续播] ${room.room_name || room.room_url} 续播锁占用中，跳过`);
      } else {
        const recent = await pool.query(
          `SELECT id, total_segments, total_size FROM recording_sessions
           WHERE room_url = $1 AND status IN ('completed', 'interrupted')
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

  console.log(`[开始] 直播间 ${roomKey} 开始录制${caption ? ' - ' + caption : ''}`);

  const downloader = await getActiveDownloader();

  const template = room.filename_template || '{room_name}_{datetime}';
  const segmentDuration = room.segment_duration || 0;
  const useSegment = segmentDuration > 0;
  const ext = downloader.getExtension();

  let outputFilePattern;
  let segmentListPath;

  if (useSegment) {
    if (downloader.name === 'ffmpeg') {
      const strftimeName = templateToStrftime(template, room.room_name || title, ext);
      outputFilePattern = path.join(DOWNLOAD_DIR, strftimeName);
    } else {
      const baseName = generateFilename(template, room.room_name || title, '');
      outputFilePattern = path.join(DOWNLOAD_DIR, baseName + ext);
    }
  } else {
    const filename = generateFilename(template, room.room_name || title, ext);
    outputFilePattern = path.join(DOWNLOAD_DIR, filename);
  }
  if (reuseSession && !useSegment && room.output_path) {
    // 非分段续播：复用上一次的输出文件，避免碎片
    const prevOutput = room.output_path;
    if (fs.existsSync(path.dirname(prevOutput))) {
      console.log(`[续播] 复用上次文件路径: ${prevOutput}`);
      outputFilePattern = prevOutput;
    }
  }

  console.log(`[任务启动] 文件名模板: ${template}`);
  console.log(`[任务启动] 分段录制: ${useSegment ? segmentDuration + 's' : '关闭'}`);
  console.log(`[任务启动] 视频将保存至: ${outputFilePattern}`);

  if (useSegment) {
    segmentListPath = path.join(DOWNLOAD_DIR, `.segments_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`);
  }

  const dlArgs = downloader.buildArgs(url, outputFilePattern, { segmentDuration, segmentListPath });

  const { stream: logStream, logPath, rename: renameLog, logCommand } = createProcLog(downloader.name);
  console.log(`[任务启动] 下载引擎: ${downloader.name}, 日志: ${logPath}`);
  logCommand(downloader.name, dlArgs);

  const dlProcess = downloader.spawn(dlArgs);

  if (dlProcess.stderr) {
    dlProcess.stderr.on('data', (chunk) => {
      logStream.write(chunk);
      updateHeartbeat(roomKey, chunk);
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

  let sessionId = null;
  const sessionStart = new Date();
  try {
    await pool.query(
      `UPDATE rooms SET status = 'recording', output_path = $1, ffmpeg_pid = $2, updated_at = NOW() WHERE id = $3`,
      [outputFilePattern, dlProcess.pid, room.id]
    );
    await delRoomCache(room.room_url);

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
  } catch (dbErr) {
    console.error('[api] 更新数据库状态失败:', dbErr);
    dlProcess.kill();
    return res.status(500).json({ status: 'Error', message: '更新数据库状态失败' });
  }

  // 非分段模式：预写入录制文件记录（续播时更新已有记录）
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

  await setActiveTask(roomKey, {
    pid: dlProcess.pid,
    outputPath: outputFilePattern,
    roomId: room.id,
    sessionId,
    startTime: Date.now(),
    downloader: downloader.name,
  });

  if (useSegment) {
    watchRoom(room.room_url, path.dirname(outputFilePattern), sessionId);
  }

  dlProcess.on('close', async (code) => {
    unwatchRoom(room.room_url, path.dirname(outputFilePattern), sessionId);
    clearHeartbeat(roomKey);
    await delActiveTask(roomKey);
    console.log(`[${code}] 录制结束，路径: ${outputFilePattern} (日志: logs/${downloader.name}_${sessionId}.log)`);

    try {
      await pool.query(`UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`, [
        room.id,
      ]);
      await delRoomCache(room.room_url);

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
        } else if (downloader.name !== 'ffmpeg' && outputFilePattern) {
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
            console.error('[api] stream-gears 分段文件扫描失败:', err.message);
          }
        }

        let thresholdBytes = 0;
        try {
          const ps = await pool.query("SELECT value FROM settings WHERE key = 'filtering_threshold'");
          if (ps.rows.length) thresholdBytes = (parseInt(ps.rows[0].value, 10) || 10) * 1024 * 1024;
        } catch (_) {}
        let totalSize = 0;
        let newFileCount = 0;
        for (const filePath of segmentFiles) {
          const tracked = await pool.query('SELECT id FROM recording_files WHERE file_path = $1', [filePath]);
          if (tracked.rows.length > 0) continue;

          let fileSize = 0;
          try {
            fileSize = fs.statSync(filePath).size;
          } catch (_) {}
          // 跳过碎片
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
      } else {
        let fileSize = 0;
        try {
          const stat = fs.statSync(outputFilePattern);
          fileSize = stat.size;
        } catch (statErr) {
          console.warn(`[api] 无法获取文件大小: ${outputFilePattern}`, statErr.message);
        }

        // 续播时更新已有 recordings 记录，避免重复插入
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
      }

      if (code === 0 && sessionId) {
        try {
          const sess = await pool.query('SELECT total_segments, total_size FROM recording_sessions WHERE id = $1', [
            sessionId,
          ]);
          const segs = sess.rows[0]?.total_segments || 0;
          const mb = ((sess.rows[0]?.total_size || 0) / 1024 / 1024).toFixed(1);
          notify.recordingComplete(room.room_name, segs, mb, sessionId, room.room_url);
        } catch (_) {}

        const completedSession = {
          id: sessionId,
          room_url: room.room_url,
          room_name: room.room_name,
          started_at: sessionStart,
        };
        findAndAutoUpload(completedSession).catch((err) => console.error('[自动投稿] 异常:', err.message));
      }
    } catch (dbErr) {
      console.error('[api] 录制结束数据库更新失败:', dbErr);
    }
  });

  notify.recordingStart(room.room_name || title, caption, room.room_url);

  res.status(200).json({
    status: 'Recording started',
    data: {
      room_id: room.id,
      room_url: room.room_url,
      session_id: sessionId,
      path: outputFilePattern,
    },
  });
});

// POST /api/scan_files — 触发磁盘扫描
router.post('/scan_files', async (req, res) => {
  try {
    const force = req.body?.force === true;
    const r = await scanRecordingFiles(force);
    res.json({ status: 'ok', data: r });
  } catch (err) {
    console.error('[api] 扫描失败:', err);
    res.status(500).json({ status: 'Error', message: '扫描失败' });
  }
});

// GET /api/recording_files — 查询文件跟踪记录
router.get('/recording_files', async (req, res) => {
  try {
    const { status, session_id } = req.query;
    const conditions = [];
    const params = [];
    if (status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    }
    if (session_id) {
      conditions.push(`session_id = $${params.length + 1}`);
      params.push(parseInt(session_id));
    }
    let sql = 'SELECT * FROM recording_files';
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY id DESC';
    const result = await pool.query(sql, params);
    res.json({ status: 'ok', data: result.rows });
  } catch (err) {
    console.error('[api] recording_files 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

// PUT /api/recording_files/:id/associate — 将孤文件关联到录制会话
router.put('/recording_files/:id/associate', async (req, res) => {
  try {
    const { id } = req.params;
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ status: 'Error', message: '缺少 session_id' });

    const file = await pool.query('SELECT * FROM recording_files WHERE id = $1', [id]);
    if (file.rows.length === 0) return res.status(404).json({ status: 'Error', message: '文件不存在' });
    if (file.rows[0].status !== 'orphaned') return res.status(400).json({ status: 'Error', message: '仅孤文件可关联' });

    const session = await pool.query('SELECT * FROM recording_sessions WHERE id = $1', [session_id]);
    if (session.rows.length === 0) return res.status(404).json({ status: 'Error', message: '会话不存在' });

    const fp = file.rows[0];
    const ss = session.rows[0];
    const fileSize = fp.file_size || 0;

    await pool.query(
      `UPDATE recording_files SET session_id = $1, room_url = $2, status = 'completed', checked_at = NOW() WHERE id = $3`,
      [session_id, ss.room_url, id]
    );
    await pool.query(
      `INSERT INTO recordings (session_id, segment_index, room_url, file_path, file_size, started_at, ended_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'completed')`,
      [session_id, ss.total_segments || 0, ss.room_url, fp.file_path, fileSize, fp.started_at]
    );
    await pool.query(
      `UPDATE recording_sessions SET total_segments = total_segments + 1, total_size = total_size + $1 WHERE id = $2`,
      [fileSize, session_id]
    );

    res.json({ status: 'ok', message: '已关联' });
  } catch (err) {
    console.error('[api] 关联失败:', err);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

// DELETE /api/recording_files/missing — 一键删除所有缺失文件记录
router.delete('/recording_files/missing', async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM recording_files WHERE status = 'missing'");
    res.json({ status: 'ok', message: `已删除 ${result.rowCount} 条缺失记录` });
  } catch (err) {
    console.error('[api] 清空缺失记录失败:', err);
    res.status(500).json({ status: 'Error', message: '删除失败' });
  }
});

// GET /api/recordings/:id/stream — 流式播放录制文件
router.get('/recordings/:id/stream', async (req, res) => {
  try {
    const { id } = req.params;
    let result = await pool.query('SELECT file_path FROM recordings WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      result = await pool.query('SELECT file_path FROM recording_files WHERE id = $1', [id]);
    }
    if (result.rows.length === 0) return res.status(404).json({ status: 'Error', message: '文件不存在' });
    const filePath = result.rows[0].file_path;
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ status: 'Error', message: '文件不存在' });

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      '.mp4': 'video/mp4',
      '.flv': 'video/x-flv',
      '.ts': 'video/mp2t',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
    };
    const contentType = mimeMap[ext] || 'application/octet-stream';

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      const stream = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    console.error('[api] 视频流失败:', err);
    res.status(500).json({ status: 'Error', message: '流媒体失败' });
  }
});

module.exports = {
  router,
  sanitizeFilename,
  generateFilename,
  templateToStrftime,
  setActiveTask,
  delActiveTask,
  delRoomCache,
  activeTaskKey,
  getActiveDownloader,
};
