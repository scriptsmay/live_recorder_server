const path = require('path');
const fs = require('fs');
const dayjs = require('dayjs');

const ts = () => dayjs().format('YYYY-MM-DD HH:mm:ss');

const LOG_DIR = path.join(__dirname, '../../logs');
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (err) {
  console.error('[Logger] Failed to create logs directory:', err);
}

let serverLogStream = null;

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

['log', 'warn', 'error'].forEach((method) => {
  const orig = console[method];
  console[method] = (...args) => {
    orig(`[${ts()}]`, ...args);

    if (process.env.NODE_ENV === 'production') {
      logToFile(method, ...args);
    }
  };
});

function createRotatingStream(fileName) {
  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  const MAX_BACKUPS = 5;
  let currentSize = 0;
  let stream = null;
  let fileIndex = 0;
  let isRotating = false;

  function getCurrentFilePath() {
    if (fileIndex === 0) {
      return path.join(LOG_DIR, `${fileName}.log`);
    }
    return path.join(LOG_DIR, `${fileName}.${fileIndex}.log`);
  }

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

  function rotate() {
    if (isRotating) return;
    isRotating = true;

    try {
      if (stream) {
        stream.end();
        stream = null;
      }

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
    write: function (data) {
      if (!stream) {
        createNewStream();
        if (!stream) return;
      }

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

function configureAccessLogger() {
  const accessLogStream = createRotatingStream('access');

  let moganFormat = 'dev';
  if (process.env.NODE_ENV === 'production') {
    morgan.token('local-date', ts);
    moganFormat = ':local-date :method :url :status :response-time ms';
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

module.exports = {
  createRotatingStream,
  configureAccessLogger,
  getServerLogStream,
};
