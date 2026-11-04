/**
 * 开发环境脏数据清理脚本
 *
 * 在重启开发服务器前运行，清理孤儿进程和脏数据。
 * ⚠️ 注意：本脚本只清理开发环境相关进程，不会影响 PM2 生产环境
 *
 * 用法: npm run cleanup:dev（等价 node scripts/cleanup-dev.js）
 *
 * 清理内容：
 *   - 杀死占用端口 3001 的进程
 *   - 杀死 nodemon 和 node --watch 孤儿进程（仅限本仓库工作目录）
 *   - 杀死残留的 ffmpeg 录制进程（仅限本仓库工作目录，不影响其他项目）
 *   - dev_downloads 下的录制 / 弹幕 / HLS 文件全部删除
 *   - 清空录制、转码、弹幕、回放、上传、文件管理等业务数据表
 *
 * 保护机制：
 *   - 不会停止/删除任何 PM2 进程（生产环境由 PM2 管理）
 *   - 只操作开发相关端口和进程；ffmpeg / node --watch 会校验进程 cwd
 *   - 保留 rooms、admin_users、settings、upload_templates 等配置类表
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const env = process.env.NODE_ENV || 'development';
if (env !== 'development') {
  console.error('⚠️  错误：请在开发环境运行此脚本');
  process.exit(1);
}
require('../server/config/env').initEnv({ mode: env });

const pool = require('../server/db/index');

const REPO_ROOT = path.resolve(__dirname, '..');
const DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR || path.join(REPO_ROOT, 'dev_downloads');
const LOG_DIR = process.env.LOG_DIR || path.join(REPO_ROOT, 'logs');
const REPLAY_WORK_DIR = process.env.REPLAY_WORK_DIR || path.join(REPO_ROOT, 'dev_replay');
const DEV_PORT = process.env.PORT || '3001';

/** 读取进程 cwd（取不到时返回空串），用于把进程清理限定在本仓库内 */
function getProcessCwd(pid) {
  // Linux（容器内）优先读 /proc，macOS 走 lsof
  try {
    return path.resolve(fs.readlinkSync(`/proc/${pid}/cwd`));
  } catch (_) {}
  try {
    const out = execSync(`lsof -p ${pid} -a -d cwd -Fn 2>/dev/null`, { encoding: 'utf-8' });
    const line = out.split('\n').find((l) => l.startsWith('n'));
    return line ? path.resolve(line.slice(1)) : '';
  } catch (_) {
    return '';
  }
}

function isProjectProcess(pid) {
  const cwd = getProcessCwd(pid);
  return cwd === REPO_ROOT || cwd.startsWith(`${REPO_ROOT}${path.sep}`);
}

function killPids(pids) {
  let killed = 0;
  for (const pid of pids) {
    if (!isProjectProcess(pid)) {
      console.log(`    ↷ 跳过非本项目进程 ${pid}`);
      continue;
    }
    try {
      execSync(`kill ${pid} 2>/dev/null`, { stdio: 'ignore' });
      killed++;
    } catch (_) {}
  }
  return killed;
}

console.log('========================================');
console.log('  开发环境清理脚本');
console.log('========================================');
console.log('⚠️  注意：本脚本只清理开发环境，不会影响 生产环境');
console.log('----------------------------------------');
console.log(`DOWNLOAD_DIR: ${DOWNLOAD_DIR} | PORT: ${DEV_PORT}`);

function cleanupDir(dirPath) {
  // 清空下载目录（开发环境）
  if (fs.existsSync(dirPath)) {
    console.log(`  └─ 清空下载目录 ${dirPath} ...`);
    let fileCount = 0;
    let dirCount = 0;
    for (const f of fs.readdirSync(dirPath)) {
      const fullPath = path.join(dirPath, f);
      const stat = fs.statSync(fullPath);
      // 修改后的删除目录逻辑
      if (stat.isDirectory()) {
        try {
          // 增加 recursive 和 force 选项，并处理可能的锁定问题
          fs.rmSync(fullPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
          dirCount++;
        } catch (err) {
          console.error(`    ❌ 无法删除目录 ${fullPath}: ${err.message}`);
        }
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
    console.log(`    ⚠️  目录 ${dirPath} 不存在`);
  }
}

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
      const killed = killPids(pids);
      console.log(`    ✅ 已清理 ${killed} 个 node --watch 进程`);
    } else {
      console.log('    ✅ 无 node --watch 进程');
    }
  } catch (_) {
    console.log('    ✅ 无 node --watch 进程');
  }

  // 4. 杀死残留的 ffmpeg 录制进程（仅限本仓库）
  console.log('  └─ 清理本项目残留录制进程...');
  try {
    const ffmpegPids = execSync('pgrep -f "[f]fmpeg"', { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
    if (ffmpegPids.length === 0) {
      console.log('    ✅ 无残留录制进程');
    } else {
      const killed = killPids(ffmpegPids);
      console.log(`    ✅ 已清理 ${killed} 个录制进程`);
    }
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
  cleanupDir(DOWNLOAD_DIR);
  // 清空日志目录（开发环境）
  cleanupDir(LOG_DIR);
  // 清空 replay 工作目录
  cleanupDir(REPLAY_WORK_DIR);

  console.log('\n[4/5] 清理数据库...');

  try {
    const d = await pool.connect();
    await d.query('BEGIN');

    // 只清业务数据表：保留 rooms / admin_users / settings / upload_templates /
    // biliup_accounts / replay_settings 等配置与身份数据。
    // 顺序为「子表 → 主表」，避免外键约束；不存在的表直接跳过（兼容旧库）。
    const DATA_TABLES = [
      'replay_upload_records',
      'replay_records',
      'upload_records',
      'transcode_records',
      'danmaku_analysis_records',
      'danmaku_capture_records',
      'recording_files',
      'recording_sessions',
      'managed_files',
      'file_delete_audit_logs',
      'recordings', // 历史废弃表，仅旧库存在
    ];

    for (const table of DATA_TABLES) {
      const exists = await d.query('SELECT to_regclass($1) AS table_name', [`public.${table}`]);
      if (!exists.rows[0]?.table_name) {
        console.log(`  └─ ${table} 表不存在，跳过`);
        continue;
      }
      // 表名为脚本内常量，不来自外部输入
      const res = await d.query(`DELETE FROM ${table} RETURNING id`);
      console.log(res.rowCount > 0 ? `  └─ 清空 ${table}: ${res.rowCount} 条` : `  └─ ${table} 已为空`);
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

    // 默认不清空管理员用户了
    // // 清空管理员用户表
    // const admins = await d.query('DELETE FROM admin_users;');
    // if (admins.rowCount > 0) {
    //   console.log(`  └─ 清空管理员用户: ${admins.rowCount} 个`);
    // } else {
    //   console.log('  └─ 无需清理管理员用户');
    // }

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
  console.log('');

  process.exit(hasWarning ? 1 : 0);
}

cleanup();
