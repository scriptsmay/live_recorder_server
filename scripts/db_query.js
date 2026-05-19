// 处理开发环境数据库事务
require('../config/env').initEnv({ mode: 'development' });

const pool = require('../db/index');
const ensureDatabase = require('../db/ensure-database');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

async function dbQuery() {
  await ensureDatabase();

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await runQuery();
    } catch (err) {
      lastError = err;
      if (err.code === '3D000' && attempt === 1) {
        try {
          await ensureDatabase();
          continue;
        } catch (createErr) {
          console.error('[DB] 执行失败:', createErr.message);
        }
      }
      if (err.code === '40P01' && attempt < MAX_RETRIES) {
        console.warn(`[DB] 死锁检测 (${attempt}/${MAX_RETRIES}), ${RETRY_DELAY_MS}ms 后重试...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

async function runQuery() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`TRUNCATE TABLE recordings;`);
    await client.query(`TRUNCATE TABLE recording_files;`);
    await client.query(`TRUNCATE TABLE recording_sessions RESTART IDENTITY CASCADE;`);

    await client.query('COMMIT');
    console.log('[DB] 数据库事务执行完成');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] 数据库事务执行失败:', err);
    throw err;
  } finally {
    client.release();
  }
}

dbQuery().then(() => process.exit(0));
