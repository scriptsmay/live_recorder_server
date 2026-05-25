require('../config/env').initEnv({ mode: 'development' });
const pool = require('../db/index');
const fs = require('fs');
const path = require('path');

async function fixHLS() {
  try {
    console.log('=== HLS 修复脚本开始 ===');
    console.log('');

    // 1. 重置数据库中的 HLS 状态
    console.log('步骤 1: 重置数据库中的 HLS 状态');
    await pool.query(`
      UPDATE recordings
      SET is_hls_ready = FALSE,
          hls_playlist_path = NULL,
          hls_generated_at = NULL
    `);
    console.log('   已重置 recordings 表中的 HLS 状态');

    await pool.query(`
      UPDATE recording_files
      SET is_hls_ready = FALSE,
          hls_playlist_path = NULL,
          hls_generated_at = NULL
    `);
    console.log('   已重置 recording_files 表中的 HLS 状态');
    console.log('');

    // 2. 查找并删除旧的 HLS 目录
    console.log('步骤 2: 查找并删除旧的 HLS 目录');
    const VIDEO_DOWNLOAD_DIR = path.resolve(process.env.VIDEO_DOWNLOAD_DIR || '.');

    let deletedDirs = 0;

    function cleanHLS(directory) {
      if (!fs.existsSync(directory)) return;

      const entries = fs.readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
          if (entry.name === 'hls' || entry.name.startsWith('hls_')) {
            try {
              fs.rmSync(entryPath, { recursive: true, force: true });
              deletedDirs++;
              console.log(`   已删除: ${path.relative(VIDEO_DOWNLOAD_DIR, entryPath)}`);
            } catch (err) {
              console.error(`   删除失败: ${entryPath}`, err);
            }
          } else {
            cleanHLS(entryPath);
          }
        }
      }
    }

    cleanHLS(VIDEO_DOWNLOAD_DIR);
    console.log(`   共删除了 ${deletedDirs} 个 HLS 目录`);
    console.log('');

    // 3. 验证结果
    console.log('步骤 3: 验证结果');
    const { rows: recordings } = await pool.query('SELECT COUNT(*) FROM recordings WHERE is_hls_ready = TRUE');
    const { rows: rf } = await pool.query('SELECT COUNT(*) FROM recording_files WHERE is_hls_ready = TRUE');
    console.log(`   recordings 表中还有 ${recordings[0].count} 个 HLS 就绪的记录`);
    console.log(`   recording_files 表中还有 ${rf[0].count} 个 HLS 就绪的记录`);
    console.log('');

    console.log('=== HLS 修复完成 ===');
    console.log('');
    console.log('提示: 现在可以重启服务，看门狗会自动为所有文件重新生成 HLS');
    console.log('      或者你也可以通过以下方式手动触发 HLS 生成:');
    console.log('      1. 在前端播放界面点击播放按钮');
    console.log('      2. 调用 API: POST /api/recordings/{id}/generate-hls');

  } catch (err) {
    console.error('HLS 修复失败:', err);
  } finally {
    await pool.end();
  }
}

fixHLS().catch(console.error);