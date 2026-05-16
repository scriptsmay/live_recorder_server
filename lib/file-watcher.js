const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const pool = require('../db/index');
const redis = require('../db/redis');

const watchers = new Map();
const concurrencyLocks = new Map();

function acquireMemoryLock(sessionId, filePath) {
  if (!concurrencyLocks.has(sessionId)) {
    concurrencyLocks.set(sessionId, new Set());
  }
  const locks = concurrencyLocks.get(sessionId);
  if (locks.has(filePath)) return false;
  locks.add(filePath);
  return true;
}

function releaseMemoryLock(sessionId, filePath) {
  const locks = concurrencyLocks.get(sessionId);
  if (locks) {
    locks.delete(filePath);
    if (locks.size === 0) concurrencyLocks.delete(sessionId);
  }
}

async function acquireRedisLock(filePath) {
  const hash = Buffer.from(filePath).toString('base64').slice(0, 32);
  const key = `watch:file:${hash}`;
  try {
    const result = await redis.set(key, '1', { EX: 10, NX: true });
    return result === 'OK';
  } catch {
    return true;
  }
}

function releaseRedisLock(filePath) {
  const hash = Buffer.from(filePath).toString('base64').slice(0, 32);
  const key = `watch:file:${hash}`;
  redis.del(key).catch(() => {});
}

function watchRoom(roomUrl, outputDir, sessionId) {
  const key = `${roomUrl}:${outputDir}`;
  if (watchers.has(key)) return;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const watcher = chokidar.watch(outputDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
    ignored: /\.part$/,
  });

  watcher.on('add', async (filePath) => {
    if (!/\.(mp4|flv|ts)$/i.test(filePath)) return;
    if (!acquireMemoryLock(sessionId, filePath)) return;

    const redisOk = await acquireRedisLock(filePath);
    if (!redisOk) {
      releaseMemoryLock(sessionId, filePath);
      return;
    }

    try {
      const existing = await pool.query('SELECT id FROM recording_files WHERE file_path = $1', [filePath]);
      if (existing.rows.length > 0) return;

      let size = 0;
      try {
        size = fs.statSync(filePath).size;
      } catch (_) {}

      await pool.query(
        `INSERT INTO recording_files (session_id, room_url, file_path, file_name, file_size, status, checked_at)
         VALUES ($1, $2, $3, $4, $5, 'completed', NOW())
         ON CONFLICT (file_path) DO NOTHING`,
        [sessionId, roomUrl, filePath, path.basename(filePath), size]
      );
    } finally {
      releaseRedisLock(filePath);
      releaseMemoryLock(sessionId, filePath);
    }
  });

  watcher.on('change', async (filePath) => {
    if (!/\.(mp4|flv|ts)$/i.test(filePath)) return;
    try {
      let size = 0;
      try {
        size = fs.statSync(filePath).size;
      } catch (_) {}
      await pool.query(`UPDATE recording_files SET file_size = $1, checked_at = NOW() WHERE file_path = $2`, [
        size,
        filePath,
      ]);
    } catch (_) {}
  });

  watcher.on('unlink', async (filePath) => {
    try {
      await pool.query(`UPDATE recording_files SET status = 'missing', checked_at = NOW() WHERE file_path = $1`, [
        filePath,
      ]);
    } catch (_) {}
  });

  watchers.set(key, watcher);
}

function unwatchRoom(roomUrl, outputDir, sessionId) {
  const key = `${roomUrl}:${outputDir}`;
  const watcher = watchers.get(key);
  if (watcher) {
    watcher.close().catch(() => {});
    watchers.delete(key);
  }
  if (sessionId) {
    concurrencyLocks.delete(sessionId);
  }
}

module.exports = { watchRoom, unwatchRoom };
