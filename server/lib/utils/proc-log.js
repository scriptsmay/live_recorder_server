const path = require('path');
const fs = require('fs');
const dayjs = require('dayjs');
const { getLogsDir } = require('../../config/config');

const LOG_DIR = path.join(getLogsDir(), 'logs');

// 确保目录存在（只执行一次）
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function createProcLog(name, id) {
  const getPath = (currentId) =>
    path.join(LOG_DIR, `${name}_${currentId || Date.now()}_${Math.random().toString(36).slice(2, 6)}.log`);

  let currentLogPath = id ? path.join(LOG_DIR, `${name}_${id}.log`) : getPath();

  // 使用 createWriteStream，它比手动 fd 更安全，且支持自动流管理
  let stream = fs.createWriteStream(currentLogPath, { flags: 'a' });

  // 添加防崩溃监控，防止单个日志过大
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB
  let currentSize = fs.existsSync(currentLogPath) ? fs.statSync(currentLogPath).size : 0;

  const logger = {
    stream,
    get logPath() {
      return currentLogPath;
    },

    // 异步安全地重命名/归档
    rename(newId) {
      const newPath = path.join(LOG_DIR, `${name}_${newId}.log`);
      // 先停止当前流
      stream.end();
      try {
        if (fs.existsSync(currentLogPath)) fs.renameSync(currentLogPath, newPath);
        currentLogPath = newPath;
        // 重建流
        stream = fs.createWriteStream(currentLogPath, { flags: 'a' });
        logger.stream = stream;
      } catch (err) {
        console.error('Log rename failed:', err);
      }
    },

    logCommand(command, args) {
      const entry = `# COMMAND: ${command} ${args.join(' ')}\n`;
      stream.write(entry);
      currentSize += entry.length;

      // 简单的滚动触发：如果超过 10MB 自动归档
      if (currentSize > MAX_SIZE) {
        this.rename(`${name}_rotated_${Date.now()}`);
        currentSize = 0;
      }
    },

    // 显式销毁资源
    destroy() {
      if (stream) stream.end();
    },
  };

  return logger;
}

function writeLog(logStream, message) {
  if (!logStream) return;
  logStream.write(`[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] ${message}\n`);
}

module.exports = { createProcLog, writeLog };
