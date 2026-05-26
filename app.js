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

/**
 * 获取当前时间的格式化字符串
 * @returns {string} 格式化的时间字符串 (YYYY-MM-DD HH:mm:ss)
 */
const ts = () => dayjs().format('YYYY-MM-DD HH:mm:ss');

const LOG_DIR = path.join(__dirname, 'logs');
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (err) {
  console.error('[Logger] Failed to create logs directory:', err);
}

let serverLogStream = null;

/**
 * 将日志信息写入服务器日志文件
 * @param {string} level - 日志级别 ('log', 'warn', 'error' 等)
 * @param {...*} args - 要记录的日志内容，可以是任意类型
 */
function logToFile(level, ...args) {
  // 优化：将 'log' 级别统一为 'info'，符合标准日志规范
  const normalizedLevel = level === 'log' ? 'info' : level;
  const message = args
    .map((arg) => {
      if (typeof arg === 'object' && arg !== null) {
        try {
          return JSON.stringify(arg, null, 2);
        } catch (e) {
          return '[Object with circular reference or unserializable]';
        }
      }
      return String(arg);
    })
    .join(' ');
  const logLine = `[${ts()}] [${normalizedLevel.toUpperCase()}] ${message}\n`;

  if (!serverLogStream) {
    try {
      serverLogStream = fs.createWriteStream(path.join(LOG_DIR, 'server.log'), { flags: 'a' });
    } catch (err) {
      console.error('[Logger] Failed to create log stream:', err);
      return;
    }
  }

  serverLogStream.write(logLine);
}

// 重写控制台方法，在生产环境下同时将日志输出到文件
['log', 'warn', 'error'].forEach((method) => {
  const orig = console[method];
  console[method] = (...args) => {
    orig(`[${ts()}]`, ...args);

    // 生产环境才写日志文件，开发环境只输出到控制台
    if (process.env.NODE_ENV === 'production') {
      logToFile(method, ...args);
    }
  };
});

/**
 * 创建支持自动轮转的日志文件流
 * 当文件大小超过限制时，会自动轮转到新的日志文件，并保留指定数量的备份文件
 * @param {string} fileName - 日志文件的基础名称
 * @returns {Object} 包含 write 和 end 方法的日志流对象
 * @returns {Function} returns.write - 写入日志数据的方法
 * @returns {Function} returns.end - 关闭日志流的方法
 */
function createRotatingStream(fileName) {
  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  const MAX_BACKUPS = 5;
  let currentSize = 0;
  let stream = null;
  let fileIndex = 0;
  let isRotating = false; // 防止并发轮转

  /**
   * 获取当前日志文件的完整路径
   * @returns {string} 日志文件的绝对路径
   */
  function getCurrentFilePath() {
    if (fileIndex === 0) {
      return path.join(LOG_DIR, `${fileName}.log`);
    }
    return path.join(LOG_DIR, `${fileName}.${fileIndex}.log`);
  }

  /**
   * 创建新的文件写入流
   * 如果文件已存在，会读取其当前大小以继续累加计数
   */
  function createNewStream() {
    try {
      const currentPath = getCurrentFilePath();
      stream = fs.createWriteStream(currentPath, { flags: 'a' });

      if (fs.existsSync(currentPath)) {
        currentSize = fs.statSync(currentPath).size;
      } else {
        currentSize = 0;
      }
    } catch (err) {
      console.error(`[RotatingStream] Failed to create stream for ${fileName}:`, err);
    }
  }

  /**
   * 执行日志文件轮转操作
   * 删除最旧的备份文件，重命名现有文件，并创建新的日志文件
   */
  function rotate() {
    if (isRotating) return; // 防止并发轮转
    isRotating = true;

    try {
      if (stream) {
        stream.end();
        stream = null;
      }

      // 如果达到最大备份数量，删除最旧的文件并移动其他文件
      if (fileIndex >= MAX_BACKUPS) {
        const oldestPath = path.join(LOG_DIR, `${fileName}.${MAX_BACKUPS}.log`);
        if (fs.existsSync(oldestPath)) {
          try {
            fs.unlinkSync(oldestPath);
          } catch (err) {
            console.error(`[RotatingStream] Failed to delete oldest log ${oldestPath}:`, err);
          }
        }
        for (let i = MAX_BACKUPS; i > 1; i--) {
          const src = path.join(LOG_DIR, `${fileName}.${i - 1}.log`);
          const dst = path.join(LOG_DIR, `${fileName}.${i}.log`);
          if (fs.existsSync(src)) {
            try {
              fs.renameSync(src, dst);
            } catch (err) {
              console.error(`[RotatingStream] Failed to rename ${src} to ${dst}:`, err);
            }
          }
        }
        fileIndex = 0;
      } else {
        fileIndex++;
      }
      createNewStream();
    } catch (err) {
      console.error(`[RotatingStream] Rotation failed for ${fileName}:`, err);
    } finally {
      isRotating = false;
    }
  }

  createNewStream();

  return {
    /**
     * 写入日志数据
     * 在写入前检查文件大小，如果超过限制则触发轮转
     * @param {string|Buffer} data - 要写入的日志数据
     */
    write: function (data) {
      if (!stream) {
        createNewStream();
        if (!stream) return; // 如果创建失败，直接返回
      }

      // 优化：先检查再写入，减少竞态窗口
      if (currentSize + Buffer.byteLength(data) > MAX_FILE_SIZE) {
        rotate();
      }

      if (stream) {
        try {
          stream.write(data);
          currentSize += Buffer.byteLength(data);
        } catch (err) {
          console.error(`[RotatingStream] Write failed for ${fileName}:`, err);
        }
      }
    },
    /**
     * 关闭日志流
     */
    end: function () {
      if (stream) {
        try {
          stream.end();
        } catch (err) {
          console.error(`[RotatingStream] End failed for ${fileName}:`, err);
        }
        stream = null;
      }
    },
  };
}

