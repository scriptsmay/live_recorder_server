const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ReplayService = require('../../../services/ReplayService');
const { sanitizeFilename } = require('../../utils/tool');

function ensureInside(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  if (!target.startsWith(base + path.sep) && target !== base) {
    throw new Error(`非法输出路径: ${targetPath}`);
  }
  return target;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let output = '';
    proc.stdout.on('data', (d) => {
      output += d.toString();
    });
    proc.stderr.on('data', (d) => {
      output += d.toString();
    });
    proc.on('error', (err) => resolve({ success: false, error: err.message, output }));
    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        code,
        output,
        error: code === 0 ? '' : `${command} exit code ${code}`,
      });
    });
  });
}

async function extract(record) {
  if (record.m3u8_url) return { success: true, m3u8Url: record.m3u8_url };
  if (!record.replay_id && !record.play_url) {
    return { success: false, error: '缺少 replay_id 和 play_url，无法提取 m3u8' };
  }
  try {
    const { extractM3u8 } = require('./KuaishouReplayClient');
    return await extractM3u8(record);
  } catch (err) {
    return { success: false, error: `m3u8 提取失败: ${err.message}` };
  }
}

async function download(record) {
  if (!record.m3u8_url) return { success: false, error: '缺少 m3u8_url，无法下载' };
  const workDir = ReplayService.getRecordWorkDir(record);
  const basename =
    sanitizeFilename(record.video_file_name || record.replay_id || `replay_${record.id}`) || `replay_${record.id}`;
  const outputPath = ensureInside(workDir, path.join(workDir, `${basename}.mp4`));
  const referer = record.play_url
    ? `https://live.kuaishou.com/playback/${record.replay_id || ''}`
    : 'https://live.kuaishou.com';
  const result = await runCommand(
    'yt-dlp',
    ['-o', outputPath, '--referer', referer, '--no-progress', '--no-warnings', record.m3u8_url],
    {
      cwd: workDir,
    }
  );
  if (!result.success) return result;
  // yt-dlp 可能输出不同扩展名，优先查找 .mp4，其次扫描目录
  let finalPath = outputPath;
  if (!fs.existsSync(finalPath)) {
    const candidates = fs
      .readdirSync(workDir)
      .filter((n) => n.startsWith(basename) && /\.(mp4|mkv|ts)$/i.test(n))
      .map((n) => path.join(workDir, n));
    if (candidates.length === 0) return { success: false, error: 'yt-dlp 下载完成但未找到输出文件' };
    finalPath = ensureInside(workDir, candidates[0]);
  }
  const stat = fs.statSync(finalPath);
  return { success: true, rawFilePath: finalPath, fileSize: stat.size, output: result.output };
}

async function cut(record) {
  const rawPath = record.raw_file_path;
  if (!rawPath || !fs.existsSync(rawPath)) return { success: false, error: '原始下载文件不存在' };
  const workDir = ReplayService.getRecordWorkDir(record);
  const outputPattern = ensureInside(
    workDir,
    path.join(workDir, `${path.basename(rawPath, path.extname(rawPath))}_part.mkv`)
  );

  const result = await runCommand('mkvmerge', ['-o', outputPattern, '--split', 'duration:00:59:00', rawPath], {
    cwd: workDir,
  });
  if (!result.success) {
    const fallback = await runCommand(
      'ffmpeg',
      [
        '-y',
        '-i',
        rawPath,
        '-c',
        'copy',
        '-f',
        'segment',
        '-segment_time',
        '3540',
        path.join(workDir, 'part_%03d.mp4'),
      ],
      { cwd: workDir }
    );
    if (!fallback.success) return fallback;
  }
  const files = fs
    .readdirSync(workDir)
    .filter((name) => /(_part-\d+\.mkv|part_\d+\.mp4|_part\.mkv)$/i.test(name))
    .map((name) => ensureInside(workDir, path.join(workDir, name)));
  return { success: true, cutFilePaths: files.length ? files : [outputPattern] };
}

/**
 * 修复录制产物的视频分辨率，将所有切割文件统一调整为 1920x1080。
 *
 * @param {Object} record - 录制记录对象
 * @param {string} record.cut_file_paths - JSON 格式的切割文件路径数组字符串
 * @returns {Promise<Object>} 处理结果
 *   - success {boolean} - 是否成功
 *   - error {string} - 失败时的错误信息
 *   - fixedFilePaths {string[]} - 修复后的文件路径列表（成功时返回）
 *   - finalFilePaths {string[]} - 最终文件路径列表（成功时返回，与 fixedFilePaths 相同）
 */
async function fix(record) {
  // 解析切割产物路径，解析失败时直接返回错误
  let files;
  try {
    files = JSON.parse(record.cut_file_paths || '[]');
  } catch (_) {
    return { success: false, error: 'cut_file_paths 字段 JSON 解析失败' };
  }
  if (!Array.isArray(files) || files.length === 0) {
    return { success: false, error: '缺少切割产物，无法修复分辨率' };
  }
  const workDir = ReplayService.getRecordWorkDir(record);
  const fixed = [];
  // 逐个处理切割文件：通过 ffmpeg 缩放并填充至 1920x1080，音频流直接拷贝
  for (const file of files) {
    const output = ensureInside(workDir, path.join(workDir, `${path.basename(file, path.extname(file))}_fixed.mp4`));
    const result = await runCommand(
      'ffmpeg',
      [
        '-y',
        '-i',
        file,
        '-vf',
        'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
        '-c:a',
        'copy',
        output,
      ],
      { cwd: workDir }
    );
    if (!result.success) return result;
    fixed.push(output);
  }
  return { success: true, fixedFilePaths: fixed, finalFilePaths: fixed };
}

module.exports = {
  extract,
  download,
  cut,
  fix,
  runCommand,
  ensureInside,
};
