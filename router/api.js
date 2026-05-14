const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const express = require('express');
const router = express.Router();
const config = require('../config/config');
const dayjs = require('dayjs');
const pool = require('../db/index');
const redis = require('../db/redis');
const { findAndAutoUpload } = require('./upload');
const notify = require('../lib/notify');
const { createProcLog } = require('../lib/proc-log');

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
    await redis.setEx(
      redisKey(room.room_url),
      ROOM_CACHE_TTL,
      JSON.stringify(room)
    );
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
    await redis.setEx(
      activeTaskKey(roomKey),
      ACTIVE_TASK_TTL,
      JSON.stringify(data)
    );
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

function generateFilename(template, roomName) {
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
  return sanitizeFilename(result) + '.mp4';
}

function templateToStrftime(template, roomName) {
  const roomNameSafe = sanitizeFilename(roomName || 'unknown').replace(
    /%/g,
    '%%'
  );
  return (
    template
      .replace(/{room_name}/g, roomNameSafe)
      .replace(/{datetime}/g, '%Y%m%d_%H%M%S')
      .replace(/{YYYY}/g, '%Y')
      .replace(/{MM}/g, '%m')
      .replace(/{DD}/g, '%d')
      .replace(/{HH}/g, '%H')
      .replace(/{mm}/g, '%M')
      .replace(/{ss}/g, '%S') + '.mp4'
  );
}

