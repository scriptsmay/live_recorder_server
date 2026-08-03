const path = require('path');
const fs = require('fs');
const dayjs = require('dayjs');
const morgan = require('morgan');
const { getLogsDir } = require('../../config/config');

const ts = () => dayjs().format('YYYY-MM-DD HH:mm:ss');

const LOG_DIR = path.join(getLogsDir(), 'logs');
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (err) {
  console.error('[Logger] Failed to create logs directory:', err);
}

let serverLogStream = null;
let accessLogStream = null;

// 模块日志流缓存：同一 fileName（含轮转相关配置）只创建一个轮转流。
// 避免 PollingManager / 各平台 Checker / signers 各自 createModuleLogger('polling')
// 时多个独立流维护各自 currentSize，并发写入同一 polling.log 导致大小阈值 / 轮转状态失真。
const __moduleStreamCache = new Map();

const ROTATION_DEFAULTS = {
  maxFileSize: 10 * 1024 * 1024,
  maxBackupsPerDay: 5,
  retentionDays: null,
};

function logToFile(level, ...args) {
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
  const logLine = `${ts()} | [${normalizedLevel.toUpperCase()}] ${message}\n`;

  if (!serverLogStream) {
    try {
      serverLogStream = createRotatingStream('server');
    } catch (err) {
      console.error('[Logger] Failed to create log stream:', err);
      return;
    }
  }

  serverLogStream.write(logLine);
}

// 保存被覆盖前的原始 console 方法，供模块级日志器用于「只写文件+终端」路径，
// 避免再次触发全局覆盖逻辑而重复写入 server.log
const origConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

// 临时抑制 server.log 镜像：mirrorToServer:false 时仍走全局 console（保证终端始终打印），
// 但本次调用不写入 server.log。同步代码内使用，调用后即恢复，无重入风险。
let _suppressServerMirror = false;

['log', 'warn', 'error'].forEach((method) => {
  const orig = console[method];
  console[method] = (...args) => {
    orig(`${ts()} |`, ...args);

    if (process.env.NODE_ENV === 'production' && !_suppressServerMirror) {
      logToFile(method, ...args);
    }
  };
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dateKey(date) {
  return dayjs(date).format('YYYY-MM-DD');
}

function currentLogPath(logDir, fileName) {
  return path.join(logDir, `${fileName}.log`);
}

function datedLogPath(logDir, fileName, date, index = null) {
  const suffix = index ? `.${index}` : '';
  return path.join(logDir, `${fileName}.${date}${suffix}.log`);
}

function parseDatedLogName(fileName, name) {
  const pattern = new RegExp(`^${escapeRegExp(fileName)}\\.(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d+))?\\.log$`);
  const match = name.match(pattern);
  if (!match) return null;
  return {
    date: match[1],
    index: match[2] ? Number(match[2]) : null,
  };
}

function statSize(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  } catch (err) {
    console.error(`[RotatingStream] Failed to stat ${filePath}:`, err);
    return 0;
  }
}

function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error(`[RotatingStream] Failed to delete ${filePath}:`, err);
  }
}

function renameIfExists(src, dst) {
  try {
    if (fs.existsSync(src)) {
      fs.renameSync(src, dst);
      return true;
    }
  } catch (err) {
    console.error(`[RotatingStream] Failed to rename ${src} to ${dst}:`, err);
  }
  return false;
}

/**
 * 创建支持日期和大小双维度轮转的日志写入对象。
 *
 * 当前日志始终写入 logs/{fileName}.log；日期变化时归档为
 * {fileName}.YYYY-MM-DD.log；当天文件超过大小限制时归档为
 * {fileName}.YYYY-MM-DD.N.log，且每日期最多保留指定数量的大小备份。
 *
 * @param {string} fileName 日志文件基础名，不包含扩展名。
 * @param {Object} [options] 测试和特殊场景用配置，调用方无需传入。
 * @returns {{write: Function, end: Function}} 保持 write/end 接口不变。
 */
