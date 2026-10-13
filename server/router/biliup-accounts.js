const express = require('express');
const router = express.Router();
const BiliupAccountService = require('../services/BiliupAccountService');

/**
 * biliup 账号登记（FR-7）
 *
 * 只有新增 / 查询 / 删除，没有 UPDATE：账号信息以 cookie 文件为准。
 * 响应体绝不含 cookie 内容；异常只回错误码类别，细节进日志。
 */

function reply(res, result) {
  const body = { status: result.ok ? 'ok' : 'Error' };
  if (result.data !== undefined) body.data = result.data;
  if (result.message) body.message = result.message;
  if (!result.ok && !body.message) body.message = '操作失败';
  if (result.referenced_by !== undefined) body.referenced_by = result.referenced_by;
  return res.status(result.http || (result.ok ? 200 : 500)).json(body);
}

router.get('/biliup_accounts', async (req, res) => {
  try {
    reply(res, await BiliupAccountService.list());
  } catch (err) {
    console.error('[biliup_accounts] 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

router.post('/biliup_accounts', async (req, res) => {
  try {
    reply(res, await BiliupAccountService.create(req.body || {}));
  } catch (err) {
    console.error('[biliup_accounts] 新增失败:', err);
    res.status(500).json({ status: 'Error', message: '新增失败' });
  }
});

router.get('/biliup_accounts/:id', async (req, res) => {
  try {
    reply(res, await BiliupAccountService.detail(req.params.id));
  } catch (err) {
    console.error('[biliup_accounts] 详情查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

router.delete('/biliup_accounts/:id', async (req, res) => {
  try {
    reply(res, await BiliupAccountService.remove(req.params.id));
  } catch (err) {
    console.error('[biliup_accounts] 删除失败:', err);
    res.status(500).json({ status: 'Error', message: '删除失败' });
  }
});

router.get('/biliup_accounts/:id/seasons', async (req, res) => {
  try {
    reply(res, await BiliupAccountService.seasons(req.params.id, { force: req.query.force === '1' }));
  } catch (err) {
    const code = (err && err.code) || 'unknown';
    console.error(`[biliup_accounts] 合集列表获取失败: ${code}`);
    const message = code === 'AUTH_EXPIRED' ? 'cookie 已失效，请重新登录该账号' : '合集列表获取失败';
    res.status(500).json({ status: 'Error', message });
  }
});

module.exports = router;
