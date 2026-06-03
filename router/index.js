const express = require('express');

const hlsRouter = require('./hls');
// const htmlRouter = require('./html');
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
  router.use(logsRouter);
  router.use('/api', apiRouter);
  router.use('/api', roomsRouter);
  router.use('/api', uploadRouter);
  router.use('/api', settingsRouter);
  router.use('/api', transcodeRouter);
  router.use('/api', danmakuRouter);
  // Vue SPA 路由（放在 EJS htmlRouter 之前，优先匹配已迁移的页面）
  router.use(spaRouter);
  // EJS 页面路由（随着迁移逐步减少）
  // router.use('/', htmlRouter);

  return router;
}

module.exports = createRoutes();
