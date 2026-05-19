const path = require('path');
const fs = require('fs');
const pool = require('../db/index');
const transcoder = require('../lib/core/transcoder');

async function findUntranscodedFlv(downloadDir) {
  const flvFiles = [];
  const mp4Files = new Set();

  try {
    const files = fs.readdirSync(downloadDir);
    for (const file of files) {
      if (file.endsWith('.flv')) {
        flvFiles.push(path.join(downloadDir, file));
      } else if (file.endsWith('.mp4')) {
        mp4Files.add(file.replace('.mp4', '.flv').toLowerCase());
      }
    }
  } catch (err) {
    console.error('读取目录失败:', err.message);
    return [];
  }

  const untranscoded = [];
  for (const flvPath of flvFiles) {
    const baseName = path.basename(flvPath).toLowerCase();
    if (!mp4Files.has(baseName)) {
      untranscoded.push(flvPath);
    }
  }

  return untranscoded;
}

async function updateDbRecords(flvPath, mp4Path, mp4Size) {
  const mp4FileName = path.basename(mp4Path);

  try {
    await pool.query(
      `UPDATE recording_files SET file_path = $1, file_name = $2, file_size = $3 WHERE file_path = $4`,
      [mp4Path, mp4FileName, mp4Size, flvPath]
    );
    await pool.query(`UPDATE recordings SET file_path = $1, file_size = $2 WHERE file_path = $3`, [
      mp4Path,
      mp4Size,
      flvPath,
    ]);
    console.log(`  数据库记录已更新`);
  } catch (err) {
    console.error(`  数据库更新失败:`, err.message);
  }
}

function parseArgs() {
  const options = {
    dryRun: false,
    deleteOriginal: false,
    updateDb: false,
    downloadDir: process.env.VIDEO_DOWNLOAD_DIR || './dev_downloads',
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--delete') {
      options.deleteOriginal = true;
    } else if (arg === '--update-db') {
      options.updateDb = true;
    } else if (arg.startsWith('--dir=')) {
      options.downloadDir = arg.slice(6);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
用法: node transcode-missed.js [选项]

选项:
  --dry-run       只显示待处理文件，不实际转码
  --delete        转码成功后删除原始 FLV 文件
  --update-db     更新数据库中的文件记录
  --dir=<path>    指定下载目录 (默认: VIDEO_DOWNLOAD_DIR 或 ./dev_downloads)
  --help, -h      显示帮助信息

示例:
  node transcode-missed.js --dry-run                    # 预览待处理文件
  node transcode-missed.js --delete --update-db          # 转码并清理
  node transcode-missed.js --dir=/path/to/videos         # 指定其他目录
`);
      process.exit(0);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();

  console.log('=== FLV 补转码脚本 ===\n');
  console.log('选项:', {
    'dry-run': options.dryRun,
    delete: options.deleteOriginal,
    'update-db': options.updateDb,
  });
  console.log('下载目录:', options.downloadDir);
  console.log('');

  const untranscoded = await findUntranscodedFlv(options.downloadDir);

  if (untranscoded.length === 0) {
    console.log('没有发现未转码的 FLV 文件');
    return;
  }

  console.log(`发现 ${untranscoded.length} 个未转码的 FLV 文件:\n`);
  for (const f of untranscoded) {
    const stat = fs.statSync(f);
    console.log(`  - ${path.basename(f)} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
  }
  console.log('');

  if (options.dryRun) {
    console.log('[dry-run] 跳过实际转码');
    return;
  }

  let success = 0;
  let failed = 0;

  for (const flvPath of untranscoded) {
    const mp4Path = flvPath.replace(/\.flv$/i, '.mp4');
    console.log(`\n转码中: ${path.basename(flvPath)}`);

    try {
      const result = await transcoder.fastTranscode(flvPath, mp4Path);

      if (result.success) {
        console.log(`  ✓ 转码成功 (${(result.outputSize / 1024 / 1024).toFixed(1)}MB)`);
        success++;

        if (options.updateDb) {
          await updateDbRecords(flvPath, mp4Path, result.outputSize);
        }

        if (options.deleteOriginal) {
          try {
            fs.unlinkSync(flvPath);
            console.log(`  ✓ 已删除原始文件`);
          } catch (err) {
            console.error(`  删除失败:`, err.message);
          }
        }
      } else {
        console.error(`  ✗ 转码失败:`, result.error);
        failed++;
      }
    } catch (err) {
      console.error(`  ✗ 异常:`, err.message);
      failed++;
    }
  }

  console.log(`\n=== 完成: ${success} 成功, ${failed} 失败 ===`);
}

main().catch((err) => {
  console.error('脚本执行失败:', err);
  process.exit(1);
});
