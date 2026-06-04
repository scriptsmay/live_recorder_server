const express = require('express');

const hlsRouter = require('./hls');
const logsRouter = require('./logs');
const spaRouter = require('./spa');
const { router: apiRouter } = require('./api');
const roomsRouter = require('./rooms');
const uploadRouter = require('./upload');
const settingsRouter = require('./settings');
const transcodeRouter = require('./transcode');
const danmakuRouter = require('./danmaku');

function createRoutes() {
  const router = express.Router();

  router.use(hlsRouter);
  router.use('/api', logsRouter);
  router.use('/api', apiRouter);
  router.use('/api', roomsRouter);
  router.use('/api', uploadRouter);
  router.use('/api', settingsRouter);
  router.use('/api', transcodeRouter);
  router.use('/api', danmakuRouter);
  // Vue SPA 路由（静态资源 + history 模式回退）
  router.use(spaRouter);

  // 给个默认跳转到前端界面，方便访问
  router.get('/', (req, res) => {
    res.redirect('/dashboard');
  });

  return router;
}

module.exports = createRoutes();
