#!/bin/sh
set -eu

APP_DATA_DIR="${APP_DATA_DIR:-/data}"
VIDEO_DOWNLOAD_DIR="${VIDEO_DOWNLOAD_DIR:-$APP_DATA_DIR/video_downloads}"
BILIUP_WORK_DIR="${BILIUP_WORK_DIR:-$APP_DATA_DIR/biliup}"

# 此时是 root 身份，创建目录并纠正权限（即使 NAS 挂载进来的目录权限不对也会被强制修复）
mkdir -p "$VIDEO_DOWNLOAD_DIR" "$BILIUP_WORK_DIR" /app/logs
chown -R nodeuser:nodeuser "$VIDEO_DOWNLOAD_DIR" "$BILIUP_WORK_DIR" /app/logs

wait_for_postgres() {
  node <<'NODE'
const { Client } = require('pg');

const maxAttempts = 60;
const delay = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function configFor(database) {
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    if (database) url.pathname = `/${database}`;
    return { connectionString: url.toString() };
  }

  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: database || process.env.DB_NAME,
  };
}

(async () => {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const client = new Client(configFor('postgres'));
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      process.exit(0);
    } catch (err) {
      lastError = err;
      try {
        await client.end();
      } catch (_) {}
      console.log(`[entrypoint] 等待 PostgreSQL (${attempt}/${maxAttempts}): ${err.message}`);
      await sleep(delay);
    }
  }
  console.error('[entrypoint] PostgreSQL 不可用:', lastError && lastError.message);
  process.exit(1);
})();
NODE
}

wait_for_redis() {
  node <<'NODE'
const { createClient } = require('redis');

const maxAttempts = 60;
const delay = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redisOptions() {
  if (process.env.REDIS_URL) {
    const url = new URL(process.env.REDIS_URL);
    const db = url.pathname.replace(/^\//, '');
    return {
      url: process.env.REDIS_URL,
      database: db ? Number(db) : undefined,
    };
  }

  const host = process.env.REDIS_HOST;
  const port = process.env.REDIS_PORT || 6379;
  const password = process.env.REDIS_PASSWORD || '';
  const user = process.env.REDIS_USER || 'default';
  const url = password
    ? `redis://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}`
    : `redis://${host}:${port}`;

  return {
    url,
    database: Number(process.env.REDIS_DB || 1),
  };
}

(async () => {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const client = createClient(redisOptions());
    client.on('error', () => {});
    try {
      await client.connect();
      await client.ping();
      await client.disconnect();
      process.exit(0);
    } catch (err) {
      lastError = err;
      try {
        await client.disconnect();
      } catch (_) {}
      console.log(`[entrypoint] 等待 Redis (${attempt}/${maxAttempts}): ${err.message}`);
      await sleep(delay);
    }
  }
  console.error('[entrypoint] Redis 不可用:', lastError && lastError.message);
  process.exit(1);
})();
NODE
}

wait_for_postgres
wait_for_redis

# ==========================================
# [重要修改] 核心：使用 gosu 降权安全启动主程序
# ==========================================
if [ "$1" = "node" ]; then
    exec gosu nodeuser "$@"
fi

# 如果是传入了其他命令（如 bash 调试），则直接用 root 执行
exec "$@"