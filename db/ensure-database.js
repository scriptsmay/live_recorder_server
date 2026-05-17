const { Client } = require('pg');

const MAINTENANCE_DBS = ['postgres', 'template1'];

/**
 * 若目标库不存在则创建（需对 maintenance 库有 CREATEDB 权限）。
 * @returns {Promise<boolean>} 是否新建了数据库
 */
async function ensureDatabase() {
  const dbName = process.env.DB_NAME;
  if (!dbName) {
    throw new Error('[DB] 未设置 DB_NAME');
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbName)) {
    throw new Error(`[DB] 非法数据库名: ${dbName}`);
  }

  let lastErr;
  for (const maintenanceDb of MAINTENANCE_DBS) {
    const client = new Client({
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      password: process.env.DB_PASSWORD,
      port: parseInt(process.env.DB_PORT, 10),
      database: maintenanceDb,
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT, 10) || 5000,
    });

    try {
      await client.connect();
      const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
      if (exists.rows.length > 0) {
        return false;
      }
      await client.query(`CREATE DATABASE "${dbName}"`);
      console.log(`[DB] 已创建数据库: ${dbName}`);
      return true;
    } catch (err) {
      lastErr = err;
      if (err.code === '42P04') {
        return false;
      }
      if (err.code === '42501') {
        throw new Error(
          `[DB] 账号无 CREATEDB 权限，请手动执行: CREATE DATABASE "${dbName}";`
        );
      }
    } finally {
      try {
        await client.end();
      } catch (_) {}
    }
  }

  throw lastErr || new Error('[DB] 无法连接 PostgreSQL 以检查/创建数据库');
}

module.exports = ensureDatabase;
