const express = require('express');

const hlsRouter = require('./hls');
const htmlRouter = require('./html');
const logsRouter = require('./logs');
const { router: apiRouter } = require('./api');
const roomsRouter = require('./rooms');
const uploadRouter = require('./upload');
const settingsRouter = require('./settings');
const transcodeRouter = require('./transcode');

function createRoutes() {
  const router = express.Router();

  router.use(hlsRouter);
  router.use(logsRouter);
  router.use('/', htmlRouter);
  router.use('/api', apiRouter);
  router.use('/api', roomsRouter);
  router.use('/api', uploadRouter);
  router.use('/api', settingsRouter);
  router.use('/api', transcodeRouter);

  return router;
}

module.exports = createRoutes();
