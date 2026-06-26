const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();
const pool = require('../db/index');
const danmakuRecorder = require('../lib/core/danmaku/DanmakuRecorder');
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
 * GET /api/danmaku/status
 * 获取弹幕采集状态
 */
router.get('/danmaku/status', async (req, res) => {
  try {
    const activeStats = danmakuRecorder.getActiveStats();

    res.json({
      status: 'ok',
      data: {
        active_captures: activeStats,
      },
    });
  } catch (err) {
    console.error('[api] 弹幕状态查询失败:', err.message);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

/**
 * GET /api/danmaku/search
 * 搜索弹幕 JSONL 内容（SessionDanmaku / DanmakuPickerModal 共用）
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
    const content = await fs.promises.readFile(jsonlPath, 'utf-8');
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
        const userId = e.user_id || e.userId || '';
        return (
          e.text.toLowerCase().includes(kwLower) ||
          username.toLowerCase().includes(kwLower) ||
          userId.toLowerCase().includes(kwLower)
        );
      });
    }

    const total = allEvents.length;
    const offsetNum = parseInt(offset, 10) || 0;
    const limitNum = Math.min(parseInt(limit, 10) || 50, maxLimit);
    const paged = allEvents.slice(offsetNum, offsetNum + limitNum);

    res.json({
      status: 'ok',
      data: paged.map((e) => ({
        ...e,
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
 * GET /api/danmaku/sessions/:id/raw
 * 下载弹幕原始 JSONL 文件
 */
router.get('/danmaku/sessions/:id/raw', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT raw_path FROM danmaku_capture_records WHERE session_id = $1 ORDER BY id DESC LIMIT 1',
      [parseInt(id, 10)]
    );

    if (result.rows.length === 0 || !result.rows[0].raw_path) {
      return res.status(404).json({ status: 'Error', message: '弹幕记录不存在' });
    }

    const filePath = result.rows[0].raw_path;
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ status: 'Error', message: 'JSONL 文件不存在' });
    }

    const fileName = path.basename(filePath);
    res.download(filePath, fileName);
  } catch (err) {
    console.error('[api] JSONL 下载失败:', err.message);
    res.status(500).json({ status: 'Error', message: '下载失败' });
  }
});

module.exports = router;
