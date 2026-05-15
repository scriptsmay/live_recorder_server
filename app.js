// ──────────────────────────────────────────────
// 1. 依赖
// ──────────────────────────────────────────────
require('dotenv').config({ path: '.env.dev', quiet: true });
require('dotenv').config({ quiet: true });
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const ejsLayouts = require('express-ejs-layouts');

const migrate = require('./db/migrate');
const pool = require('./db/index');
const redis = require('./db/redis');

const htmlRouter = require('./router/html');
const {
  router: apiRouter,
  generateFilename,
  templateToStrftime,
  setActiveTask,
  delActiveTask,
  delRoomCache,
  activeTaskKey,
} = require('./router/api');
const roomsRouter = require('./router/rooms');
const { router: uploadRouter } = require('./router/upload');
const settingsRouter = require('./router/settings');
const { createProcLog } = require('./lib/proc-log');
const { scanRecordingFiles } = require('./lib/scan-files');
const { getActiveDownloader } = require('./lib/downloaders/DownloaderFactory');

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
app.use('/api', uploadRouter);
app.use('/api', settingsRouter);

// ──────────────────────────────────────────────
// 4. 启动前清理与恢复
// ──────────────────────────────────────────────
const MAX_RESUME_RETRIES = 3;

async function getSetting(key, def) {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (r.rows.length) return r.rows[0].value;
  } catch (_) {}
  return def;
}

async function tryResumeSession(session) {
  const DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR;
  if (!DOWNLOAD_DIR) throw new Error('VIDEO_DOWNLOAD_DIR 未设置');

  let downloader;
  try {
    downloader = await getActiveDownloader();
  } catch (_) {
    const FFmpegDownloader = require('./lib/downloaders/FFmpegDownloader');
    downloader = new FFmpegDownloader();
  }

  const segmentDuration = session.segment_duration || 0;
  const useSegment = segmentDuration > 0;
  const template = session.filename_template || '{room_name}_{datetime}';
  const retryCount = session.retry_count || 0;
  const ext = downloader.getExtension();

  let outputPath;
  if (useSegment) {
    const strftimeName = templateToStrftime(template, session.room_name || '', ext);
    outputPath = path.join(DOWNLOAD_DIR, strftimeName);
  } else {
    const base = generateFilename(template, session.room_name || '', ext);
    const parsed = path.parse(base);
    outputPath = path.join(DOWNLOAD_DIR, `${parsed.name}_resume_${retryCount + 1}${parsed.ext}`);
  }

  const streamUrl = session.stream_url || session.room_url;

  const dlArgs = downloader.buildArgs(streamUrl, outputPath, { segmentDuration });

  const { fd: logFd, logPath: ffmpegLogPath, logCommand } = createProcLog(downloader.name, session.id);
  logCommand(downloader.name, dlArgs);

  const ffmpeg = downloader.spawn(dlArgs, logFd);

  let sessionFinalized = false;

  ffmpeg.on('close', async (code) => {
    if (sessionFinalized) return;
    sessionFinalized = true;

    await delActiveTask(activeTaskKey(session.room_url));
    console.log(`[恢复] 会话 ${session.id} ffmpeg 退出 (code=${code}), 文件: ${outputPath} (日志: ${ffmpegLogPath})`);

    try {
      await pool.query(`UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`, [
        session.room_id,
      ]);
      await delRoomCache(session.room_url);

      const status = code === 0 ? 'completed' : 'interrupted';

      if (useSegment) {
        await pool.query(`UPDATE recording_sessions SET ended_at = NOW(), status = $1 WHERE id = $2`, [
          status,
          session.id,
        ]);
      } else {
        let fileSize = 0;
        try {
          const stat = fs.statSync(outputPath);
          fileSize = stat.size;
        } catch (_) {}

        await pool.query(
          `INSERT INTO recordings (session_id, segment_index, room_url, file_path, file_size, started_at, ended_at, status)
           VALUES ($1, 0, $2, $3, $4, $5, NOW(), 'completed')`,
          [session.id, session.room_url, outputPath, fileSize, session.started_at]
        );

        await pool.query(
          `UPDATE recording_sessions SET ended_at = NOW(), status = $1, total_segments = 1, total_size = $2 WHERE id = $3`,
          [status, fileSize, session.id]
        );
      }
    } catch (dbErr) {
      console.error(`[恢复] 会话 ${session.id} 结束处理失败:`, dbErr.message);
    }
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), 2000);
    ffmpeg.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ffmpeg.on('close', (code) => {
      clearTimeout(timer);
      if (code !== null && code !== 0) reject(new Error(`ffmpeg exited with code ${code}`));
      else resolve();
    });
  });

  try {
    process.kill(ffmpeg.pid, 0);
  } catch (_) {
    throw new Error('ffmpeg exited during initialization');
  }

  await pool.query(
    `UPDATE rooms SET status = 'recording', output_path = $1, ffmpeg_pid = $2, updated_at = NOW() WHERE id = $3`,
    [outputPath, ffmpeg.pid, session.room_id]
  );
  await delRoomCache(session.room_url);

  await setActiveTask(activeTaskKey(session.room_url), {
    pid: ffmpeg.pid,
    outputPath,
    roomId: session.room_id,
    sessionId: session.id,
    startTime: Date.now(),
  });

  await pool.query(`UPDATE recording_sessions SET retry_count = $1 WHERE id = $2`, [(retryCount || 0) + 1, session.id]);

  console.log(`[恢复] 会话 ${session.id} ffmpeg 已启动 (PID: ${ffmpeg.pid}), 输出: ${outputPath}`);
}

