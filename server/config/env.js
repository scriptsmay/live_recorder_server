const path = require('path');
const dotenv = require('dotenv');

const rootDir = path.join(__dirname, '..', '..');

function loadEnv(options = {}) {
  const mode = options.mode || process.env.NODE_ENV;

  dotenv.config({ path: path.join(rootDir, '.env'), quiet: true });

  if (mode === 'development') {
    dotenv.config({
      path: path.join(rootDir, '.env.dev'),
      override: true,
      quiet: true,
    });
  }
}

function applyDockerDefaults() {
  const appDataDir = process.env.APP_DATA_DIR || '/data';
  process.env.APP_DATA_DIR = appDataDir;

  if (!process.env.VIDEO_DOWNLOAD_DIR) {
    process.env.VIDEO_DOWNLOAD_DIR = path.join(appDataDir, 'video_downloads');
  }

  if (!process.env.BILIUP_WORK_DIR) {
    process.env.BILIUP_WORK_DIR = path.join(appDataDir, 'biliup');
  }

  if (!process.env.REPLAY_WORK_DIR) {
    process.env.REPLAY_WORK_DIR = path.join(path.dirname(process.env.VIDEO_DOWNLOAD_DIR), 'replay');
  }
}

function applyDatabaseUrl() {
  if (!process.env.DATABASE_URL) return;

  const url = new URL(process.env.DATABASE_URL);
  process.env.DB_HOST = process.env.DB_HOST || url.hostname;
  process.env.DB_PORT = process.env.DB_PORT || url.port || '5432';
  process.env.DB_NAME = process.env.DB_NAME || decodeURIComponent(url.pathname.replace(/^\//, ''));
  process.env.DB_USER = process.env.DB_USER || decodeURIComponent(url.username);
  process.env.DB_PASSWORD = process.env.DB_PASSWORD || decodeURIComponent(url.password);
}

function applyRedisUrl() {
  if (!process.env.REDIS_URL) return;

  const url = new URL(process.env.REDIS_URL);
  const db = url.pathname.replace(/^\//, '');
  process.env.REDIS_HOST = process.env.REDIS_HOST || url.hostname;
  process.env.REDIS_PORT = process.env.REDIS_PORT || url.port || '6379';
  process.env.REDIS_USER = process.env.REDIS_USER || decodeURIComponent(url.username || 'default');
  process.env.REDIS_PASSWORD = process.env.REDIS_PASSWORD || decodeURIComponent(url.password || '');
  if (db) process.env.REDIS_DB = process.env.REDIS_DB || db;
}

function applyEnvDefaults() {
  applyDockerDefaults();
  applyDatabaseUrl();
  applyRedisUrl();
}

function initEnv(options = {}) {
  loadEnv(options);
  applyEnvDefaults();

  return process.env;
}

module.exports = {
  loadEnv,
  applyEnvDefaults,
  initEnv,
};
