const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const express = require('express');
const router = express.Router();
const config = require('../config/config');
const dayjs = require('dayjs');
const pool = require('../db/index');

const DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR;

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

async function getOrCreateRoom(roomUrl, roomName) {
  const exist = await pool.query('SELECT * FROM rooms WHERE room_url = $1', [roomUrl]);
  if (exist.rows.length > 0) {
    return exist.rows[0];
  }
  const result = await pool.query(
    `INSERT INTO rooms (room_url, room_name)
     VALUES ($1, $2)
     RETURNING *`,
    [roomUrl, roomName || '']
  );
  return result.rows[0];
}

const activeTasks = new Map();

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
            { name: 'title', description: '直播标题', required: true },
            { name: 'room_url', description: '直播间地址（唯一标识）', required: true },
          ],
        },
      ],
    },
  });
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

  const { url, title, room_url } = req.body;
  const roomKey = room_url || url;

  if (activeTasks.has(roomKey)) {
    return res.status(400).json({ status: 'Already recording', message: '请勿重复开启' });
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

  console.log(`[开始] 直播间 ${roomKey} 开始录制`);

  const template = room.filename_template || '{room_name}_{datetime}';
  const filename = generateFilename(template, title);
  const outputFilePath = path.join(DOWNLOAD_DIR, filename);
  console.log(`[任务启动] 文件名模板: ${template} → ${filename}`);
  console.log(`[任务启动] 视频将保存至: ${outputFilePath}`);

  const ffmpeg = spawn('ffmpeg', [
    '-i', url,
    '-c', 'copy',
    '-fflags', '+genpts',
    outputFilePath,
  ]);

  ffmpeg.on('error', (err) => {
    console.error('FFmpeg 启动失败:', err);
  });

  let recordingId = null;
  try {
    await pool.query(
      `UPDATE rooms SET status = 'recording', output_path = $1, ffmpeg_pid = $2, updated_at = NOW() WHERE id = $3`,
      [outputFilePath, ffmpeg.pid, room.id]
    );
    const rec = await pool.query(
      `INSERT INTO recordings (room_url, file_path, started_at, status)
       VALUES ($1, $2, NOW(), 'recording')
       RETURNING id`,
      [room.room_url, outputFilePath]
    );
    recordingId = rec.rows[0].id;
  } catch (dbErr) {
    console.error('[api] 更新数据库状态失败:', dbErr);
    ffmpeg.kill();
    return res.status(500).json({ status: 'Error', message: '更新数据库状态失败' });
  }

  activeTasks.set(roomKey, { pid: ffmpeg.pid, outputPath: outputFilePath });

  ffmpeg.on('close', async (code) => {
    activeTasks.delete(roomKey);
    console.log(`[${code}] 录制结束，路径: ${outputFilePath}`);

    let fileSize = 0;
    try {
      const stat = fs.statSync(outputFilePath);
      fileSize = stat.size;
    } catch (_) {}

    try {
      await pool.query(
        `UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`,
        [room.id]
      );
      if (recordingId) {
        await pool.query(
          `UPDATE recordings SET ended_at = NOW(), file_size = $1, status = $2 WHERE id = $3`,
          [fileSize, code === 0 ? 'completed' : 'interrupted', recordingId]
        );
      }
    } catch (dbErr) {
      console.error('[api] 录制结束数据库更新失败:', dbErr);
    }
  });

  res.status(200).json({
    status: 'Recording started',
    data: {
      room_id: room.id,
      room_url: room.room_url,
      filename,
      path: outputFilePath,
    },
  });
});

module.exports = router;
