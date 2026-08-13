const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();
const pool = require('../db/index');
const danmakuRecorder = require('../lib/core/danmaku/DanmakuRecorder');
const orphanReconciler = require('../services/OrphanDanmakuReconciler');
const DataService = require('../services/DataService');
const { getDanmakuJsonlPath, parseJsonlContent } = require('../lib/utils/tool');

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

    // 写入 JSONL（无活跃采集会话时落 orphan 兜底文件）
    const result = await danmakuRecorder.writeBatch(room_url, events);

    // 409 是与扩展的契约：扩展据此保留缓冲区，等录制启动后自动续发。
    // 后端已把这批弹幕落到 orphan 文件，两端各留一份，任一侧失效都不丢数据。
    if (result.error === 'no_active_session') {
      return res.status(409).json({
        ok: false,
        status: 'Error',
        written: 0,
        error: 'no_active_session',
        orphan: result.orphan || null,
      });
    }

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

    const session = await pool.query('SELECT id FROM recording_sessions WHERE id = $1', [session_id]);
    if (session.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '会话不存在' });
    }

    // v1.8.0：弹幕集中存放，路径由 sessionId 唯一推导，不再兼容会话目录下的旧路径
    const jsonlPath = getDanmakuJsonlPath(session_id);
    if (!fs.existsSync(jsonlPath)) {
      return res.json({ status: 'ok', data: [], total: 0 });
    }

    // 异步读取 JSONL（HTTP 处理器不能用同步 IO 阻塞事件循环），解析复用 parseJsonlContent
    const content = await fs.promises.readFile(jsonlPath, 'utf-8');
    let allEvents = parseJsonlContent(content).filter((e) => e.type === 'comment' && e.text);

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

/**
 * GET /api/danmaku/orphan
 * 孤儿弹幕记录列表（ADR-012）
 */
router.get('/danmaku/orphan', async (req, res) => {
  try {
    const { status, limit } = req.query;
    const rows = await DataService.listOrphanDanmakuRecords({
      status,
      limit: Math.min(parseInt(limit, 10) || 100, 500),
    });
    res.json({ status: 'ok', data: rows, total: rows.length });
  } catch (err) {
    console.error('[api] 孤儿弹幕列表查询失败:', err.message);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

/**
 * POST /api/danmaku/orphan/reconcile-all?dry_run=1&force=1
 * 批量回填所有 orphan_pending 记录
 *
 * 注意：必须注册在 /reconcile/:recordId 之前，否则 'reconcile-all' 会被
 * 当成 :recordId 匹配到单条路由上。
 */
router.post('/danmaku/orphan/reconcile-all', async (req, res) => {
  try {
    const result = await orphanReconciler.reconcileAll({
      dryRun: req.query.dry_run === '1' || req.query.dry_run === 'true',
      force: req.query.force === '1' || req.query.force === 'true',
    });
    res.json({ status: 'ok', data: result });
  } catch (err) {
    console.error('[api] 孤儿弹幕批量回填失败:', err.message);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

/**
 * POST /api/danmaku/orphan/reconcile/:recordId?dry_run=1&force=1
 * 触发单条孤儿弹幕的时间戳区间匹配回填
 */
router.post('/danmaku/orphan/reconcile/:recordId', async (req, res) => {
  try {
    const recordId = parseInt(req.params.recordId, 10);
    if (!Number.isInteger(recordId)) {
      return res.status(400).json({ status: 'Error', message: 'recordId 非法' });
    }

    const result = await orphanReconciler.reconcile(recordId, {
      dryRun: req.query.dry_run === '1' || req.query.dry_run === 'true',
      force: req.query.force === '1' || req.query.force === 'true',
    });

    if (result.status === 'not_found') {
      return res.status(404).json({ status: 'Error', message: '孤儿弹幕记录不存在' });
    }
    // low_confidence / no_match 是业务上的"拒绝执行"，用 409 与成功区分，
    // 前端据此提示人工确认后带 force=1 重试。
    if (result.status === 'low_confidence' || result.status === 'no_match') {
      return res.status(409).json({ status: 'Error', message: '匹配置信度不足', data: result });
    }

    res.json({ status: 'ok', data: result });
  } catch (err) {
    console.error('[api] 孤儿弹幕回填失败:', err.message);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

/**
 * DELETE /api/danmaku/orphan/:recordId
 * 人工丢弃孤儿弹幕：文件移动到 _discarded/ 归档，不硬删
 */
router.delete('/danmaku/orphan/:recordId', async (req, res) => {
  try {
    const recordId = parseInt(req.params.recordId, 10);
    if (!Number.isInteger(recordId)) {
      return res.status(400).json({ status: 'Error', message: 'recordId 非法' });
    }

    const result = await orphanReconciler.discard(recordId);
    if (result.status === 'not_found') {
      return res.status(404).json({ status: 'Error', message: '孤儿弹幕记录不存在' });
    }

    res.json({ status: 'ok', data: result });
  } catch (err) {
    console.error('[api] 孤儿弹幕丢弃失败:', err.message);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

module.exports = router;