async function cleanupStaleRecordings() {
  try {
    // 清理上一轮可能的孤儿 ffmpeg 进程（避免 PM2 watch 重启导致状态不同步）
    try {
      execSync('pkill -f "ffmpeg -i" 2>/dev/null; pkill -f "ffmpeg.*-segment_time" 2>/dev/null', { stdio: 'ignore' });
    } catch (_) {}

    const staleRooms = await pool.query(
      `SELECT id, room_url, room_name, ffmpeg_pid FROM rooms WHERE status IN ('recording', 'paused')`
    );
    for (const row of staleRooms.rows) {
      if (row.ffmpeg_pid) {
        try {
          process.kill(row.ffmpeg_pid, 'SIGTERM');
        } catch (_) {}
      }
      console.log(`[清理] 直播间 ${row.room_name || row.room_url} (ID:${row.id}) 状态已重置为 idle`);
    }
    const kpids = staleRooms.rows.map((r) => r.ffmpeg_pid).filter(Boolean);
    if (kpids.length > 0) {
      setTimeout(() => {
        for (const pid of kpids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (_) {}
        }
      }, 3000);
    }
    // 清理 stream-gears 残留的 .flv.part 文件
    for (const row of staleRooms.rows) {
      try {
        if (!row.output_path) continue;
        const dir = path.dirname(row.output_path);
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (!f.endsWith('.flv.part')) continue;
          const finalPath = path.join(dir, f.replace(/\.part$/, ''));
          try {
            fs.renameSync(path.join(dir, f), finalPath);
            console.log(`[清理] .part 已恢复: ${finalPath}`);
          } catch (_) {}
        }

        // 将 untracked .flv/.mp4 写入 recording_files
        for (const f of fs.readdirSync(dir)) {
          if (!/\.(mp4|flv)$/i.test(f)) continue;
          const fp = path.join(dir, f);
          const exists = await pool.query('SELECT id FROM recording_files WHERE file_path = $1', [fp]);
          if (exists.rows.length > 0) continue;
          let size = 0;
          try { size = fs.statSync(fp).size; } catch (_) {}
          await pool.query(
            `INSERT INTO recording_files (file_path, file_name, file_size, status, checked_at)
             VALUES ($1, $2, $3, 'completed', NOW())`,
            [fp, f, size]
          );
          console.log(`[清理] 孤文件已追踪: ${f} (${size} bytes)`);
        }
      } catch (_) {}
    }

    await pool.query(
      `UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, output_path = '', updated_at = NOW()
       WHERE status IN ('recording', 'paused')`
    );

    const sessions = await pool.query(
      `SELECT rs.*, r.id AS room_id, r.room_name, r.filename_template, r.segment_duration
       FROM recording_sessions rs
       JOIN rooms r ON rs.room_url = r.room_url
       WHERE rs.status = 'recording'`
    );

    for (const session of sessions.rows) {
      const retryCount = session.retry_count || 0;
      if (retryCount >= MAX_RESUME_RETRIES) {
        console.log(`[清理] 会话 ${session.id} 已达最大重试次数(${MAX_RESUME_RETRIES})，标记为中断`);
        await pool.query(`UPDATE recording_sessions SET ended_at = NOW(), status = 'interrupted' WHERE id = $1`, [
          session.id,
        ]);
        continue;
      }

      console.log(`[恢复] 尝试恢复会话 ${session.id} (第 ${retryCount + 1}/${MAX_RESUME_RETRIES} 次)`);
      try {
        await tryResumeSession(session);
        console.log(`[恢复] 会话 ${session.id} 恢复成功`);
      } catch (err) {
        console.error(`[恢复] 会话 ${session.id} 恢复失败:`, err.message);
        const check = await pool.query(`SELECT status FROM recording_sessions WHERE id = $1`, [session.id]);
        if (check.rows.length > 0 && check.rows[0].status !== 'recording') {
          continue;
        }
        const newCount = retryCount + 1;
        if (newCount >= MAX_RESUME_RETRIES) {
          await pool.query(
            `UPDATE recording_sessions SET retry_count = $1, ended_at = NOW(), status = 'interrupted' WHERE id = $2`,
            [newCount, session.id]
          );
        } else {
          await pool.query(`UPDATE recording_sessions SET retry_count = $1 WHERE id = $2`, [newCount, session.id]);
        }
      }
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

    // 清理 recording_files 中残留在 recording 状态的行
    const fileResult = await pool.query(
      `UPDATE recording_files SET status = 'interrupted', checked_at = NOW()
       WHERE status = 'recording'
       RETURNING id, file_path`
    );
    for (const row of fileResult.rows) {
      let size = 0;
      try {
        const s = fs.statSync(row.file_path);
        size = s.size;
      } catch (_) {}
      if (size > 0) {
        await pool.query('UPDATE recording_files SET file_size = $1 WHERE id = $2', [size, row.id]);
      }
    }
    if (fileResult.rows.length > 0) {
      console.log(`[清理] ${fileResult.rows.length} 条文件记录已标为中断`);
    }
  } catch (err) {
    console.error('[清理] 启动时清理失败:', err.message);
  }
}

