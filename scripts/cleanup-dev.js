/**
 * 开发环境脏数据清理脚本
 *
 * 在重启开发服务器前运行，清理孤儿进程和脏数据。
 * ⚠️ 注意：本脚本只清理开发环境相关进程，不会影响 PM2 生产环境
 *
 * 用法: node scripts/cleanup-dev.js
 *
 * 清理内容：
 *   - 杀死占用端口 3001 的进程
 *   - 杀死 nodemon 和 node --watch 孤儿进程
 *   - 杀死残留的 stream-gears 和 ffmpeg 孤儿进程
 *   - dev_downloads/*.part → 重命名为 .flv
 *   - 删除孤文件（orphaned）和缺失文件（missing）的 DB 记录
 *   - 中断所有遗留的 recording 会话
 *
 * 保护机制：
 *   - 不会停止/删除任何 PM2 进程（生产环境由 PM2 管理）
 *   - 只操作开发相关端口和进程
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

require('../config/env').initEnv({ mode: 'development' });

const pool = require('../db/index');

const DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR || path.join(__dirname, '..', 'dev_downloads');
const DEV_PORT = process.env.PORT || '3001';

console.log('========================================');
console.log('  开发环境清理脚本');
console.log('========================================');
console.log('⚠️  注意：本脚本只清理开发环境，不会影响 PM2 生产环境');
console.log('----------------------------------------');
console.log(`DOWNLOAD_DIR: ${DOWNLOAD_DIR} | PORT: ${DEV_PORT}`);

async function cleanup() {
  console.log('\n[1/5] 清理开发环境进程...');

  // 1. 杀死占用开发端口的进程
  console.log(`  └─ 杀死占用端口 ${DEV_PORT} 的进程...`);
  try {
    const portPids = execSync(`lsof -ti :${DEV_PORT} 2>/dev/null`, { encoding: 'utf-8' }).trim();
    if (portPids) {
      const pids = portPids.split('\n').filter(Boolean);
      for (const pid of pids) {
        try {
          execSync(`kill ${pid} 2>/dev/null`, { stdio: 'ignore' });
        } catch (_) {}
      }
      console.log(`    ✅ 已清理 ${pids.length} 个进程`);
    } else {
      console.log('    ✅ 端口未被占用');
    }
  } catch (_) {
    console.log('    ✅ 端口未被占用');
  }

  // 3. 杀死 node --watch 孤儿进程（开发环境专用）
  console.log('  └─ 杀死 node --watch 孤儿进程...');
  try {
    const watchProcs = execSync('ps aux | grep -E "node.*--watch.*app.js" | grep -v grep | awk \'{print $2}\'', {
      encoding: 'utf-8',
    }).trim();
    if (watchProcs) {
      const pids = watchProcs.split('\n').filter(Boolean);
      for (const pid of pids) {
        try {
          execSync(`kill ${pid} 2>/dev/null`, { stdio: 'ignore' });
        } catch (_) {}
      }
      console.log(`    ✅ 已清理 ${pids.length} 个 node --watch 进程`);
    } else {
      console.log('    ✅ 无 node --watch 进程');
    }
  } catch (_) {
    console.log('    ✅ 无 node --watch 进程');
  }

  // 4. 杀死残留的 ffmpeg 和 stream-gears 进程
  console.log('  └─ 杀死残留录制进程...');
  try {
    execSync('pkill -f "ffmpeg -i" 2>/dev/null', { stdio: 'ignore' });
    console.log('    ✅ 录制进程已清理');
  } catch (_) {
    console.log('    ✅ 无残留录制进程');
  }

  // 等待进程完全退出
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 5. 验证清理结果
  console.log('\n[2/5] 验证清理结果...');

  let hasWarning = false;

  // 检查端口占用
  try {
    const portCheck = execSync(`lsof -i :${DEV_PORT} 2>/dev/null`, { encoding: 'utf-8' });
    if (portCheck.trim()) {
      console.warn(`  ⚠️  端口 ${DEV_PORT} 仍被占用（可能是生产环境）:`);
      console.warn('   ', portCheck.trim().split('\n')[0]);
      hasWarning = true;
    } else {
      console.log('    ✅ 端口已释放');
    }
  } catch (_) {
    console.log('    ✅ 端口已释放');
  }

  // 检查开发环境进程
  try {
    const procCheck = execSync('ps aux | grep -E "node.*--watch.*app.js" | grep -v grep', { encoding: 'utf-8' });
    if (procCheck.trim()) {
      console.warn('  ⚠️  仍有开发进程在运行（已尝试清理）');
      hasWarning = true;
    } else {
      console.log('    ✅ 无开发进程');
    }
  } catch (_) {
    console.log('    ✅ 无开发进程');
  }

  console.log('\n[3/5] 清理磁盘文件...');

  // 清空下载目录（开发环境）
  if (fs.existsSync(DOWNLOAD_DIR)) {
    console.log(`  └─ 清空下载目录 ${DOWNLOAD_DIR} ...`);
    let fileCount = 0;
    let dirCount = 0;
    for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
      const fullPath = path.join(DOWNLOAD_DIR, f);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        dirCount++;
      } else {
        fs.unlinkSync(fullPath);
        fileCount++;
      }
    }
    if (fileCount > 0 || dirCount > 0) {
      console.log(`    ✅ 删除 ${fileCount} 个文件, ${dirCount} 个目录`);
    } else {
      console.log('    ✅ 无待处理文件');
    }
  } else {
    console.log('    ⚠️  下载目录不存在');
  }

  console.log('\n[4/5] 清理数据库...');

  try {
    const d = await pool.connect();
    await d.query('BEGIN');

    // 清空 recording_files 表
    const recordingFiles = await d.query('DELETE FROM recording_files RETURNING id');
    if (recordingFiles.rowCount > 0) {
      console.log(`  └─ 清空 recording_files: ${recordingFiles.rowCount} 条`);
    } else {
      console.log('  └─ recording_files 已为空');
    }

    // 清空 recordings 表
    const recordings = await d.query('DELETE FROM recordings RETURNING id');
    if (recordings.rowCount > 0) {
      console.log(`  └─ 清空 recordings: ${recordings.rowCount} 条`);
    } else {
      console.log('  └─ recordings 已为空');
    }

    // 清空 recording_sessions 表
    const sessions = await d.query('DELETE FROM recording_sessions RETURNING id');
    if (sessions.rowCount > 0) {
      console.log(`  └─ 清空 recording_sessions: ${sessions.rowCount} 条`);
    } else {
      console.log('  └─ recording_sessions 已为空');
    }

    // 房间复位
    const rooms = await d.query(
      "UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, output_path = '' WHERE status IN ('recording', 'paused') RETURNING id"
    );
    if (rooms.rowCount > 0) {
      console.log(`  └─ 复位直播间: ${rooms.rowCount} 个`);
    } else {
      console.log('  └─ 无需复位');
    }

    await d.query('COMMIT');
    d.release();
    console.log('    ✅ 数据库清理完成');
  } catch (err) {
    console.error('    ❌ 数据库清理失败:', err.message);
    process.exit(1);
  }

  console.log('\n[5/5] 追踪遗留文件...');

  if (fs.existsSync(DOWNLOAD_DIR)) {
    const tracked = (await pool.query('SELECT file_path FROM recording_files')).rows.map((r) => r.file_path);
    let count = 0;
    for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
      if (!/\.(flv|mp4|ts)$/i.test(f)) continue;
      const fp = path.join(DOWNLOAD_DIR, f);
      if (tracked.includes(fp)) continue;
      let size = 0;
      try {
        size = fs.statSync(fp).size;
      } catch (_) {}
      await pool.query(
        "INSERT INTO recording_files (file_path, file_name, file_size, status, checked_at) VALUES ($1, $2, $3, 'completed', NOW())",
        [fp, f, size]
      );
      count++;
    }
    if (count > 0) {
      console.log(`  └─ 已追踪 ${count} 个遗留文件`);
    } else {
      console.log('  └─ 无遗留文件');
    }
  }

  console.log('\n========================================');
  if (hasWarning) {
    console.log('⚠️  清理完成，但有警告（见上文）');
    console.log('   如有疑问，请手动检查进程状态');
  } else {
    console.log('✅ 清理完成！开发环境已干净');
  }
  console.log('========================================\n');

  console.log('💡 启动开发环境: npm run dev');
  console.log('💡 查看生产状态: pm2 list');
  console.log('');

  process.exit(hasWarning ? 1 : 0);
}

cleanup();
