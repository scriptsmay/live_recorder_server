const fs = require('fs');
const express = require('express');
const router = express.Router();
const analysisService = require('../services/DanmakuAnalysisService');
const DataService = require('../services/DataService');
const { getDanmakuAnalysisHtmlPath } = require('../lib/utils/tool');

/**
 * AI 弹幕分析 API
 *
 * 路径一律由 sessionId 经 getDanmakuAnalysisHtmlPath 唯一推导，
 * 不信任 report_path 列内容，杜绝路径穿越。
 */

/**
 * GET /api/danmaku-analysis
 * 分析记录列表（?status= & ?limit= & ?page=）
 */
router.get('/danmaku-analysis', async (req, res) => {
  try {
    const { status, limit = 50, page } = req.query;
    const data = await analysisService.listRecords({ status, limit, page });
    res.json({ status: 'ok', data: data.rows, total: data.total });
  } catch (err) {
    console.error('[danmaku-analysis] 列表查询失败:', err.message);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

/**
 * POST /api/danmaku-analysis/:sessionId
 * 手动触发分析（异步受理，立即返回 running；?force=true 重算已完成场次）
 */
router.post('/danmaku-analysis/:sessionId', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId, 10);
    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({ status: 'Error', message: 'sessionId 必须为数字' });
    }
    const enabled = await DataService.getSetting('ai_analysis_enabled', 'false');
    if (enabled !== 'true') {
      return res.status(400).json({ status: 'Error', message: 'AI 弹幕分析总开关未开启（ai_analysis_enabled）' });
    }
    const force = req.query.force === 'true';
    const result = await analysisService.requestAnalysis(sessionId, { force });
    if (!result.accepted) {
      return res.status(409).json({ status: 'Error', message: result.message, state: result.state });
    }
    res.json({ status: 'ok', data: { session_id: sessionId, state: 'running' } });
  } catch (err) {
    console.error('[danmaku-analysis] 触发失败:', err.message);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

/**
 * GET /api/danmaku-analysis/:sessionId
 * 单场分析结果（高光点 + 总结 + 统计；无记录返回 404）
 */
router.get('/danmaku-analysis/:sessionId', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId, 10);
    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({ status: 'Error', message: 'sessionId 必须为数字' });
    }
    const record = await analysisService.getRecordDetail(sessionId);
    if (!record) {
      return res.status(404).json({ status: 'Error', message: '暂无分析记录' });
    }
    delete record.report_path; // 文件路径不暴露，报告走 /report 端点
    res.json({ status: 'ok', data: record });
  } catch (err) {
    console.error('[danmaku-analysis] 查询失败:', err.message);
    res.status(500).json({ status: 'Error', message: err.message });
  }
});

/**
 * GET /api/danmaku-analysis/:sessionId/report
 * 内联返回 HTML 报告（自包含，可直接 iframe/新窗口）
 */
router.get('/danmaku-analysis/:sessionId/report', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId, 10);
    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({ status: 'Error', message: 'sessionId 必须为数字' });
    }
    const record = await analysisService.getRecord(sessionId);
    if (!record || !['completed', 'no_danmaku'].includes(record.status)) {
      return res.status(404).json({ status: 'Error', message: '报告尚未生成' });
    }
    const htmlPath = getDanmakuAnalysisHtmlPath(sessionId);
    if (!fs.existsSync(htmlPath)) {
      return res.status(404).json({ status: 'Error', message: '报告文件不存在' });
    }
    const html = await fs.promises.readFile(htmlPath, 'utf-8');
    res.type('html').send(html);
  } catch (err) {
    console.error('[danmaku-analysis] 报告读取失败:', err.message);
    res.status(500).json({ status: 'Error', message: '报告读取失败' });
  }
});

module.exports = router;
