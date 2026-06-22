const fs = require('fs');
const path = require('path');
const { getLogsDir } = require('../config/config');
const DataService = require('./DataService');

const DEFAULT_RETENTION_DAYS = 30;

function normalizeRetentionDays(value, fallback = DEFAULT_RETENTION_DAYS) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

class LogCleanupService {
  constructor(options = {}) {
    this.logsDir = path.resolve(options.logsDir || path.join(getLogsDir(), 'logs'));
    this.defaultRetentionDays = normalizeRetentionDays(options.defaultRetentionDays, DEFAULT_RETENTION_DAYS);
    this.retentionDays =
      options.retentionDays === undefined
        ? null
        : normalizeRetentionDays(options.retentionDays, this.defaultRetentionDays);
    this.settingsKey = options.settingsKey === undefined ? 'log_retention_days' : options.settingsKey;
    this.maxTotalSize = options.maxTotalSize || 1024 * 1024 * 1024;
    this.activeWindowMs = options.activeWindowMs || 5 * 60 * 1000;
    this.protectedFiles = new Set(options.protectedFiles || ['access.log', 'server.log']);
    this.intervalMs = options.intervalMs || 24 * 60 * 60 * 1000;
    this.timer = null;
  }

  async cleanup(now = Date.now()) {
    const retentionDays = await this.getRetentionDays();
    const files = await this.getLogFiles(now);
    const deleted = [];
    let releasedBytes = 0;

    for (const file of files) {
      if (!file.protected && now - file.mtimeMs > retentionDays * 24 * 60 * 60 * 1000) {
        const result = await this.deleteFile(file);
        if (result) {
          deleted.push(result);
          releasedBytes += result.size;
        }
      }
    }

    const remaining = files.filter((file) => !deleted.some((item) => item.file === file.name));
    let totalSize = remaining.reduce((sum, file) => sum + file.size, 0);
    const deletionCandidates = remaining.filter((file) => !file.protected).sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const file of deletionCandidates) {
      if (totalSize <= this.maxTotalSize) break;

      const result = await this.deleteFile(file);
      if (result) {
        deleted.push(result);
        releasedBytes += result.size;
        totalSize -= result.size;
      }
    }

    if (deleted.length > 0) {
      console.log(`[LogCleanup] 清理 ${deleted.length} 个日志文件，释放 ${(releasedBytes / 1024 / 1024).toFixed(1)}MB`);
    }

    return { deleted, releasedBytes };
  }

  async getRetentionDays() {
    if (this.retentionDays !== null) {
      return this.retentionDays;
    }

    if (!this.settingsKey) {
      return this.defaultRetentionDays;
    }

    const value = await DataService.getSetting(this.settingsKey, String(this.defaultRetentionDays));
    return normalizeRetentionDays(value, this.defaultRetentionDays);
  }

  start() {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.cleanup().catch((err) => {
        console.error('[LogCleanup] 定时清理失败:', err.message);
      });
    }, this.intervalMs);

    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop() {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = null;
  }

  async getLogFiles(now) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(this.logsDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue;

      const fullPath = path.join(this.logsDir, entry.name);
      const stat = await fs.promises.stat(fullPath);
      files.push({
        name: entry.name,
        fullPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        protected: this.isProtected(entry.name, stat.mtimeMs, now),
      });
    }

    return files;
  }

  isProtected(fileName, mtimeMs, now) {
    return this.protectedFiles.has(fileName) || now - mtimeMs <= this.activeWindowMs;
  }

  async deleteFile(file) {
    try {
      await fs.promises.unlink(file.fullPath);
      return { file: file.name, size: file.size };
    } catch (err) {
      console.error(`[LogCleanup] 删除日志失败: ${file.name}`, err.message);
      return null;
    }
  }
}

module.exports = LogCleanupService;
