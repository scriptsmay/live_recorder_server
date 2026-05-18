// ──────────────────────────────────────────────
// 1. 依赖
// ──────────────────────────────────────────────
require('./config/env').initEnv();

const path = require('path');

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const ejsLayouts = require('express-ejs-layouts');
const dayjs = require('dayjs');

if (process.env.NODE_ENV === 'development') {
  const ts = () => dayjs().format('YYYY-MM-DD HH:mm:ss');
  ['log', 'warn', 'error'].forEach((method) => {
    const orig = console[method];
    console[method] = (...args) => orig(`[${ts()}]`, ...args);
  });
}

const migrate = require('./db/migrate');
const redis = require('./db/redis');

const htmlRouter = require('./router/html');
const { router: apiRouter } = require('./router/api');
const roomsRouter = require('./router/rooms');
const uploadRouter = require('./router/upload');
const settingsRouter = require('./router/settings');
const watchdog = require('./lib/core/watchdog');
const { pollingManager } = require('./lib/core/polling');
const RecorderService = require('./services/RecorderService');
const transcodeQueue = require('./lib/core/TranscodeQueue');

// ──────────────────────────────────────────────
// 2. Express 配置
// ──────────────────────────────────────────────
const app = express();
const port = process.env.PORT || 3000;

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(ejsLayouts);

if (process.env.NODE_ENV === 'development') {
  app.set('view cache', false);
  app.disable('view cache');
}

app.use(express.static('public'));

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(morgan('dev'));

app.use((req, res, next) => {
  res.locals.path = req.path;
  res.locals.title = 'Live Recorder Server';
  next();
});

// ──────────────────────────────────────────────
// 3. 路由
// ──────────────────────────────────────────────
app.use('/', htmlRouter);
app.use('/api', apiRouter);
app.use('/api', roomsRouter);
app.use('/api', uploadRouter);
app.use('/api', settingsRouter);

// ──────────────────────────────────────────────
// 4. 启动初始化
// ──────────────────────────────────────────────
async function init() {
  await migrate();

  const keys = await redis.keys('active_task:*');
  for (const key of keys) {
    await redis.del(key);
  }

  await RecorderService.cleanupStaleRecordings();
  await transcodeQueue.init();
  watchdog.start();
  await pollingManager.start();

  app.listen(port, () => {
    console.log(`Live Recorder Server 已启动，端口 ${port}`);
  });
}

init().catch((err) => {
  console.error('[启动失败] 数据库迁移出错:', err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  console.log('[退出] 收到 SIGTERM，正在停止轮询管理器...');
  await pollingManager.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[退出] 收到 SIGINT，正在停止轮询管理器...');
  await pollingManager.stop();
  process.exit(0);
});