const accessLogStream = createRotatingStream('access');

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
// 日志记录格式 - 同时输出到控制台和文件
const morganMiddleware = morgan(moganFormat, {
  stream: {
    write: function (message) {
      process.stdout.write(message);
      accessLogStream.write(message);
    },
  },
});
app.use(morganMiddleware);

// 注册全局中间件，为所有模板提供通用的本地变量和工具函数
app.use((req, res, next) => {
  res.locals.path = req.path;
  res.locals.title = 'Live Recorder Server';
  res.locals.dayjs = dayjs;

  /**
   * 格式化日期时间为指定格式的字符串
   * 支持时间戳（秒/毫秒）、日期字符串等多种输入格式
   * @param {number|string|Date} date - 要格式化的日期，可以是时间戳、日期字符串或Date对象
   * @param {string} [format='YYYY-MM-DD HH:mm:ss'] - 输出的日期格式，默认为 'YYYY-MM-DD HH:mm:ss'
   * @returns {string} 格式化后的日期字符串，如果日期无效则返回 '-'
   */
  res.locals.formatDate = (date, format = 'YYYY-MM-DD HH:mm:ss') => {
    if (!date) return '-';

    // 1. 如果输入是字符串，先尝试检查它是否是"纯数字"形式的时间戳
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
/**
 * 应用启动初始化函数
 * 按顺序执行数据库迁移、清理Redis缓存、清理过期录制会话、初始化转码队列、启动看门狗等操作
 * @async
 * @throws {Error} 如果初始化过程中出现错误，将记录错误并退出进程
 */
async function init() {
  try {
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
  } catch (err) {
    console.error('[启动失败] 初始化出错:', err);
    process.exit(1);
  }
}

init().catch((err) => {
  console.error('[启动失败] 未捕获的错误:', err);
  process.exit(1);
});

/**
 * 优雅关闭处理函数
 * 在收到终止信号时，停止轮询管理器、关闭日志流，然后安全退出进程
 * @param {string} signal - 触发关闭的信号名称（如 'SIGTERM', 'SIGINT' 等）
 * @async
 */
async function gracefulShutdown(signal) {
  console.log(`[退出] 收到 ${signal}，正在关闭服务...`);

  try {
    await pollingManager.stop();

    // 关闭日志流
    if (serverLogStream) {
      serverLogStream.end();
      serverLogStream = null;
    }

    if (accessLogStream) {
      accessLogStream.end();
    }

    console.log('[退出] 所有资源已清理');
  } catch (err) {
    console.error('[退出] 清理资源时出错:', err);
  } finally {
    process.exit(0);
  }
}

// 注册进程信号处理器，实现优雅关闭
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 处理未捕获的异常
process.on('uncaughtException', (err) => {
  console.error('[未捕获的异常]:', err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error('[未处理的Promise拒绝]:', reason);
  gracefulShutdown('unhandledRejection');
});
