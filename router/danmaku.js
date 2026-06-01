const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();
const pool = require('../db/index');
const danmakuRecorder = require('../lib/core/danmaku/DanmakuRecorder');
const danmakuAssGenerator = require('../lib/core/danmaku/DanmakuAssGenerator');
const danmakuBurnQueue = require('../lib/core/DanmakuBurnQueue');

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
    const jsonlPath = path.join(sessionDir, 'danmaku.jsonl');

    if (!fs.existsSync(jsonlPath)) {
      return res.status(404).json({ status: 'Error', message: '弹幕数据文件不存在' });
    }

    // 生成会话级 ASS
    const assPath = path.join(sessionDir, 'danmaku.ass');
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

    // 为每个分段生成分段 ASS
    const segments = await pool.query(
      `SELECT id, segment_index, segment_start_ms, segment_end_ms FROM recording_files WHERE session_id = $1 ORDER BY segment_index`,
      [sessionId]
    );

    let segmentResults = [];
    if (segments.rows.length > 0) {
      const segOutputDir = path.join(sessionDir, 'danmaku_segments');
      segmentResults = await danmakuAssGenerator.generateSegmentAss({
        jsonlPath,
        outputDir: segOutputDir,
        segments: segments.rows,
        videoWidth: videoWidth || 1920,
        videoHeight: videoHeight || 1080,
        offsetMs: offsetMs || 0,
      });

      // 更新每个 recording_file 的 danmaku_ass_path
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

    // 检查是否有分段 ASS
    const files = await pool.query(`SELECT id, danmaku_ass_path FROM recording_files WHERE session_id = $1`, [
      sessionId,
    ]);

    const hasAss = files.rows.some((f) => f.danmaku_ass_path && fs.existsSync(f.danmaku_ass_path));
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

    const jsonlPath = path.join(session.rows[0].output_dir, 'danmaku.jsonl');
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
      allEvents = allEvents.filter(
        (e) => {
          const username = e.username || e.user || '';
          return e.text.toLowerCase().includes(kwLower) || username.toLowerCase().includes(kwLower);
        }
      );
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

module.exports = router;
