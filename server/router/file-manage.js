const express = require('express');
const FileManageService = require('../services/FileManageService');

const router = express.Router();

// 单次删除最大数量限制
const MAX_BATCH_SIZE = 200;

/**
 * GET /files/summary
 * 空间概览：各目录占用 + 总计 + 可清理预估
 */
router.get('/files/summary', async (_req, res) => {
  try {
    const data = await FileManageService.getFileSummary();
    res.json({ status: 'ok', data });
  } catch (err) {
    console.error('[file-manage] 空间概览查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询空间概览失败' });
  }
});

/**
 * GET /files
 * 文件列表（分页、筛选）
 */
router.get('/files', async (req, res) => {
  try {
    const {
      type,
      category,
      status,
      exists_on_disk,
      safe_to_delete,
      ext,
      min_size,
      start_date,
      end_date,
      session_id,
      page,
      limit,
      sort,
    } = req.query;

    const filters = {};
    if (type) filters.type = type;
    if (category) filters.category = category;
    if (status) filters.status = status;
    if (exists_on_disk !== undefined) filters.exists_on_disk = exists_on_disk;
    if (safe_to_delete !== undefined) filters.safe_to_delete = safe_to_delete;
    if (ext) filters.ext = ext;
    if (min_size) filters.min_size = min_size;
    if (start_date) filters.start_date = start_date;
    if (end_date) filters.end_date = end_date;
    if (session_id) filters.session_id = session_id;

    const pagination = { page, limit, sort };
    const data = await FileManageService.getFileList(filters, pagination);
    res.json({ status: 'ok', data: data.data, total: data.total, page: data.page, limit: data.limit });
  } catch (err) {
    console.error('[file-manage] 文件列表查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询文件列表失败' });
  }
});

/**
 * GET /files/:id
 * 文件详情
 */
router.get('/files/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ status: 'Error', message: '无效的文件 ID' });
    }

    const data = await FileManageService.getFileDetail(id);
    if (!data) {
      return res.status(404).json({ status: 'Error', message: '文件不存在' });
    }
    res.json({ status: 'ok', data });
  } catch (err) {
    console.error('[file-manage] 文件详情查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询文件详情失败' });
  }
});

/**
 * POST /files/delete-plan
 * 生成删除计划（dry-run）
 */
router.post('/files/delete-plan', async (req, res) => {
  try {
    const { file_ids, filters } = req.body || {};

    if ((!file_ids || file_ids.length === 0) && !filters) {
      return res.status(400).json({ status: 'Error', message: '必须提供 file_ids 或 filters' });
    }

    if (file_ids && file_ids.length > MAX_BATCH_SIZE) {
      return res.status(400).json({
        status: 'Error',
        message: `单次最多处理 ${MAX_BATCH_SIZE} 个文件`,
      });
    }

    const operator = req.auth?.username || 'unknown';
    const data = await FileManageService.generateDeletePlan({ file_ids, filters }, operator);
    res.json({ status: 'ok', data });
  } catch (err) {
    console.error('[file-manage] 生成删除计划失败:', err);
    res.status(500).json({ status: 'Error', message: '生成删除计划失败' });
  }
});

/**
 * POST /files/delete
 * 异步执行删除，需 plan_id + confirm: true
 * 立即返回 task_id，前端通过 GET /files/delete-tasks/:taskId 轮询进度
 */
router.post('/files/delete', async (req, res) => {
  try {
    const { plan_id, confirm } = req.body || {};

    if (!plan_id) {
      return res.status(400).json({ status: 'Error', message: '缺少 plan_id' });
    }

    if (confirm !== true) {
      return res.status(400).json({ status: 'Error', message: '需要 confirm: true 才能执行删除' });
    }

    const operator = req.auth?.username || 'unknown';
    const data = await FileManageService.executeDelete(plan_id, operator);
    res.json({ status: 'ok', data });
  } catch (err) {
    if (err.message.includes('不存在或已过期')) {
      return res.status(404).json({ status: 'Error', message: err.message });
    }
    console.error('[file-manage] 执行删除失败:', err);
    res.status(500).json({ status: 'Error', message: '执行删除失败' });
  }
});

/**
 * GET /files/delete-tasks/:taskId
 * 查询删除任务进度
 */
router.get('/files/delete-tasks/:taskId', async (req, res) => {
  try {
    const data = await FileManageService.getDeleteTaskStatus(req.params.taskId);
    if (!data) {
      return res.status(404).json({ status: 'Error', message: '删除任务不存在或已过期' });
    }
    res.json({ status: 'ok', data });
  } catch (err) {
    console.error('[file-manage] 查询删除任务失败:', err);
    res.status(500).json({ status: 'Error', message: '查询删除任务失败' });
  }
});

/**
 * POST /files/:id/delete
 * 单文件同步删除
 */
router.post('/files/:id/delete', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ status: 'Error', message: '无效的文件 ID' });
    }

    const file = await FileManageService.getFileDetail(id);
    if (!file) {
      return res.status(404).json({ status: 'Error', message: '文件不存在' });
    }

    const operator = req.auth?.username || 'unknown';
    const result = await FileManageService.executeSingleDelete(file, operator);
    res.json({ status: 'ok', data: result });
  } catch (err) {
    console.error('[file-manage] 单文件删除失败:', err);
    res.status(500).json({ status: 'Error', message: '单文件删除失败' });
  }
});

/**
 * POST /files/scan
 * 触发全量文件扫描
 */
router.post('/files/scan', async (_req, res) => {
  try {
    const data = await FileManageService.scanAllFiles();
    res.json({ status: 'ok', data });
  } catch (err) {
    console.error('[file-manage] 文件扫描失败:', err);
    res.status(500).json({ status: 'Error', message: '文件扫描失败' });
  }
});

module.exports = router;