function createRotatingStream(fileName, options = {}) {
  const logDir = options.logDir || LOG_DIR;
  const maxFileSize = options.maxFileSize ?? ROTATION_DEFAULTS.maxFileSize;
  const maxBackupsPerDay = options.maxBackupsPerDay ?? ROTATION_DEFAULTS.maxBackupsPerDay;
  const retentionDays = options.retentionDays ?? ROTATION_DEFAULTS.retentionDays;
  const now = options.now || (() => new Date());
  const currentPath = currentLogPath(logDir, fileName);

  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  } catch (err) {
    console.error('[RotatingStream] Failed to create logs directory:', err);
  }

  let currentDate = getCurrentLogDate();
  let currentSize = statSize(currentPath);
  let isClosed = false;

  function getCurrentLogDate() {
    try {
      if (fs.existsSync(currentPath)) {
        const stat = fs.statSync(currentPath);
        if (stat.size > 0) {
          return dateKey(stat.mtime);
        }
      }
    } catch (err) {
      console.error(`[RotatingStream] Failed to inspect ${currentPath}:`, err);
    }
    return dateKey(now());
  }

  function cleanupExpiredLogs(referenceTime = now()) {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return;
    }

    const cutoff = dayjs(referenceTime).subtract(retentionDays, 'day').format('YYYY-MM-DD');

    let names = [];
    try {
      names = fs.readdirSync(logDir);
    } catch (err) {
      console.error(`[RotatingStream] Failed to list logs in ${logDir}:`, err);
      return;
    }

    for (const name of names) {
      const parsed = parseDatedLogName(fileName, name);
      if (parsed && parsed.date < cutoff) {
        removeIfExists(path.join(logDir, name));
      }
    }
  }

  function rotateBackupsForDate(date) {
    const oldest = datedLogPath(logDir, fileName, date, maxBackupsPerDay);
    removeIfExists(oldest);

    for (let i = maxBackupsPerDay - 1; i >= 1; i--) {
      const src = datedLogPath(logDir, fileName, date, i);
      const dst = datedLogPath(logDir, fileName, date, i + 1);
      renameIfExists(src, dst);
    }
  }

  function archiveCurrent(date, preferPlainName) {
    if (!fs.existsSync(currentPath) || statSize(currentPath) === 0) {
      currentSize = 0;
      return;
    }

    if (preferPlainName) {
      const plainPath = datedLogPath(logDir, fileName, date);
      if (!fs.existsSync(plainPath)) {
        if (renameIfExists(currentPath, plainPath)) {
          currentSize = 0;
        }
        return;
      }
    }

    rotateBackupsForDate(date);
    const backupPath = datedLogPath(logDir, fileName, date, 1);
    if (renameIfExists(currentPath, backupPath)) {
      currentSize = 0;
    }
  }

  function rotateByDate(nextDate) {
    archiveCurrent(currentDate, true);
    currentDate = nextDate;
    cleanupExpiredLogs();
  }

  function rotateBySize() {
    archiveCurrent(currentDate, false);
    cleanupExpiredLogs();
  }

  cleanupExpiredLogs();

  return {
    write: function (data) {
      if (isClosed) {
        isClosed = false;
      }

      const nextDate = dateKey(now());
      if (nextDate !== currentDate) {
        rotateByDate(nextDate);
      }

      const chunkSize = Buffer.byteLength(data);
      if (currentSize > 0 && currentSize + chunkSize > maxFileSize) {
        rotateBySize();
      }

      try {
        fs.appendFileSync(currentPath, data);
        currentSize += chunkSize;
      } catch (err) {
        console.error(`[RotatingStream] Write failed for ${fileName}:`, err);
      }
    },

    end: function () {
      isClosed = true;
    },
  };
}

/**
 * 获取（或创建并缓存）模块日志的轮转流。
 *
 * 多个调用点使用相同 fileName（如 PollingManager、各 Checker、signers 都传 'polling'）
 * 时，复用同一个轮转流实例，保证 currentSize / 轮转状态在并发写入同一文件时准确一致。
 * 缓存键由 fileName + logDir + 轮转配置组成，不同目录或不同轮转参数的模块互不干扰。
 *
 * @param {string} fileName 日志文件基础名
 * @param {Object} options 透传给 createRotatingStream 的配置
 * @returns {Object} 复用或新创建的轮转流（含 write/end）
 */
function getModuleStream(fileName, options) {
  const logDir = options.logDir || LOG_DIR;
  const maxFileSize = options.maxFileSize ?? ROTATION_DEFAULTS.maxFileSize;
  const maxBackupsPerDay = options.maxBackupsPerDay ?? ROTATION_DEFAULTS.maxBackupsPerDay;
  const retentionDays = options.retentionDays ?? ROTATION_DEFAULTS.retentionDays;
  const key = `${fileName}|${logDir}|${maxFileSize}|${maxBackupsPerDay}|${retentionDays}`;
  if (__moduleStreamCache.has(key)) {
    return __moduleStreamCache.get(key);
  }
  const stream = createRotatingStream(fileName, {
    logDir,
    maxFileSize,
    maxBackupsPerDay,
    retentionDays,
    now: options.now,
  });
  __moduleStreamCache.set(key, stream);
  return stream;
}

function configureAccessLogger() {
  if (!accessLogStream) {
    accessLogStream = createRotatingStream('access');
  }

  let moganFormat = 'dev';
  if (process.env.NODE_ENV === 'production') {
    morgan.token('local-date', ts);
    moganFormat = ':local-date | :method :url :status :response-time ms';
  }

  const morganMiddleware = require('morgan')(moganFormat, {
    stream: {
      write: function (message) {
        process.stdout.write(message);
        accessLogStream.write(message);
      },
    },
  });

  return {
    middleware: morganMiddleware,
    accessLogStream,
  };
}

function getServerLogStream() {
  return serverLogStream;
}

function getAccessLogStream() {
  return accessLogStream;
}

