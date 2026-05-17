const axios = require('axios');
const express = require('express');
const router = express.Router();
const config = require('../config/config');
const pool = require('../db/index');
const RecorderService = require('../services/RecorderService');
const { getActiveDownloader } = require('../lib/core/downloaders/DownloaderFactory');
const { scanRecordingFiles } = require('../lib/core/scan-files');

const DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR;

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

    const sendContent = `${title}\n${content}\n${new Date().toISOString()}`;
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

    res.status(response.status).json(response.data);
  } catch (error) {
    console.error('转发请求时出错:', error);

    if (error.response) {
      res.status(error.response.status).json({
        error: '转发请求失败',
        details: error.response.data,
      });
    } else {
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
  const { url, title, caption, room_url } = req.body;
  const result = await RecorderService.startRecording({ url, title, caption, room_url });

  if (result.error) {
    return res.status(result.status || 200).json({
      status: result.status_str || 'Error',
      code: result.code,
      message: result.message,
    });
  }

  return res.status(200).json({
    status: 'Recording started',
    data: {
      room_id: result.room.id,
      room_url: result.room.room_url,
      session_id: result.sessionId,
      path: result.outputFilePattern,
    },
  });
});

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

    const fileData = file.rows[0];

    await pool.query("UPDATE recording_files SET session_id = $1, status = 'completed' WHERE id = $2", [
      session_id,
      id,
    ]);

    await pool.query(
      `INSERT INTO recordings (session_id, room_url, file_path, file_size, started_at, ended_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed')
       ON CONFLICT (file_path) DO UPDATE SET session_id = $1, status = 'completed'`,
      [
        session_id,
        fileData.room_url || session.rows[0].room_url,
        fileData.file_path,
        fileData.file_size,
        fileData.created_at,
        fileData.completed_at || new Date(),
      ]
    );

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[api] 关联失败:', err);
    res.status(500).json({ status: 'Error', message: '关联失败' });
  }
});

router.delete('/recording_files/missing', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM recording_files WHERE status = $1', ['missing']);
    res.json({ status: 'ok', deleted_count: result.rowCount });
  } catch (err) {
    console.error('[api] 删除缺失文件失败:', err);
    res.status(500).json({ status: 'Error', message: '删除失败' });
  }
});

router.delete('/recordings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM recordings WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ status: 'Error', message: '记录不存在' });
    }
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[api] 删除录制记录失败:', err);
    res.status(500).json({ status: 'Error', message: '删除失败' });
  }
});

const fs = require('fs');
const path = require('path');

router.get('/recordings/:id/stream', async (req, res) => {
  try {
    const { id } = req.params;

    let fileResult = await pool.query('SELECT file_path FROM recordings WHERE id = $1', [id]);
    let filePath = fileResult.rows[0]?.file_path;

    if (!filePath) {
      fileResult = await pool.query('SELECT file_path FROM recording_files WHERE id = $1', [id]);
      filePath = fileResult.rows[0]?.file_path;
    }

    if (!filePath) {
      return res.status(404).json({ status: 'Error', message: '文件不存在' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ status: 'Error', message: '文件已从磁盘删除' });
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();

    let contentType = 'application/octet-stream';
    if (ext === '.mp4') contentType = 'video/mp4';
    else if (ext === '.flv') contentType = 'video/x-flv';
    else if (ext === '.ts' || ext === '.m2ts') contentType = 'video/mp2t';
    else if (ext === '.webm') contentType = 'video/webm';
    else if (ext === '.mkv') contentType = 'video/x-matroska';
    else if (ext === '.avi') contentType = 'video/x-msvideo';
    else if (ext === '.mov') contentType = 'video/quicktime';

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
      });

      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      });

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    }
  } catch (err) {
    console.error('[api] 流播放失败:', err);
    res.status(500).json({ status: 'Error', message: '播放失败' });
  }
});

module.exports = {
  router,
};
