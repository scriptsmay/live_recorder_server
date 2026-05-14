// ──────────────────────────────────────────────
// 1. 依赖
// ──────────────────────────────────────────────
require('dotenv').config({ quiet: true });
const path = require('path');
const fs = require('fs');

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const ejsLayouts = require('express-ejs-layouts');

const migrate = require('./db/migrate');
const pool = require('./db/index');
const redis = require('./db/redis');

const htmlRouter = require('./router/html');
const apiRouter = require('./router/api');
const roomsRouter = require('./router/rooms');

// ──────────────────────────────────────────────
// 2. Express 配置
// ──────────────────────────────────────────────
const app = express();
const port = process.env.PORT || 3000;

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(ejsLayouts);

if (process.env.NODE_ENV === 'development') {
  app.set('view cache', false);
  app.disable('view cache');
}

app.use(express.static('public'));

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(morgan('dev'));

app.use((req, res, next) => {
  res.locals.path = req.path;
  res.locals.title = 'Live Recorder Server';
  next();
});

// ──────────────────────────────────────────────
// 3. 路由
// ──────────────────────────────────────────────
app.use('/', htmlRouter);
app.use('/api', apiRouter);
app.use('/api', roomsRouter);

// ──────────────────────────────────────────────
// 4. 启动前清理
// ──────────────────────────────────────────────
async function cleanupStaleRecordings() {
  try {
    const result = await pool.query(
      `UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW()
       WHERE status IN ('recording', 'paused')
       RETURNING id, room_url, room_name`
    );
    for (const row of result.rows) {
      console.log(`[清理] 直播间 ${row.room_name || row.room_url} (ID:${row.id}) 状态已重置为 idle`);
    }
    const recResult = await pool.query(
      `UPDATE recordings SET ended_at = NOW(), status = 'interrupted'
       WHERE status = 'recording'
       RETURNING id, file_path`
    );
    for (const row of recResult.rows) {
      let fileSize = 0;
      if (row.file_path) {
        try {
          const stat = fs.statSync(row.file_path);
          fileSize = stat.size;
        } catch (_) {}
      }
      if (fileSize > 0) {
        await pool.query('UPDATE recordings SET file_size = $1 WHERE id = $2', [fileSize, row.id]);
      }
    }
    if (recResult.rows.length > 0) {
      console.log(`[清理] ${recResult.rows.length} 条录制记录已标为中断`);
    }
  } catch (err) {
    console.error('[清理] 启动时清理失败:', err.message);
  }
}

async function cleanupStaleRedis() {
  try {
    await redis.connect();
    const keys = await redis.keys('active_task:*');
    if (keys.length > 0) {
      await redis.del(keys);
      console.log(`[清理] Redis 中 ${keys.length} 条过期录制任务已清理`);
    }
  } catch (err) {
    if (err.message && err.message.includes('in progress')) return;
    console.error('[清理] Redis 清理失败:', err.message);
  }
}

// ──────────────────────────────────────────────
// 5. 启动
// ──────────────────────────────────────────────
async function startup() {
  await migrate();
  await cleanupStaleRecordings();
  await cleanupStaleRedis();
}

startup()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
    });
  })
  .catch((err) => {
    console.error('[启动失败] 数据库迁移出错:', err);
    process.exit(1);
  });