async function cleanupStaleRedis() {
  try {
    await redis.connect();
    const keys = await redis.keys('active_task:*');
    let deleted = 0;
    for (const key of keys) {
      const roomKey = key.replace('active_task:', '');
      const room = await pool.query('SELECT status FROM rooms WHERE room_url = $1', [roomKey]);
      if (room.rows.length === 0 || room.rows[0].status !== 'recording') {
        await redis.del(key);
        deleted++;
      }
    }
    if (deleted > 0) {
      console.log(`[清理] Redis 中 ${deleted} 条过期录制任务已清理`);
    }
  } catch (err) {
    if (err.message && err.message.includes('in progress')) return;
    console.error('[清理] Redis 清理失败:', err.message);
  }
}

async function runFileScan() {
  try {
    const r = await scanRecordingFiles(true);
    if (r.missing > 0 || r.orphaned > 0) {
      console.log(`[文件扫描] 完成: ${r.missing} 缺失, ${r.orphaned} 孤⽂件`);
    }
  } catch (err) {
    console.error('[文件扫描] 失败:', err.message);
  }
}

async function checkStaleRecordings() {
  try {
    const STALE_FILE_TIMEOUT_MS = parseInt(await getSetting('watchdog_timeout', '60'), 10) * 1000;
    const { rows: rooms } = await pool.query(
      `SELECT r.id, r.room_url, r.room_name, r.ffmpeg_pid, r.output_path, r.segment_duration,
              rs.id AS session_id
       FROM rooms r
       LEFT JOIN recording_sessions rs ON rs.room_url = r.room_url AND rs.status = 'recording'
       WHERE r.status = 'recording'`
    );

    for (const room of rooms) {
      let processAlive = false;
      if (room.ffmpeg_pid) {
        try {
          process.kill(room.ffmpeg_pid, 0);
          processAlive = true;
        } catch (_) {}
      }

      let fileStale = false;
      if (room.output_path) {
        const outputDir = path.dirname(room.output_path);
        const isSegmented = (room.segment_duration || 0) > 0;

        if (isSegmented) {
          let latestMtime = 0;
          try {
            const files = fs.readdirSync(outputDir);
            for (const f of files) {
              if (!f.endsWith('.mp4') && !f.endsWith('.flv') && !f.startsWith('.segments_')) continue;
              const stat = fs.statSync(path.join(outputDir, f));
              if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
            }
          } catch (_) {}
          if (latestMtime > 0 && Date.now() - latestMtime > STALE_FILE_TIMEOUT_MS) {
            fileStale = true;
          }
        } else {
          try {
            const stat = fs.statSync(room.output_path);
            if (stat.isFile() && Date.now() - stat.mtimeMs > STALE_FILE_TIMEOUT_MS) {
              fileStale = true;
            }
          } catch (_) {}
        }
      }

      if (!processAlive || fileStale) {
        console.log(
          `[看门狗] 僵死录制: ${room.room_name || room.room_url} (pid=${room.ffmpeg_pid}, 进程=${processAlive}, 文件过时=${fileStale})`
        );

        if (processAlive && room.ffmpeg_pid) {
          try {
            process.kill(room.ffmpeg_pid, 'SIGTERM');
          } catch (_) {}
          setTimeout(() => {
            try {
              process.kill(room.ffmpeg_pid, 'SIGKILL');
            } catch (_) {}
          }, 5000);
        }

        await pool.query(`UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`, [
          room.id,
        ]);
        await delRoomCache(room.room_url);

        if (room.session_id) {
          let fileSize = 0;
          if (room.output_path) {
            try {
              const stat = fs.statSync(room.output_path);
              fileSize = stat.size;
            } catch (_) {}
          }
          await pool.query(
            `UPDATE recording_sessions SET ended_at = NOW(), status = 'interrupted', total_size = $1 WHERE id = $2`,
            [fileSize, room.session_id]
          );
          await pool.query(
            `UPDATE recording_files SET status = 'interrupted', checked_at = NOW()
             WHERE session_id = $1 AND status = 'recording'`,
            [room.session_id]
          );
        }
        console.log(`[看门狗] 清理完成: ${room.room_name || room.room_url}`);
      }
    }
  } catch (err) {
    console.error('[看门狗] 检查失败:', err.message);
  }
}

// ──────────────────────────────────────────────
// 5. 启动
// ──────────────────────────────────────────────
async function startup() {
  await migrate();
  await cleanupStaleRecordings();
  await cleanupStaleRedis();
  await runFileScan();
}

async function scheduleWatchdog() {
  const intervalSec = parseInt(await getSetting('watchdog_interval', '30'), 10);
  await checkStaleRecordings();
  setTimeout(scheduleWatchdog, Math.max(intervalSec, 10) * 1000);
}

startup()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
    });
    scheduleWatchdog();
  })
  .catch((err) => {
    console.error('[启动失败] 数据库迁移出错:', err);
    process.exit(1);
  });
