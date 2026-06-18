const fs = require('fs');
const path = require('path');
const { getLogsDir } = require('../config/config');

const DEFAULT_TAIL_LINES = 2000;
const MAX_TAIL_LINES = 5000;
const READ_BLOCK_SIZE = 64 * 1024;

class LogFileService {
  constructor(logsDir = path.join(getLogsDir(), 'logs')) {
    this.logsDir = path.resolve(logsDir);
  }

  async listFiles() {
    let entries = [];
    try {
      entries = await fs.promises.readdir(this.logsDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  }

  async resolveLogPath(fileName) {
    if (!fileName || fileName !== path.basename(fileName) || !fileName.endsWith('.log')) {
      const err = new Error('日志文件名非法');
      err.status = 400;
      throw err;
    }

    const files = await this.listFiles();
    if (!files.includes(fileName)) {
      const err = new Error('日志文件不存在');
      err.status = 404;
      throw err;
    }

    const fullPath = path.resolve(this.logsDir, fileName);
    if (!fullPath.startsWith(`${this.logsDir}${path.sep}`)) {
      const err = new Error('日志路径非法');
      err.status = 403;
      throw err;
    }

    return fullPath;
  }

  normalizeTail(value, defaultValue = DEFAULT_TAIL_LINES) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
    return Math.min(parsed, MAX_TAIL_LINES);
  }

  async tailLines(fileName, tail = DEFAULT_TAIL_LINES) {
    const lineLimit = this.normalizeTail(tail);
    const filePath = await this.resolveLogPath(fileName);
    if (lineLimit === 0) {
      const stat = await fs.promises.stat(filePath);
      return { file: fileName, lines: [], truncated: false, offset: stat.size };
    }

    const stat = await fs.promises.stat(filePath);
    if (stat.size === 0) {
      return { file: fileName, lines: [], truncated: false, offset: 0 };
    }

    const fd = await fs.promises.open(filePath, 'r');
    let position = stat.size;
    let content = '';
    let lineBreaks = 0;
    let truncated = false;

    try {
      while (position > 0 && lineBreaks <= lineLimit) {
        const readSize = Math.min(READ_BLOCK_SIZE, position);
        position -= readSize;

        const buffer = Buffer.alloc(readSize);
        await fd.read(buffer, 0, readSize, position);
        const chunk = buffer.toString('utf8');
        content = chunk + content;
        lineBreaks += (chunk.match(/\n/g) || []).length;
      }

      let lines = content.split(/\r?\n/);
      if (lines[lines.length - 1] === '') lines = lines.slice(0, -1);
      if (lines.length > lineLimit) {
        truncated = true;
        lines = lines.slice(-lineLimit);
      }

      return { file: fileName, lines, truncated, offset: stat.size };
    } finally {
      await fd.close();
    }
  }

  async readRange(fileName, start, end) {
    const filePath = await this.resolveLogPath(fileName);
    return new Promise((resolve, reject) => {
      let data = '';
      const stream = fs.createReadStream(filePath, { start, end, encoding: 'utf8' });
      stream.on('data', (chunk) => {
        data += chunk;
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(data));
    });
  }
}

module.exports = LogFileService;
