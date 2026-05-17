const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT, 10),
  max: parseInt(process.env.DB_POOL_MAX, 10) || 20,
  min: parseInt(process.env.DB_POOL_MIN, 10) || 2,
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT, 10) || 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT, 10) || 2000,
  maxUses: parseInt(process.env.DB_MAX_USES, 10) || 7500,
});

pool.on('error', (err) => {
  console.error('[DB] PostgreSQL 连接池异常:', err);
});

pool.on('connect', () => {
  console.log('[DB] PostgreSQL 连接已建立');
});

module.exports = pool;
