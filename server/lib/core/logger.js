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

['log', 'warn', 'error'].forEach((method) => {
  const orig = console[method];
  console[method] = (...args) => {
    orig(`${ts()} |`, ...args);

    if (process.env.NODE_ENV === 'production') {
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

module.exports = {
  createRotatingStream,
  configureAccessLogger,
  getServerLogStream,
  getAccessLogStream,
};