async function getOrCreateRoom(roomUrl, roomName) {
  const cached = await getRoomCache(roomUrl);
  if (cached) return cached;

  const exist = await pool.query('SELECT * FROM rooms WHERE room_url = $1', [
    roomUrl,
  ]);
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
    const data = { room: { id: room.id, room_url: room.room_url, room_name: room.room_name } };

    if (room.status === 'recording' || room.status === 'paused') {
      const session = await pool.query(
        `SELECT id, started_at FROM recording_sessions
         WHERE room_url = $1 AND status = 'recording'
         ORDER BY started_at DESC LIMIT 1`,
        [room.room_url]
      );
      data.status = room.status;
      if (session.rows.length) {
        data.session = { id: session.rows[0].id, started_at: session.rows[0].started_at };
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
  if (!req.body || !req.body.url || !req.body.title) {
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
    return res
      .status(400)
      .json({ status: 'Already recording', message: '请勿重复开启' });
  }

  let room;
  try {
    room = await getOrCreateRoom(roomKey, title);
  } catch (dbErr) {
    console.error('[api] 数据库操作失败:', dbErr);
    return res.status(500).json({ status: 'Error', message: '数据库操作失败' });
  }

  if (room.status === 'recording' || room.status === 'paused') {
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

  console.log(
    `[开始] 直播间 ${roomKey} 开始录制${caption ? ' - ' + caption : ''}`
  );

  const template = room.filename_template || '{room_name}_{datetime}';
  const segmentDuration = room.segment_duration || 0;
  const useSegment = segmentDuration > 0;

  let outputFilePattern;
  let segmentListPath;

  if (useSegment) {
    const strftimeName = templateToStrftime(template, room.room_name || title);
    outputFilePattern = path.join(DOWNLOAD_DIR, strftimeName);
  } else {
    const filename = generateFilename(template, room.room_name || title);
    outputFilePattern = path.join(DOWNLOAD_DIR, filename);
  }
  console.log(`[任务启动] 文件名模板: ${template}`);
  console.log(
    `[任务启动] 分段录制: ${useSegment ? segmentDuration + 's' : '关闭'}`
  );
  console.log(`[任务启动] 视频将保存至: ${outputFilePattern}`);

  const ffmpegArgs = ['-i', url, '-c', 'copy', '-fflags', '+genpts',
    '-timeout', '2147483647',
    '-reconnect', '1', '-reconnect_at_eof', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '60'];
  if (useSegment) {
    segmentListPath = path.join(
      DOWNLOAD_DIR,
      `.segments_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`
    );
    ffmpegArgs.push(
      '-f',
      'segment',
      '-segment_time',
      String(segmentDuration),
      '-reset_timestamps',
      '1',
      '-strftime',
      '1',
      '-segment_list',
      segmentListPath
    );
  }
  ffmpegArgs.push(outputFilePattern);

  const { fd: logFd, logPath, rename: renameLog } = createProcLog('ffmpeg');
  console.log(`[任务启动] ffmpeg 日志: ${logPath}`);

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'ignore', logFd] });

  ffmpeg.on('error', (err) => {
    console.error('FFmpeg 启动失败:', err);
  });

  let sessionId = null;
  const sessionStart = new Date();
  try {
    await pool.query(
      `UPDATE rooms SET status = 'recording', output_path = $1, ffmpeg_pid = $2, updated_at = NOW() WHERE id = $3`,
      [outputFilePattern, ffmpeg.pid, room.id]
    );
    await delRoomCache(room.room_url);

    const session = await pool.query(
      `INSERT INTO recording_sessions (room_url, started_at, output_dir, status, caption)
       VALUES ($1, $2, $3, 'recording', $4)
       RETURNING id`,
      [
        room.room_url,
        sessionStart,
        path.dirname(outputFilePattern),
        caption || '',
      ]
    );
    sessionId = session.rows[0].id;
    renameLog(sessionId);
  } catch (dbErr) {
    console.error('[api] 更新数据库状态失败:', dbErr);
    ffmpeg.kill();
    return res
      .status(500)
      .json({ status: 'Error', message: '更新数据库状态失败' });
  }

  // 非分段模式：预写入录制文件记录
  if (!useSegment) {
    try {
      await pool.query(
        `INSERT INTO recording_files (session_id, room_url, file_path, file_name, status)
         VALUES ($1, $2, $3, $4, 'recording')`,
        [sessionId, room.room_url, outputFilePattern, path.basename(outputFilePattern)]
      );
    } catch (dbErr) {
      console.warn('[api] recording_files 写入失败:', dbErr.message);
    }
  }

  await setActiveTask(roomKey, {
    pid: ffmpeg.pid,
    outputPath: outputFilePattern,
    roomId: room.id,
    sessionId,
    startTime: Date.now(),
  });

  ffmpeg.on('close', async (code) => {
    await delActiveTask(roomKey);
    console.log(`[${code}] 录制结束，路径: ${outputFilePattern} (日志: logs/ffmpeg_${sessionId}.log)`);

    try {
      await pool.query(
        `UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`,
        [room.id]
      );
      await delRoomCache(room.room_url);

      if (useSegment) {
        const segmentFiles = [];
        if (segmentListPath && fs.existsSync(segmentListPath)) {
          const content = fs.readFileSync(segmentListPath, 'utf-8');
          const lines = content
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
          for (const line of lines) {
            segmentFiles.push(
              path.isAbsolute(line) ? line : path.join(DOWNLOAD_DIR, line)
            );
          }
          try {
            fs.unlinkSync(segmentListPath);
          } catch (_) {}
        }

        let totalSize = 0;
        for (let i = 0; i < segmentFiles.length; i++) {
          const filePath = segmentFiles[i];
          let fileSize = 0;
          try {
            fileSize = fs.statSync(filePath).size;
          } catch (_) {}
          totalSize += fileSize;

          const segStart = new Date(
            sessionStart.getTime() + i * segmentDuration * 1000
          );
          const segEnd =
            i < segmentFiles.length - 1
              ? new Date(segStart.getTime() + segmentDuration * 1000)
              : new Date();

          await pool.query(
            `INSERT INTO recordings (session_id, segment_index, room_url, file_path, file_size, started_at, ended_at, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')`,
            [sessionId, i, room.room_url, filePath, fileSize, segStart, segEnd]
          );
          await pool.query(
            `INSERT INTO recording_files (session_id, room_url, file_path, file_name, file_size, status, completed_at)
             VALUES ($1, $2, $3, $4, $5, 'completed', NOW())`,
            [sessionId, room.room_url, filePath, path.basename(filePath), fileSize]
          );
        }

        if (sessionId) {
          await pool.query(
            `UPDATE recording_sessions
             SET ended_at = NOW(), status = $1, total_segments = $2, total_size = $3
             WHERE id = $4`,
            [
              code === 0 ? 'completed' : 'interrupted',
              segmentFiles.length,
              totalSize,
              sessionId,
            ]
          );
        }
        console.log(
          `[api] 分段录制完成, 共 ${segmentFiles.length} 个文件, ${(totalSize / 1024 / 1024).toFixed(1)}MB`
        );
      } else {
        let fileSize = 0;
        try {
          const stat = fs.statSync(outputFilePattern);
          fileSize = stat.size;
        } catch (statErr) {
          console.warn(
            `[api] 无法获取文件大小: ${outputFilePattern}`,
            statErr.message
          );
        }

        const result = await pool.query(
          `INSERT INTO recordings (session_id, segment_index, room_url, file_path, file_size, started_at, ended_at, status)
           VALUES ($1, 0, $2, $3, $4, $5, NOW(), 'completed')
           RETURNING id`,
          [sessionId, room.room_url, outputFilePattern, fileSize, sessionStart]
        );

        if (sessionId) {
          await pool.query(
            `UPDATE recording_sessions
             SET ended_at = NOW(), status = $1, total_segments = 1, total_size = $2
             WHERE id = $3`,
            [code === 0 ? 'completed' : 'interrupted', fileSize, sessionId]
          );
          await pool.query(
            `UPDATE recording_files SET file_size = $1, status = 'completed', completed_at = NOW()
             WHERE session_id = $2 AND file_path = $3`,
            [fileSize, sessionId, outputFilePattern]
          );
        }
      }

      if (code === 0 && sessionId) {
        try {
          const sess = await pool.query('SELECT total_segments, total_size FROM recording_sessions WHERE id = $1', [sessionId]);
          const segs = sess.rows[0]?.total_segments || 0;
          const mb = ((sess.rows[0]?.total_size || 0) / 1024 / 1024).toFixed(1);
          notify.recordingComplete(room.room_name, segs, mb, sessionId);
        } catch (_) {}

        const completedSession = {
          id: sessionId,
          room_url: room.room_url,
          room_name: room.room_name,
          started_at: sessionStart,
        };
        findAndAutoUpload(completedSession).catch((err) =>
          console.error('[自动投稿] 异常:', err.message)
        );
      }
    } catch (dbErr) {
      console.error('[api] 录制结束数据库更新失败:', dbErr);
    }
  });

  notify.recordingStart(room.room_name || title, caption);

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

module.exports = {
  router,
  sanitizeFilename,
  generateFilename,
  templateToStrftime,
  setActiveTask,
  delActiveTask,
  delRoomCache,
  activeTaskKey,
};
