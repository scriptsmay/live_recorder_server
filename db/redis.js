const { createClient } = require('redis');

const host = process.env.REDIS_HOST;
const port = process.env.REDIS_PORT || 6379;
const password = process.env.REDIS_PASSWORD || '';
const user = process.env.REDIS_USER || 'default';
const db = parseInt(process.env.REDIS_DB, 10) || 1;

const url = password
  ? `redis://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}`
  : `redis://${host}:${port}`;

const client = createClient({ url, database: db });

client.on('error', (err) => {
  if (err.code === 'CONNECTION_BROKEN') return;
  console.error('[Redis] 错误:', err.message);
});

client.on('connect', () => {
  console.log('[Redis] 已连接');
});

client.on('end', () => {
  console.log('[Redis] 连接已关闭');
});

module.exports = client;
