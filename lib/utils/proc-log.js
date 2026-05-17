const path = require('path');
const fs = require('fs');

const LOG_DIR = path.join(__dirname, '../../', 'logs');

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function createProcLog(name, id) {
  ensureDir();

  const initialLogPath = id
    ? path.join(LOG_DIR, `${name}_${id}.log`)
    : path.join(LOG_DIR, `${name}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.log`);

  const fd = fs.openSync(initialLogPath, 'a');
  const stream = fs.createWriteStream(initialLogPath, { fd });

  const state = { logPath: initialLogPath };

  function rename(newId) {
    const newPath = path.join(LOG_DIR, `${name}_${newId}.log`);
    try {
      fs.renameSync(state.logPath, newPath);
      state.logPath = newPath;
    } catch (_) {}
  }

  function logCommand(command, args) {
    stream.write(`# COMMAND: ${command} ${args.join(' ')}\n`);
  }

  return {
    stream,
    get logPath() {
      return state.logPath;
    },
    rename,
    logCommand,
  };
}

module.exports = { createProcLog };
