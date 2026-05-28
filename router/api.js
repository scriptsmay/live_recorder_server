const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const router = express.Router();
const config = require('../config/config');
const pool = require('../db/index');
const redis = require('../db/redis');
const RecorderService = require('../services/RecorderService');
const DataService = require('../services/DataService');
const { getActiveDownloader } = require('../lib/core/downloaders/DownloaderFactory');
const transcodeQueue = require('../lib/core/TranscodeQueue');
const { scanRecordingFiles } = require('../lib/core/scan-files');
const hlsGenerator = require('../lib/core/hls-generator');

const DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR;
const { version } = require('../package.json');

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

router.get('/health', async (req, res) => {
  const data = {
    ok: true,
    app: true,
    db: false,
    redis: false,
    version,
  };

  try {
    await pool.query('SELECT 1');
    data.db = true;
  } catch (err) {
    data.ok = false;
    data.db_error = err.message;
  }

  try {
    data.redis = (await redis.ping()) === 'PONG';
  } catch (err) {
    data.ok = false;
    data.redis_error = err.message;
  }

  if (!data.redis) data.ok = false;
  res.status(data.ok ? 200 : 503).json(data);
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
    if (!config.MESSAGE_FEISHU_WEBHOOK) {
      return res.status(503).json({
        error: '未配置 MESSAGE_FEISHU_WEBHOOK',
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
    const room = await DataService.getRoomByUrl(url);
    if (!room) {
      return res.json({ exists: false });
    }
    let downloaderEngine = 'ffmpeg';
    try {
      const dl = getActiveDownloader(room.polling_platform);
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

router.get('/dashboard/status', async (req, res) => {
  try {
    // 活跃录制进程
    const activeKeys = await redis.keys('active_task:*');
    const activeRecordings = [];
    for (const key of activeKeys) {
      try {
        const data = JSON.parse(await redis.get(key));
        const roomUrl = key.replace('active_task:', '');
        let roomName = '';
        try {
          const room = await DataService.getRoomByUrl(roomUrl);
          roomName = room?.room_name || '';
        } catch (_) {}
        activeRecordings.push({
          room_url: roomUrl,
          room_name: roomName,
          pid: data.pid,
          session_id: data.sessionId,
          started_at: data.startTime,
          downloader: data.downloader || 'ffmpeg',
        });
      } catch (_) {}
    }

    // 转码队列状态
    const transcodeQueueLength = await transcodeQueue.getQueueLength();
    const transcodeProcessing = await transcodeQueue.getCurrentProcessingCount();
    const transcodeConcurrency = transcodeQueue.concurrency;

    // 池容量
    let poolSize = 3;
    try {
      const val = await DataService.getSetting('pool_size');
      if (val) poolSize = parseInt(val, 10) || 3;
    } catch (_) {}

    res.json({
      status: 'ok',
      data: {
        active_recordings: activeRecordings,
        active_count: activeRecordings.length,
        pool_size: poolSize,
        transcode: {
          queue_length: transcodeQueueLength,
          processing: transcodeProcessing,
          concurrency: transcodeConcurrency,
        },
      },
    });
  } catch (err) {
    console.error('[api] 仪表盘状态查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

router.get('/recording_files', async (req, res) => {
  try {
    const { status, session_id } = req.query;
    const data = await DataService.getRecordingFiles({ status, session_id });
    res.json({ status: 'ok', data });
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

    await pool.query("UPDATE recording_files SET session_id = $1, room_url = $2, status = 'completed' WHERE id = $3", [
      session_id,
      fileData.room_url || session.rows[0].room_url,
      id,
    ]);

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
    const deleteFile = req.query.delete_file === 'true';

    // 先查询记录，获取文件路径信息
    const fileResult = await pool.query(
      `SELECT id, file_path, is_hls_ready, hls_playlist_path FROM recording_files WHERE id = $1`,
      [id],
    );

    if (fileResult.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '记录不存在' });
    }

    const file = fileResult.rows[0];

    // 删除本地文件
    if (deleteFile) {
      const deletedPaths = [];

      // 删除主文件
      if (file.file_path) {
        try {
          if (fs.existsSync(file.file_path)) {
            fs.unlinkSync(file.file_path);
            deletedPaths.push(file.file_path);
          }
        } catch (err) {
          console.warn(`[api] 删除文件失败: ${file.file_path}`, err.message);
        }

        // 同时删除 recordings 表中的对应记录
        try {
          await pool.query('DELETE FROM recordings WHERE file_path = $1', [file.file_path]);
        } catch (_) {}
      }

      // 删除 HLS 目录
      if (file.is_hls_ready && file.hls_playlist_path) {
        try {
          const hlsDir = path.dirname(file.hls_playlist_path);
          if (fs.existsSync(hlsDir)) {
            fs.rmSync(hlsDir, { recursive: true, force: true });
            deletedPaths.push(hlsDir);
          }
        } catch (err) {
          console.warn(`[api] 删除 HLS 目录失败: ${file.hls_playlist_path}`, err.message);
        }
      }

      console.log(`[api] 已删除本地文件: ${deletedPaths.join(', ') || '(无)'}`);
    }

    // 删除数据库记录
    await pool.query('DELETE FROM recording_files WHERE id = $1', [id]);

    res.json({ status: 'ok', deletedFile: deleteFile });
  } catch (err) {
    console.error('[api] 删除录制记录失败:', err);
    res.status(500).json({ status: 'Error', message: '删除失败' });
  }
});

router.get('/recordings/:id/stream', async (req, res) => {
  try {
    const { id } = req.params;

    const fileResult = await pool.query('SELECT file_path FROM recording_files WHERE id = $1', [id]);
    const filePath = fileResult.rows[0]?.file_path;

    if (!filePath) {
      return res.status(404).json({ status: 'Error', message: '文件不存在' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ status: 'Error', message: '文件已从磁盘删除' });
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();

    // 如果不是mp4, 就直接拒绝(测试过 ts 也不行)
    if (ext !== '.mp4') {
      return res.status(400).json({ status: 'Error', message: '仅支持播放mp4文件' });
    }

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

router.get('/recordings/:id/hls', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'SELECT id, file_path, is_hls_ready, hls_playlist_path, hls_generated_at FROM recording_files WHERE id = $1',
      [id]
    );
    const recording = result.rows[0];

    if (!recording) {
      return res.status(404).json({ status: 'Error', message: '录制不存在' });
    }

    if (recording.is_hls_ready && recording.hls_playlist_path) {
      const exists = fs.existsSync(recording.hls_playlist_path);
      if (exists) {
        const videoDownloadDir = path.resolve(process.env.VIDEO_DOWNLOAD_DIR || '.');
        const relativePath = path.relative(videoDownloadDir, recording.hls_playlist_path);
        return res.json({
          status: 'ok',
          data: {
            is_ready: true,
            playlist_path: recording.hls_playlist_path,
            relative_path: relativePath,
            generated_at: recording.hls_generated_at,
            type: 'recording_file',
          },
        });
      }
    }

    res.json({
      status: 'ok',
      data: {
        is_ready: false,
        source_file: recording.file_path,
        type: 'recording_file',
      },
    });
  } catch (err) {
    console.error('[api] HLS 状态查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

const SUPPORTED_TRANSCODE_EXT = /\.(ts|flv|m2ts)$/i;

router.post('/recordings/:id/generate-hls', async (req, res) => {
  try {
    const { id } = req.params;

    const recordingResult = await pool.query('SELECT id, file_path FROM recording_files WHERE id = $1', [id]);

    if (recordingResult.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '录制不存在' });
    }

    const recording = recordingResult.rows[0];

    if (!recording.file_path || !fs.existsSync(recording.file_path)) {
      return res.status(400).json({ status: 'Error', message: '源文件不存在' });
    }

    console.log(`[api] 开始生成 HLS: recording_id=${id}`);
    const genResult = await hlsGenerator.generateForRecording(id, 'recording_file');

    if (genResult.success) {
      res.json({
        status: 'ok',
        data: {
          playlist_path: genResult.playlistPath,
          already_exists: genResult.alreadyExists || false,
        },
      });
    } else {
      res.status(500).json({ status: 'Error', message: genResult.error || 'HLS 生成失败' });
    }
  } catch (err) {
    console.error('[api] HLS 生成失败:', err);
    res.status(500).json({ status: 'Error', message: 'HLS 生成失败' });
  }
});

router.post('/recordings/:id/transcode', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT rf.id, rf.file_path, rf.session_id
       FROM recording_files rf
       WHERE rf.id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '录制记录不存在' });
    }

    const file = result.rows[0];

    if (!file.file_path || !fs.existsSync(file.file_path)) {
      return res.status(400).json({ status: 'Error', message: '源文件不存在于磁盘' });
    }

    if (!SUPPORTED_TRANSCODE_EXT.test(file.file_path)) {
      return res.status(400).json({ status: 'Error', message: '仅支持 .ts / .flv / .m2ts 文件转码' });
    }

    // 检查是否已存在转码记录（queued 或 processing 状态）
    const existingRecord = await pool.query(
      `SELECT id, status FROM transcode_records WHERE original_path = $1 AND status IN ('queued', 'processing')`,
      [file.file_path],
    );

    if (existingRecord.rows.length > 0) {
      return res.status(409).json({ status: 'Error', message: '该文件已在转码队列中' });
    }

    const mp4Path = file.file_path.replace(SUPPORTED_TRANSCODE_EXT, '.mp4');

    await transcodeQueue.enqueue({
      videoPathToTrans: file.file_path,
      mp4Path,
      sessionId: file.session_id,
      force: true,
    });

    console.log(`[api] 手动转码入队: ${file.file_path}`);
    res.json({ status: 'ok', message: '已加入转码队列' });
  } catch (err) {
    console.error('[api] 手动转码失败:', err);
    res.status(500).json({ status: 'Error', message: '手动转码失败' });
  }
});

module.exports = {
  router,
};
