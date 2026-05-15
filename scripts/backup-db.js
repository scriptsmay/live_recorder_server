const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

require('dotenv').config({
  path: path.join(__dirname, '..', '.env'),
  quiet: true,
});

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const RETENTION_DAYS = 7;

const dbConfig = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
};

async function backup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filePath = path.join(BACKUP_DIR, `backup_${ts}.sql`);

  // 优先用 pg_dump，否则用 Node 导出 INSERT
  try {
    execSync(
      `pg_dump -h ${dbConfig.host} -p ${dbConfig.port} -U ${dbConfig.user} -d ${dbConfig.database} --no-owner --no-acl -f ${filePath}`,
      {
        env: { ...process.env, PGPASSWORD: dbConfig.password },
        stdio: 'pipe',
        timeout: 120000,
      }
    );
    console.log(`[备份] pg_dump 完成: ${filePath}`);
  } catch (pgDumpErr) {
    console.warn('[备份] pg_dump 不可用，使用 Node 导出:', pgDumpErr.message);
    await nodeDump(filePath);
  }

  // 压缩
  try {
    execSync(`gzip -f ${filePath}`, { stdio: 'pipe' });
    console.log(`[备份] 已压缩: ${filePath}.gz`);
  } catch (_) {}

  // 清理旧备份
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.gz'));
  const now = Date.now();
  for (const f of files) {
    const fp = path.join(BACKUP_DIR, f);
    const age = (now - fs.statSync(fp).mtimeMs) / 86400000;
    if (age > RETENTION_DAYS) {
      fs.unlinkSync(fp);
      console.log(`[备份] 清理过期: ${f}`);
    }
  }

  console.log('[备份] 完成');
  process.exit(0);
}

async function nodeDump(filePath) {
  const pool = new (require('pg').Pool)(dbConfig);
  const stream = fs.createWriteStream(filePath);
  const tables = ['rooms', 'recording_sessions', 'recordings', 'recording_files', 'upload_templates', 'upload_records'];

  for (const table of tables) {
    const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY id`);
    if (rows.length === 0) continue;
    const cols = Object.keys(rows[0]);
    const colList = cols.map((c) => `"${c}"`).join(', ');

    for (const row of rows) {
      const vals = cols.map((c) => {
        const v = row[c];
        if (v === null) return 'NULL';
        if (typeof v === 'number') return String(v);
        return `'${String(v).replace(/'/g, "''")}'`;
      });
      stream.write(`INSERT INTO "${table}" (${colList}) VALUES (${vals.join(', ')});\n`);
    }
    stream.write(`\n`);
  }
  stream.end();
  await require('util').pipeline(stream);
  pool.end();
}

backup().catch((err) => {
  console.error('[备份] 失败:', err.message);
  process.exit(1);
});
