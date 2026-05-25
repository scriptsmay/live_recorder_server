// ──────────────────────────────────────────────
// 1. 依赖
// ──────────────────────────────────────────────
require('./config/env').initEnv();

const path = require('path');
const fs = require('fs');

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const ejsLayouts = require('express-ejs-layouts');
const dayjs = require('dayjs');

const ts = () => dayjs().format('YYYY-MM-DD HH:mm:ss');

if (process.env.NODE_ENV === 'development') {
  ['log', 'warn', 'error'].forEach((method) => {
    const orig = console[method];
    console[method] = (...args) => orig(`[${ts()}]`, ...args);
  });
}

// 默认日志格式为 'dev'，生产环境使用自定义格式
let moganFormat = 'dev';
if (process.env.NODE_ENV === 'production') {
  morgan.token('local-date', ts);
  moganFormat = ':local-date :method :url :status :response-time ms';
}

const migrate = require('./db/migrate');
const redis = require('./db/redis');

const htmlRouter = require('./router/html');
const { router: apiRouter } = require('./router/api');
const roomsRouter = require('./router/rooms');
const uploadRouter = require('./router/upload');
const settingsRouter = require('./router/settings');
const transcodeRouter = require('./router/transcode');
const hlsRouter = require('./router/hls');
const watchdog = require('./lib/core/watchdog');
const { pollingManager } = require('./lib/core/polling');
const RecorderService = require('./services/RecorderService');
const transcodeQueue = require('./lib/core/TranscodeQueue');

// ──────────────────────────────────────────────
// 系统信息
// ──────────────────────────────────────────────
const SERVER_START_TIME = new Date();
const PACKAGE_JSON_PATH = path.join(__dirname, 'package.json');
const PACKAGE_JSON = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
const APP_VERSION = PACKAGE_JSON.version;
const DOCKER_IMAGE_VERSION = process.env.DOCKER_IMAGE_VERSION || APP_VERSION;

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
// 日志记录格式
app.use(morgan(moganFormat));

app.use((req, res, next) => {
  res.locals.path = req.path;
  res.locals.title = 'Live Recorder Server';
  res.locals.dayjs = dayjs;

  res.locals.formatDate = (date, format = 'YYYY-MM-DD HH:mm:ss') => {
    if (!date) return '-';

    // 1. 如果输入是字符串，先尝试检查它是否是“纯数字”形式的时间戳
    // 避免将包含连字符或时间的字符串误解析为数字
    if (typeof date === 'string' && /^\d+$/.test(date)) {
      date = parseFloat(date);
    }

    let parsedDate;
    if (typeof date === 'number') {
      // 处理时间戳逻辑
      // 增加一个简单的范围判断，避免把小数字（年份等）误判为时间戳
      if (date > 10000000000) {
        // 13位及以上，视为毫秒
        parsedDate = dayjs(date);
      } else {
        // 10位，视为秒
        parsedDate = dayjs.unix(date);
      }
    } else {
      // 传入的是日期字符串（如 ISO 格式）
      parsedDate = dayjs(date);
    }

    if (!parsedDate.isValid()) {
      return '-';
    }

    return parsedDate.format(format);
  };
  res.locals.serverStartTime = SERVER_START_TIME;
  res.locals.appVersion = APP_VERSION;
  res.locals.dockerImageVersion = DOCKER_IMAGE_VERSION;
  next();
});

// ──────────────────────────────────────────────
// 3. 路由
// ──────────────────────────────────────────────
// HLS 文件服务需要在 htmlRouter 之前注册，避免被前端路由拦截
app.use(hlsRouter);

app.use('/', htmlRouter);
app.use('/api', apiRouter);
app.use('/api', roomsRouter);
app.use('/api', uploadRouter);
app.use('/api', settingsRouter);
app.use('/api', transcodeRouter);

// ──────────────────────────────────────────────
// 4. 启动初始化
// ──────────────────────────────────────────────
async function init() {
  await migrate();

  const keys = await redis.keys('active_task:*');
  for (const key of keys) {
    await redis.del(key);
  }

  // TODO: 测试一下，如果不执行开局的录制会话清理，会是什么效果？
  await RecorderService.cleanupStaleRecordings();
  await transcodeQueue.init();
  watchdog.start();

  app.listen(port, () => {
    console.log(`Live Recorder Server 已启动，端口 ${port}`);
  });

  pollingManager.start().catch((err) => {
    console.error('[PollingManager] 启动失败:', err.message);
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
