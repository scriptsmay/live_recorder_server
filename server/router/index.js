const express = require('express');
const path = require('path');

const hlsRouter = require('./hls');
const authRouter = require('./auth');
const logsRouter = require('./logs');
const spaRouter = require('./spa');
const { router: apiRouter } = require('./api');
const roomsRouter = require('./rooms');
const uploadRouter = require('./upload');
const settingsRouter = require('./settings');
const transcodeRouter = require('./transcode');
const danmakuRouter = require('./danmaku');
const replayRouter = require('./replay');
const fileManageRouter = require('./file-manage');
const { requireAuth } = require('../middleware/require-auth');

const CRON_AUTH_PATHS = new Set([
  '/api/replay/records/sync',
  '/api/replay/tasks/enqueue',
  '/api/notify/feishu_webhook',
]);

function isCronAuthorized(req) {
  const token = process.env.CRON_API_TOKEN;
  if (!token || !CRON_AUTH_PATHS.has(req.path)) return false;
  return req.get('x-cron-token') === token;
}

function createRoutes() {
  const router = express.Router();

  // 路由 /hls/* 直接提供视频文件访问，支持 Range 请求
  router.use(hlsRouter);

  // API 路由
  router.use('/api/auth', authRouter);
  const authMiddleware = requireAuth();
  router.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (
      req.path === '/api/health' ||
      req.path === '/api/auth/login' ||
      req.path === '/api/auth/logout' ||
      req.path === '/api/auth/me' ||
      req.path === '/api/notify/live_download' ||
      req.path === '/api/notify/status' ||
      req.path === '/api/danmaku/batch' ||
      isCronAuthorized(req)
    ) {
      return next();
    }
    return authMiddleware(req, res, next);
  });
  router.use('/api', logsRouter);
  router.use('/api', apiRouter);
  router.use('/api', roomsRouter);
  router.use('/api', uploadRouter);
  router.use('/api', settingsRouter);
  router.use('/api', transcodeRouter);
  router.use('/api', danmakuRouter);
  router.use('/api', replayRouter);
  router.use('/api', fileManageRouter);
  // Vue SPA 路由（静态资源 + history 模式回退）
  router.use(spaRouter);

  // 给个默认跳转到前端界面，方便访问
  router.get('/', (req, res) => {
    res.redirect('/dashboard');
  });

  // 404 兜底 —— 必须放在所有路由之后
  router.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ status: 'Error', message: '接口不存在' });
    }
    if (path.extname(req.path)) {
      return next();
    }
    res.status(404).sendFile(path.join(__dirname, '..', '..', 'public', '404.html'));
  });

  return router;
}

module.exports = createRoutes();
