require('../config/env').initEnv();

const ensureDatabase = require('../db/ensure-database');
const migrate = require('../db/migrate');

async function main() {
  const created = await ensureDatabase();
  if (created) {
    console.log('[db:ensure] 数据库已创建，开始迁移…');
  } else {
    console.log('[db:ensure] 数据库已存在');
  }
  await migrate();
  console.log('[db:ensure] 完成');
}

main().catch((err) => {
  console.error('[db:ensure] 失败:', err.message);
  process.exit(1);
});
