const express = require('express');
const ReplayService = require('../services/ReplayService');
const ReplayUploadService = require('../lib/core/replay/ReplayUploadService');
const replayQueue = require('../lib/core/ReplayProcessQueue');

const router = express.Router();
const VALID_ACTIONS = new Set(['extract', 'download', 'cut', 'fix', 'upload', 'all']);

function parseBool(value) {
  return value === true || value === 'true' || value === '1';
}

router.get('/replay/principals', async (_req, res) => {
  try {
    const data = await ReplayService.getPrincipals();
    res.json({ status: 'ok', data });
  } catch (err) {
    console.error('[replay] 主播列表查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询主播列表失败' });
  }
});

router.get('/replay/principals/:principalId/records', async (req, res) => {
  try {
    const data = await ReplayService.listRecords(req.params.principalId, req.query);
    res.json({ status: 'ok', data: data.rows, total: data.total, page: data.page, page_size: data.page_size });
  } catch (err) {
    console.error('[replay] 回放记录查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询回放记录失败' });
  }
});

router.get('/replay/records/:id', async (req, res) => {
  try {
    const data = await ReplayService.getRecord(req.params.id);
    if (!data) return res.status(404).json({ status: 'Error', message: '回放记录不存在' });
    res.json({ status: 'ok', data });
  } catch (err) {
    console.error('[replay] 回放详情查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询回放详情失败' });
  }
});

router.post('/replay/records/sync', async (req, res) => {
  try {
    const data = await ReplayService.syncRecords(req.body || {});
    res.json({ status: 'ok', data, message: data.message || '同步完成' });
  } catch (err) {
    console.error('[replay] 回放同步失败:', err);
    res.status(400).json({ status: 'Error', message: err.message || '同步失败' });
  }
});

router.post('/replay/records/:id/actions/:action', async (req, res) => {
  try {
    const { id, action } = req.params;
    if (!VALID_ACTIONS.has(action)) {
      return res.status(400).json({ status: 'Error', message: '未知回放动作' });
    }
    const record = await ReplayService.getRecord(id);
    if (!record) return res.status(404).json({ status: 'Error', message: '回放记录不存在' });
    await replayQueue.enqueue({
      replayRecordId: parseInt(id, 10),
      action,
      force: parseBool(req.body?.force),
    });
    res.json({ status: 'ok', message: '回放任务已入队' });
  } catch (err) {
    console.error('[replay] 回放任务入队失败:', err);
    res.status(500).json({ status: 'Error', message: '回放任务入队失败' });
  }
});

router.post('/replay/records/:id/cancel', async (req, res) => {
  try {
    const result = await replayQueue.cancelRecord(req.params.id);
    if (!result.cancelled) {
      return res.status(409).json({ status: 'Error', message: result.message });
    }
    res.json({ status: 'ok', data: result, message: '回放任务已取消' });
  } catch (err) {
    console.error('[replay] 取消回放任务失败:', err);
    res.status(500).json({ status: 'Error', message: err.message || '取消回放任务失败' });
  }
});

router.get('/replay/records/:id/upload-preview', async (req, res) => {
  try {
    const result = await ReplayUploadService.getUploadPreview(req.params.id);
    if (result.error) {
      return res.status(400).json({ status: 'Error', message: result.message });
    }
    res.json({ status: 'ok', data: result.preview });
  } catch (err) {
    console.error('[replay] 投稿预览失败:', err);
    res.status(500).json({ status: 'Error', message: '获取投稿预览失败' });
  }
});

router.get('/replay/principals/:principalId/uploads', async (req, res) => {
  try {
    const data = await ReplayService.listUploads(req.params.principalId, req.query);
    res.json({ status: 'ok', data });
  } catch (err) {
    console.error('[replay] 投稿记录查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询回放投稿记录失败' });
  }
});

router.get('/replay/tasks', async (_req, res) => {
  try {
    const data = await replayQueue.getStatus();
    res.json({ status: 'ok', data });
  } catch (err) {
    console.error('[replay] 队列状态查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询回放队列失败' });
  }
});

router.post('/replay/tasks/enqueue', async (req, res) => {
  try {
    const principalId = req.body?.principal_id;
    if (!principalId) return res.status(400).json({ status: 'Error', message: '缺少 principal_id' });
    const data = await replayQueue.enqueuePrincipal({
      principalId,
      count: req.body?.count || 1,
      skipCompleted: req.body?.skip_completed !== false,
      dryRun: parseBool(req.body?.dry_run),
    });
    res.json({ status: 'ok', data, message: data.dry_run ? 'dry-run 完成' : '批量任务已入队' });
  } catch (err) {
    console.error('[replay] 批量入队失败:', err);
    res.status(500).json({ status: 'Error', message: '批量入队失败' });
  }
});

router.get('/replay/principals/:principalId/settings', async (req, res) => {
  try {
    const data = await ReplayService.getSettings(req.params.principalId);
    res.json({ status: 'ok', data });
  } catch (err) {
    console.error('[replay] 配置查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询回放配置失败' });
  }
});

router.put('/replay/principals/:principalId/settings', async (req, res) => {
  try {
    const data = await ReplayService.updateSettings(req.params.principalId, req.body || {});
    res.json({ status: 'ok', data });
  } catch (err) {
    console.error('[replay] 配置更新失败:', err);
    res.status(500).json({ status: 'Error', message: '更新回放配置失败' });
  }
});

module.exports = router;
