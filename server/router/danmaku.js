const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();
const pool = require('../db/index');
const danmakuRecorder = require('../lib/core/danmaku/DanmakuRecorder');
const danmakuAssGenerator = require('../lib/core/danmaku/DanmakuAssGenerator');
const danmakuBurnQueue = require('../lib/core/DanmakuBurnQueue');
const watchdog = require('../lib/core/watchdog');
const DataService = require('../services/DataService');

/**
 * GET /api/sessions/:id/danmaku-page
 * 弹幕详情页 JSON 数据（Vue 前端用）
 */
router.get('/sessions/:id/danmaku-page', async (req, res) => {
  try {
    const { id } = req.params;
    const detail = await DataService.getSessionDetail(id);

    if (!detail) {
      return res.status(404).json({ status: 'Error', message: '会话不存在' });
    }

    // 不暴露 output_dir 给前端
    if (detail.session) {
      delete detail.session.output_dir;
    }

    res.json({ status: 'ok', data: detail });
  } catch (err) {
    console.error('[api] 弹幕详情页数据加载失败:', err.message);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

/**
 * POST /api/danmaku/batch
 * 接收 Chrome Extension 批量推送的弹幕数据
 */
router.post('/danmaku/batch', async (req, res) => {
  try {
    const { room_url, events } = req.body;

    if (!room_url || !Array.isArray(events)) {
      return res.status(400).json({ status: 'Error', message: '缺少 room_url 或 events' });
    }

    // 写入 JSONL
    const result = danmakuRecorder.writeBatch(room_url, events);

    res.json({
      status: 'ok',
      written: result.written,
      error: result.error,
    });
  } catch (err) {
    console.error('[api] 弹幕批量接收失败:', err.message);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

/**
 * POST /api/sessions/:id/danmaku/ass
 * 手动重新生成会话的 ASS 字幕
 */
router.post('/sessions/:id/danmaku/ass', async (req, res) => {
  try {
    const { id: sessionId } = req.params;
    const { videoWidth, videoHeight, offsetMs } = req.body || {};

    // 获取会话信息
    const session = await pool.query(`SELECT id, output_dir FROM recording_sessions WHERE id = $1`, [sessionId]);

    if (session.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '会话不存在' });
    }

    const sessionDir = session.rows[0].output_dir;
    const danmakuDir = path.join(sessionDir, 'danmaku');
    fs.mkdirSync(danmakuDir, { recursive: true });
    // 优先使用新路径，兼容旧路径
    const newJsonlPath = path.join(danmakuDir, 'danmaku.jsonl');
    const oldJsonlPath = path.join(sessionDir, 'danmaku.jsonl');
    const jsonlPath = fs.existsSync(newJsonlPath) ? newJsonlPath : oldJsonlPath;

    if (!fs.existsSync(jsonlPath)) {
      return res.status(404).json({ status: 'Error', message: '弹幕数据文件不存在' });
    }

    // 生成会话级 ASS
    const assPath = path.join(danmakuDir, 'danmaku.ass');
    const assResult = await danmakuAssGenerator.generateFromJsonl({
      jsonlPath,
      assPath,
      videoWidth: videoWidth || 1920,
      videoHeight: videoHeight || 1080,
      offsetMs: offsetMs || 0,
    });

    if (!assResult.success) {
      return res.status(500).json({ status: 'Error', message: assResult.error });
    }

    // 更新采集记录的 ASS 路径
    await pool.query(`UPDATE danmaku_capture_records SET ass_path = $1 WHERE session_id = $2`, [assPath, sessionId]);

    await pool.query(
      `UPDATE danmaku_capture_records dcr
       SET status = 'completed',
           ended_at = COALESCE(dcr.ended_at, s.ended_at, NOW()),
           event_count = GREATEST(COALESCE(dcr.event_count, 0), $1)
       FROM recording_sessions s
       WHERE dcr.session_id = s.id
         AND dcr.session_id = $2
         AND dcr.status = 'recording'
         AND s.status IN ('completed', 'interrupted')`,
      [assResult.eventCount, sessionId]
    );

    // 检查是否有分段时间缺失（segment_start_ms = 0），如有则用 ffprobe 补充
    const missingTimes = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM recording_files
       WHERE session_id = $1
         AND (segment_end_ms = 0 OR (segment_index > 1 AND segment_start_ms = 0))`,
      [sessionId]
    );
    if (parseInt(missingTimes.rows[0].cnt, 10) > 0) {
      console.log(`[弹幕ASS] 会话 ${sessionId} 有 ${missingTimes.rows[0].cnt} 个分段缺少时间信息，尝试 ffprobe 补充`);
      await watchdog.backfillSegmentTimes(sessionId, pool);
    }

    // 为每个分段生成分段 ASS（重新查询以获取补充后的时间）
    const segments = await pool.query(
      `SELECT id, segment_index, segment_start_ms, segment_end_ms, file_path FROM recording_files WHERE session_id = $1 ORDER BY id ASC`,
      [sessionId]
    );

    let segmentResults = [];
    if (segments.rows.length > 0) {
      const segOutputDir = path.join(danmakuDir, 'segments');
      segmentResults = await danmakuAssGenerator.generateSegmentAss({
        jsonlPath,
        outputDir: segOutputDir,
        segments: segments.rows,
        videoWidth: videoWidth || 1920,
        videoHeight: videoHeight || 1080,
        offsetMs: offsetMs || 0,
      });

      // 分段 ASS 文件存放在确定性路径 danmakuDir/segments/{recording_file_id}.ass
      // 同时回填旧字段，兼容依赖 danmaku_ass_path 的历史流程
      for (const seg of segmentResults) {
        await pool.query(`UPDATE recording_files SET danmaku_ass_path = $1 WHERE id = $2`, [seg.assPath, seg.id]);
      }
    }

    res.json({
      status: 'ok',
      data: {
        ass_path: assPath,
        event_count: assResult.eventCount,
        segments: segmentResults,
      },
    });
  } catch (err) {
    console.error('[api] 生成 ASS 失败:', err.message);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

/**
 * POST /api/sessions/:id/danmaku/burn
 * 手动将会话加入弹幕压制队列
 */
router.post('/sessions/:id/danmaku/burn', async (req, res) => {
  try {
    const { id: sessionId } = req.params;
    const { force = false, useQsv = false } = req.body || {};

    const session = await pool.query(`SELECT id FROM recording_sessions WHERE id = $1`, [sessionId]);

    if (session.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '会话不存在' });
    }

    // 检查是否有分段 ASS（从确定性路径检查，不再依赖 recording_files.danmaku_ass_path）
    const sessionInfo = await pool.query(`SELECT output_dir FROM recording_sessions WHERE id = $1`, [sessionId]);
    const sessDir = sessionInfo.rows[0]?.output_dir;
    const files = await pool.query(
      `SELECT id, segment_index FROM recording_files WHERE session_id = $1 ORDER BY id ASC`,
      [sessionId]
    );

    const hasAss = files.rows.some((f) => {
      if (!sessDir) return false;
      // ASS 文件按 id 命名（确定性路径 danmaku/segments/{id}.ass）
      const assPath = path.join(sessDir, 'danmaku', 'segments', `${f.id}.ass`);
      return fs.existsSync(assPath);
    });
    if (!hasAss) {
      return res.status(400).json({
        status: 'Error',
        message: '无可用 ASS 文件，请先生成 ASS',
      });
    }

    const enqueued = await danmakuBurnQueue.enqueueSession({
      sessionId: parseInt(sessionId, 10),
      force,
      useQsv,
    });

    res.json({
      status: 'ok',
      message: `已加入 ${enqueued} 个分段到弹幕压制队列`,
      enqueued,
    });
  } catch (err) {
    console.error('[api] 手动弹幕压制失败:', err.message);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

/**
 * GET /api/danmaku_capture_records
 * 查询弹幕录制记录
 */
router.get('/danmaku_capture_records', async (req, res) => {
  try {
    const { session_id, status } = req.query;
    let query = 'SELECT * FROM danmaku_capture_records';
    const params = [];
    const conditions = [];

    if (session_id) {
      params.push(session_id);
      conditions.push(`session_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at DESC LIMIT 100';

    const result = await pool.query(query, params);
    res.json({ status: 'ok', data: result.rows });
  } catch (err) {
    console.error('[api] 查询弹幕录制记录失败:', err.message);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

/**
 * GET /api/danmaku_burn_records
 * 查询弹幕压制记录
 */
router.get('/danmaku_burn_records', async (req, res) => {
  try {
    const { session_id, status } = req.query;
    let query = 'SELECT * FROM danmaku_burn_records';
    const params = [];
    const conditions = [];

    if (session_id) {
      params.push(session_id);
      conditions.push(`session_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY enqueued_at DESC LIMIT 100';

    const result = await pool.query(query, params);
    res.json({ status: 'ok', data: result.rows });
  } catch (err) {
    console.error('[api] 查询弹幕压制记录失败:', err.message);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

/**
 * DELETE /api/danmaku_burn_records/:id
 * 删除压制记录
 */
router.delete('/danmaku_burn_records/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { delete_file = false } = req.query;

    const record = await pool.query('SELECT * FROM danmaku_burn_records WHERE id = $1', [id]);
    if (record.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '记录不存在' });
    }

    if (delete_file && record.rows[0].output_path) {
      try {
        if (fs.existsSync(record.rows[0].output_path)) {
          fs.unlinkSync(record.rows[0].output_path);
        }
      } catch (err) {
        console.warn('[api] 删除压制文件失败:', err.message);
      }
    }

    await pool.query('DELETE FROM danmaku_burn_records WHERE id = $1', [id]);
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[api] 删除压制记录失败:', err.message);
    res.status(500).json({ status: 'Error', message: '删除失败' });
  }
});

/**
 * GET /api/danmaku/status
 * 获取弹幕采集和压制状态
 */
router.get('/danmaku/status', async (req, res) => {
  try {
    const activeStats = danmakuRecorder.getActiveStats();
    const queueLength = await danmakuBurnQueue.getQueueLength();
    const processing = await danmakuBurnQueue.getCurrentProcessingCount();

    res.json({
      status: 'ok',
      data: {
        active_captures: activeStats,
        burn_queue: {
          queue_length: queueLength,
          processing,
          concurrency: danmakuBurnQueue.concurrency,
        },
      },
    });
  } catch (err) {
    console.error('[api] 弹幕状态查询失败:', err.message);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

/**
 * GET /api/danmaku/search
 * 搜索弹幕 JSONL 内容
 */
router.get('/danmaku/search', async (req, res) => {
  try {
    const { session_id, keyword, limit = 50, offset = 0 } = req.query;
    const maxLimit = 200;

    if (!session_id) {
      return res.status(400).json({ status: 'Error', message: '缺少 session_id' });
    }

    const session = await pool.query('SELECT output_dir FROM recording_sessions WHERE id = $1', [session_id]);
    if (session.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '会话不存在' });
    }

    const sessionDir = session.rows[0].output_dir;
    const danmakuDir = path.join(sessionDir, 'danmaku');
    const newJsonlPath = path.join(danmakuDir, 'danmaku.jsonl');
    const oldJsonlPath = path.join(sessionDir, 'danmaku.jsonl');
    const jsonlPath = fs.existsSync(newJsonlPath) ? newJsonlPath : oldJsonlPath;
    if (!fs.existsSync(jsonlPath)) {
      return res.json({ status: 'ok', data: [], total: 0 });
    }

    // 流式读取 JSONL，筛选匹配项
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    let allEvents = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'comment' && event.text) {
          allEvents.push(event);
        }
      } catch {
        /* skip malformed lines */
      }
    }

    // 关键词筛选
    const kwLower = (keyword || '').toLowerCase();
    if (kwLower) {
      allEvents = allEvents.filter((e) => {
        const username = e.username || e.user || '';
        return e.text.toLowerCase().includes(kwLower) || username.toLowerCase().includes(kwLower);
      });
    }

    const total = allEvents.length;
    const offsetNum = parseInt(offset, 10) || 0;
    const limitNum = Math.min(parseInt(limit, 10) || 50, maxLimit);
    const paged = allEvents.slice(offsetNum, offsetNum + limitNum);

    res.json({
      status: 'ok',
      data: paged.map((e) => ({
        ts_ms: e.ts_ms,
        ts_str:
          e.ts_ms != null
            ? `${Math.floor(e.ts_ms / 3600000)
                .toString()
                .padStart(2, '0')}:${Math.floor((e.ts_ms % 3600000) / 60000)
                .toString()
                .padStart(2, '0')}:${Math.floor((e.ts_ms % 60000) / 1000)
                .toString()
                .padStart(2, '0')}`
            : '',
        text: e.text,
        username: e.username || e.user || '',
        user_id: e.user_id || e.userId || '',
      })),
      total,
      offset: offsetNum,
      limit: limitNum,
    });
  } catch (err) {
    console.error('[api] 弹幕搜索失败:', err.message);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

/**
 * GET /api/danmaku-toolbox/sessions
 * 获取有弹幕数据的会话列表（工具箱专用）
 */
router.get('/danmaku-toolbox/sessions', async (req, res) => {
  try {
    const { search } = req.query;
    const searchClause = search ? `AND rm.room_name ILIKE $1` : '';
    const params = search ? [`%${search}%`] : [];

    const sql = `
      SELECT s.id, s.room_url, s.status, s.started_at, s.ended_at, s.total_segments, s.total_size, s.output_dir,
             rm.room_name,
             dcr.status as danmaku_status, dcr.event_count as danmaku_event_count, dcr.error as danmaku_error,
             COALESCE(dbr.total, 0) as danmaku_burn_total,
             COALESCE(dbr.completed_count, 0) as danmaku_burn_completed,
             COALESCE(dbr.failed_count, 0) as danmaku_burn_failed,
             COALESCE(ass_counts.indexed_segments, 0) as ass_segment_count
      FROM recording_sessions s
      LEFT JOIN rooms rm ON s.room_url = rm.room_url
      INNER JOIN danmaku_capture_records dcr ON s.id = dcr.session_id
      LEFT JOIN (
        SELECT session_id,
               COUNT(*) as total,
               COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
               COUNT(*) FILTER (WHERE status = 'failed') as failed_count
        FROM danmaku_burn_records
        GROUP BY session_id
      ) dbr ON s.id = dbr.session_id
      LEFT JOIN (
        SELECT rf.session_id,
               COUNT(*) as total_segments,
               COUNT(*) as indexed_segments
        FROM recording_files rf
        GROUP BY rf.session_id
      ) ass_counts ON s.id = ass_counts.session_id
      WHERE s.deleted_at IS NULL ${searchClause}
      ORDER BY s.id DESC
      LIMIT 500
    `;

    const result = await pool.query(sql, params);

    // 从 JSONL 文件修正弹幕条数
    await Promise.all(
      result.rows.map((row) => {
        if (row.danmaku_raw_path && fs.existsSync(row.danmaku_raw_path)) {
          return fs.promises
            .readFile(row.danmaku_raw_path, 'utf-8')
            .then((content) => {
              row.danmaku_event_count = content.split('\n').filter(Boolean).length;
            })
            .catch(() => {});
        }
        return Promise.resolve();
      })
    );

    const assFiles =
      result.rows.length > 0
        ? await pool.query(
            `SELECT session_id, id, segment_index, danmaku_ass_path
             FROM recording_files
             WHERE session_id = ANY($1::int[])`,
            [result.rows.map((row) => row.id)]
          )
        : { rows: [] };
    const assFilesBySession = new Map();
    for (const file of assFiles.rows) {
      if (!assFilesBySession.has(file.session_id)) {
        assFilesBySession.set(file.session_id, []);
      }
      assFilesBySession.get(file.session_id).push(file);
    }

    // 从文件系统检查 ASS 是否就绪（替代旧的 recording_files.danmaku_ass_path 检查）
    for (const row of result.rows) {
      const files = assFilesBySession.get(row.id) || [];
      row.has_ass_ready = files.some((file) => {
        if (file.danmaku_ass_path && fs.existsSync(file.danmaku_ass_path)) return true;
        if (!row.output_dir) return false;
        const idPath = path.join(row.output_dir, 'danmaku', 'segments', `${file.id}.ass`);
        const indexPath = path.join(row.output_dir, 'danmaku', 'segments', `${file.segment_index}.ass`);
        return fs.existsSync(idPath) || fs.existsSync(indexPath);
      });
      delete row.output_dir; // 不暴露给前端
    }

    // 去重：INNER JOIN 可能因多条 capture_records 产生重复
    const seen = new Set();
    const unique = [];
    for (const row of result.rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        unique.push(row);
      }
    }

    res.json({ status: 'ok', data: unique });
  } catch (err) {
    console.error('[api] 弹幕工具箱会话列表查询失败:', err.message);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

/**
 * GET /api/danmaku-toolbox/sessions/:id/events
 * 获取指定会话的弹幕事件列表（用于 DanmakuPickerModal 预览面板）
 */
router.get('/danmaku-toolbox/sessions/:id/events', async (req, res) => {
  try {
    const { id } = req.params;
    const { search, limit = 200, offset = 0 } = req.query;
    const maxLimit = 200;

    const session = await pool.query('SELECT output_dir FROM recording_sessions WHERE id = $1', [id]);
    if (session.rows.length === 0 || !session.rows[0].output_dir) {
      return res.json({ status: 'ok', data: [], total: 0 });
    }

    const sessionDir = session.rows[0].output_dir;
    const danmakuDir = path.join(sessionDir, 'danmaku');
    const newJsonlPath = path.join(danmakuDir, 'danmaku.jsonl');
    const oldJsonlPath = path.join(sessionDir, 'danmaku.jsonl');
    const jsonlPath = fs.existsSync(newJsonlPath) ? newJsonlPath : oldJsonlPath;
    if (!fs.existsSync(jsonlPath)) {
      return res.json({ status: 'ok', data: [], total: 0 });
    }

    // 异步读取，避免阻塞事件循环
    const content = await fs.promises.readFile(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    let allEvents = [];
    const kwLower = (search || '').toLowerCase();

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'comment' && event.text) {
          if (kwLower) {
            const username = event.username || event.user || '';
            if (!event.text.toLowerCase().includes(kwLower) && !username.toLowerCase().includes(kwLower)) {
              continue;
            }
          }
          allEvents.push(event);
        }
      } catch {
        /* skip malformed lines */
      }
    }

    const total = allEvents.length;
    const offsetNum = parseInt(offset, 10) || 0;
    const limitNum = Math.min(parseInt(limit, 10) || 200, maxLimit);
    const paged = allEvents.slice(offsetNum, offsetNum + limitNum);

    res.json({
      status: 'ok',
      data: paged.map((e) => ({
        ts_ms: e.ts_ms,
        ts_str:
          e.ts_ms != null
            ? `${Math.floor(e.ts_ms / 3600000)
                .toString()
                .padStart(2, '0')}:${Math.floor((e.ts_ms % 3600000) / 60000)
                .toString()
                .padStart(2, '0')}:${Math.floor((e.ts_ms % 60000) / 1000)
                .toString()
                .padStart(2, '0')}`
            : '',
        text: e.text,
        username: e.username || e.user || '',
      })),
      total,
      offset: offsetNum,
      limit: limitNum,
    });
  } catch (err) {
    console.error('[api] 弹幕事件预览查询失败:', err.message);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

/**
 * GET /api/danmaku/burn_output/:id/stream
 * 流式播放弹幕压制产物文件
 */
router.get('/danmaku/burn_output/:id/stream', async (req, res) => {
  try {
    const { id } = req.params;
    const record = await pool.query('SELECT output_path FROM danmaku_burn_records WHERE id = $1', [id]);

    if (record.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '记录不存在' });
    }

    const filePath = record.rows[0].output_path;
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ status: 'Error', message: '压制产物文件不存在' });
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.flv': 'video/x-flv' };
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    // 支持 Range 请求
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    console.error('[api] 弹幕压制产物流式播放失败:', err.message);
    res.status(500).json({ status: 'Error', message: '播放失败' });
  }
});

// ── 弹幕自由压制 ────────────────────────────────────────────

const DANMAKU_OUTPUT_DIR = process.env.DANMAKU_OUTPUT_DIR || '/data/danmaku_output';
const VIDEO_DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR || '/data/video_downloads';
const REPLAY_WORK_DIR = process.env.REPLAY_WORK_DIR || '/data/replay';
const ALLOWED_DIRS = [VIDEO_DOWNLOAD_DIR, REPLAY_WORK_DIR, DANMAKU_OUTPUT_DIR];

function isPathSafe(filePath) {
  const resolved = path.resolve(filePath);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(path.resolve(dir) + path.sep));
}

function basenameNoExt(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

/**
 * POST /api/danmaku/free-burn
 * 创建自由压制任务（回放视频 + 录制弹幕 组合压制）
 */
router.post('/danmaku/free-burn', async (req, res) => {
  try {
    const {
      source_type,
      source_id,
      selected_file_index = 0,
      video_path,
      danmaku_session_id,
      manual_adjust_ms = 0,
      video_width,
      video_height,
    } = req.body;

    if ((!source_type || !source_id) && !video_path) {
      return res
        .status(400)
        .json({ status: 'Error', message: '缺少必要参数：需要 video_path 或 source_type + source_id' });
    }
    if (!danmaku_session_id) {
      return res.status(400).json({ status: 'Error', message: '缺少必要参数：danmaku_session_id' });
    }
    if (source_type && !['recording', 'replay'].includes(source_type)) {
      return res.status(400).json({ status: 'Error', message: 'source_type 无效' });
    }

    // 1. 解析视频路径
    let videoPath;
    let videoStartTime = null;

    if (video_path) {
      // 新路径：FilePickerModal 直接传文件路径
      videoPath = video_path;
      // 从 managed_files 反查业务表获取 start_time
      try {
        const mf = await pool.query('SELECT source_table, source_id AS sid FROM managed_files WHERE file_path = $1', [
          video_path,
        ]);
        if (mf.rows.length > 0) {
          const { source_table, sid } = mf.rows[0];
          if (source_table === 'replay_records') {
            const r = await pool.query('SELECT start_time FROM replay_records WHERE id = $1', [sid]);
            videoStartTime = r.rows[0]?.start_time;
          } else if (source_table === 'recording_files') {
            const r = await pool.query(
              'SELECT rs.started_at FROM recording_sessions rs JOIN recording_files rf ON rf.session_id = rs.id WHERE rf.id = $1',
              [sid]
            );
            videoStartTime = r.rows[0]?.started_at;
          }
        }
      } catch (err) {
        console.warn('[free-burn] 从 managed_files 反查 start_time 失败:', err.message);
      }
    } else if (source_type === 'recording') {
      const rec = await pool.query('SELECT output_path, started_at FROM recordings WHERE id = $1', [source_id]);
      if (rec.rows.length === 0 || !rec.rows[0].output_path) {
        return res.status(404).json({ status: 'Error', message: '录制文件不存在或未转码' });
      }
      videoPath = rec.rows[0].output_path;
      videoStartTime = rec.rows[0].started_at;
    } else {
      const replay = await pool.query(
        'SELECT final_file_paths, raw_file_path, start_time FROM replay_records WHERE id = $1',
        [source_id]
      );
      if (replay.rows.length === 0) {
        return res.status(404).json({ status: 'Error', message: '回放记录不存在' });
      }
      const row = replay.rows[0];
      try {
        const paths = JSON.parse(row.final_file_paths || '[]');
        videoPath = paths[selected_file_index] || row.raw_file_path;
      } catch {
        videoPath = row.raw_file_path;
      }
      videoStartTime = row.start_time;
    }

    if (!videoPath || !isPathSafe(videoPath)) {
      return res.status(400).json({ status: 'Error', message: '视频路径不安全或为空' });
    }

    // 2. 解析弹幕 JSONL 路径（兼容新旧两种目录结构）
    const sessionDir = await pool.query('SELECT output_dir FROM recording_sessions WHERE id = $1', [
      danmaku_session_id,
    ]);
    if (sessionDir.rows.length === 0 || !sessionDir.rows[0].output_dir) {
      return res.status(404).json({ status: 'Error', message: '弹幕会话不存在' });
    }
    const newJsonlPath = path.join(sessionDir.rows[0].output_dir, 'danmaku', 'danmaku.jsonl');
    const oldJsonlPath = path.join(sessionDir.rows[0].output_dir, 'danmaku.jsonl');
    const jsonlPath = fs.existsSync(newJsonlPath) ? newJsonlPath : oldJsonlPath;
    if (!fs.existsSync(jsonlPath)) {
      return res.status(404).json({ status: 'Error', message: '弹幕 JSONL 文件不存在' });
    }

    // 3. 计算时间偏移
    const firstLine = fs
      .readFileSync(jsonlPath, 'utf-8')
      .split('\n')
      .find((l) => l.trim());
    if (!firstLine) {
      return res.status(400).json({ status: 'Error', message: '弹幕文件为空' });
    }
    const firstEvent = JSON.parse(firstLine);
    if (!firstEvent.ts_abs_ms || firstEvent.ts_ms == null) {
      return res.status(400).json({ status: 'Error', message: '弹幕缺少时间戳字段' });
    }

    const captureStartEpochMs = firstEvent.ts_abs_ms - firstEvent.ts_ms;
    let offsetMs = 0;
    if (videoStartTime) {
      const videoStartEpochMs = new Date(videoStartTime).getTime();
      offsetMs = captureStartEpochMs - videoStartEpochMs + (manual_adjust_ms || 0);
    }

    // 4. 创建任务记录
    const insertResult = await pool.query(
      `INSERT INTO danmaku_free_burn_records
       (source_type, source_id, danmaku_session_id, video_path, jsonl_path, offset_ms, manual_adjust_ms, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING id`,
      [source_type, source_id, danmaku_session_id, videoPath, jsonlPath, offsetMs, manual_adjust_ms || 0]
    );
    const taskId = insertResult.rows[0].id;

    // 5. 异步执行压制
    executeFreeBurn(taskId, videoPath, jsonlPath, offsetMs, video_width, video_height).catch((err) => {
      console.error(`[free-burn] 任务 ${taskId} 执行失败:`, err);
    });

    res.json({
      status: 'ok',
      data: { id: taskId, offset_ms: offsetMs },
    });
  } catch (err) {
    console.error('[free-burn] 创建任务失败:', err);
    res.status(500).json({ status: 'Error', message: '创建任务失败' });
  }
});

/**
 * 执行自由压制任务
 */
async function executeFreeBurn(taskId, videoPath, jsonlPath, offsetMs, width, height) {
  const outputDir = path.join(DANMAKU_OUTPUT_DIR, 'free-burn', String(taskId));
  fs.mkdirSync(outputDir, { recursive: true });
  const assPath = path.join(outputDir, 'danmaku.ass');
  const outputPath = path.join(outputDir, `${basenameNoExt(videoPath)}_danmaku.mp4`);

  try {
    await pool.query("UPDATE danmaku_free_burn_records SET status = 'processing', started_at = NOW() WHERE id = $1", [
      taskId,
    ]);

    // 生成 ASS
    const assResult = await danmakuAssGenerator.generateFromJsonl({
      jsonlPath,
      assPath,
      videoWidth: width,
      videoHeight: height,
      offsetMs,
    });
    if (!assResult.success) {
      throw new Error(`ASS 生成失败: ${assResult.error}`);
    }

    // FFmpeg 压制
    const ffmpegArgs = [
      '-y',
      '-i',
      videoPath,
      '-vf',
      `ass=${assPath}`,
      '-c:a',
      'copy',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '23',
      outputPath,
    ];
    await new Promise((resolve, reject) => {
      const proc = require('child_process').spawn('ffmpeg', ffmpegArgs);
      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg 退出码 ${code}: ${stderr.slice(-500)}`));
      });
      proc.on('error', reject);
    });

    await pool.query(
      "UPDATE danmaku_free_burn_records SET status = 'completed', output_path = $1, completed_at = NOW() WHERE id = $2",
      [outputPath, taskId]
    );
    console.log(`[free-burn] 任务 ${taskId} 完成: ${outputPath}`);
  } catch (err) {
    await pool.query(
      "UPDATE danmaku_free_burn_records SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2",
      [err.message, taskId]
    );
    console.error(`[free-burn] 任务 ${taskId} 失败:`, err.message);
  }
}

/**
 * GET /api/danmaku/free-burn/records
 * 查询自由压制任务列表
 */
router.get('/danmaku/free-burn/records', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const [data, count] = await Promise.all([
      pool.query('SELECT * FROM danmaku_free_burn_records ORDER BY created_at DESC LIMIT $1 OFFSET $2', [
        limitNum,
        offset,
      ]),
      pool.query('SELECT COUNT(*) FROM danmaku_free_burn_records'),
    ]);

    res.json({
      status: 'ok',
      data: data.rows,
      total: parseInt(count.rows[0]?.count || '0', 10),
      page: pageNum,
      limit: limitNum,
    });
  } catch (err) {
    console.error('[free-burn] 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

module.exports = router;