/**
 * 将对象参数序列化为日志消息（与 logToFile 保持一致的格式）。
 *
 * @param {string} level 日志级别（'log' | 'warn' | 'error' | 'debug'）
 * @param {Array<*>} args 原始参数列表
 * @returns {string} 形如 `时间戳 | [LEVEL] message\n` 的单行文本
 */
function formatModuleLine(level, args) {
  const normalizedLevel = level === 'log' ? 'INFO' : level.toUpperCase();
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
  return `${ts()} | [${normalizedLevel}] ${message}\n`;
}

/**
 * 创建模块级日志器，将「高频 / 细节」日志拆分到独立的、按日期轮转的日志文件
 * （如 logs/polling.log、logs/watchdog.log），并保留关键信号镜像进 server.log。
 *
 * 设计要点（详见 docs/LOGGING.md）：
 * - 仅 `NODE_ENV === 'production'` 落盘，与 server.log 一致；开发期只在终端打印。
 * - `info`：仅写模块文件（高频 INFO / 心跳 / 逐明细，不进 server.log）。
 * - `important`：写模块文件 + 镜像 server.log（生命周期关键 INFO）。
 * - `warn` / `error`：写模块文件 + 镜像 server.log。
 * - `debug`：默认不输出（需 options.debug 或 LOG_MODULE_DEBUG 开启），开启后仅写模块文件。
 *
 * @param {string} fileName 日志文件基础名（不含扩展名），如 'polling' → logs/polling.log。
 *                          不得与通用日志同名（server / access）。
 * @param {Object} [options] 透传给 createRotatingStream 的配置，通常无需传。
 * @param {boolean} [options.debug=false] 是否输出 debug 内容。
 * @param {boolean} [options.mirrorToServer=true] important/warn/error 是否镜像进 server.log。
 * @returns {{info: Function, important: Function, warn: Function, error: Function, debug: Function}}
 */
function createModuleLogger(fileName, options = {}) {
  if (fileName === 'server' || fileName === 'access') {
    origConsole.error(`[ModuleLogger] reserved fileName "${fileName}" is not allowed; module log skipped`);
    return {
      info: (...args) => origConsole.log(`${ts()} |`, ...args),
      important: (...args) => console.log(...args),
      warn: (...args) => console.warn(...args),
      error: (...args) => console.error(...args),
      debug: () => {},
    };
  }

  // 错误降级：stream 创建失败时不阻塞模块启动，fallback 到纯终端输出
  let stream = null;
  try {
    stream = getModuleStream(fileName, options);
  } catch (err) {
    origConsole.error(`[ModuleLogger] Failed to create stream for "${fileName}":`, err.message);
    return {
      info: (...args) => origConsole.log(`${ts()} |`, ...args),
      important: (...args) => console.log(...args),
      warn: (...args) => console.warn(...args),
      error: (...args) => console.error(...args),
      debug: () => {},
    };
  }

  const mirrorToServer = options.mirrorToServer !== false; // 默认 true
  const debugEnv = process.env.LOG_MODULE_DEBUG || '';
  const debugEnabled =
    options.debug === true ||
    debugEnv === '*' ||
    debugEnv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(fileName);

  const prod = process.env.NODE_ENV === 'production'; // 落盘时机与 server.log 一致

  // 路径 A：仅模块文件 + 终端（绕过 server.log）
  const writeFileOnly = (level, args) => {
    origConsole[level](`${ts()} |`, ...args); // 终端（始终）
    if (prod) stream.write(formatModuleLine(level, args)); // 模块文件（仅 production）
  };

  // 路径 B：模块文件 + 终端 + 镜像 server.log（复用全局覆写链路）
  const writeAndMirror = (level, args) => {
    if (prod) stream.write(formatModuleLine(level, args)); // 模块文件（仅 production）
    if (mirrorToServer) {
      // 经全局 console 覆写：终端 + 生产期 server.log 镜像
      console[level](...args);
    } else {
      // 仍走全局 console（终端始终打印），但抑制本次调用的 server.log 镜像
      _suppressServerMirror = true;
      try {
        console[level](...args);
      } finally {
        _suppressServerMirror = false;
      }
    }
  };

  return {
    info: (...args) => writeFileOnly('log', args), // 高频 INFO：不镜像
    important: (...args) => writeAndMirror('log', args), // 重要 INFO：镜像
    warn: (...args) => writeAndMirror('warn', args), // 警告：镜像
    error: (...args) => writeAndMirror('error', args), // 错误：镜像
    debug: (...args) => {
      // 调试：默认关闭
      if (!debugEnabled) return;
      origConsole.log(`${ts()} |`, ...args); // 终端（始终）
      if (prod) stream.write(formatModuleLine('debug', args)); // 模块文件（仅 production）
    },
  };
}

module.exports = {
  createRotatingStream,
  createModuleLogger,
  configureAccessLogger,
  getServerLogStream,
  getAccessLogStream,
  __moduleStreamCache, // 测试用：便于断言同 fileName 复用同一轮转流（P1-2）
};
