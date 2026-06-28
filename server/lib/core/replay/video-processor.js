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
    const logStream = options.logStream;
    const onProcessStart = options.onProcessStart;
    const onProcessEnd = options.onProcessEnd;
    const spawnOptions = { ...options };
    delete spawnOptions.logStream;
    delete spawnOptions.onProcessStart;
    delete spawnOptions.onProcessEnd;
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions,
    });
    let output = '';
    logStream?.write(`# COMMAND: ${command} ${args.join(' ')}\n`);
    onProcessStart?.(proc, command, args);
    proc.stdout.on('data', (d) => {
      const text = d.toString();
      output += text;
      logStream?.write(text);
    });
    proc.stderr.on('data', (d) => {
      const text = d.toString();
      output += text;
      logStream?.write(text);
    });
    proc.on('error', (err) => {
      logStream?.write(`\n# ERROR: ${err.message}\n`);
      resolve({ success: false, error: err.message, output });
    });
    proc.on('close', (code) => {
      logStream?.write(`\n# EXIT: ${code}\n`);
      onProcessEnd?.(proc, command, args);
      resolve({
        success: code === 0,
        code,
        output,
        error: code === 0 ? '' : code === null ? `${command} terminated` : `${command} exit code ${code}`,
      });
    });
  });
}

async function extract(record, options = {}) {
  if (record.m3u8_url && !options.force) return { success: true, m3u8Url: record.m3u8_url };
  if (!record.replay_id && !record.play_url) {
    return { success: false, error: '缺少 replay_id 和 play_url，无法提取 m3u8' };
  }
  try {
    const { extractM3u8 } = require('./KuaishouReplayClient');
    return await extractM3u8(record, { logStream: options.logStream, force: options.force });
  } catch (err) {
    return { success: false, error: `m3u8 提取失败: ${err.message}` };
  }
}

async function download(record, options = {}) {
  if (!record.m3u8_url) return { success: false, error: '缺少 m3u8_url，无法下载' };
  const workDir = ReplayService.getRecordWorkDir(record);
  const basename =
    sanitizeFilename(record.video_file_name || record.replay_id || `replay_${record.id}`) || `replay_${record.id}`;
  const outputPath = ensureInside(workDir, path.join(workDir, `${basename}.ts`));
  const referer = record.play_url
    ? `https://live.kuaishou.com/playback/${record.replay_id || ''}`
    : 'https://live.kuaishou.com';
  const args = ['-o', outputPath, '--referer', referer, '--no-progress', '--no-warnings'];
  const tempDir = process.env.YTDLP_TEMP_DIR;
  if (tempDir) {
    fs.mkdirSync(tempDir, { recursive: true });
    args.push('--paths', `temp:${tempDir}`);
  }
  if (options.force) args.push('--force-overwrites');
  args.push(record.m3u8_url);
  const result = await runCommand('yt-dlp', args, {
    cwd: workDir,
    logStream: options.logStream,
    onProcessStart: options.onProcessStart,
    onProcessEnd: options.onProcessEnd,
  });
  if (!result.success) return result;
  // yt-dlp 可能输出不同扩展名，优先查找 .ts，其次扫描目录
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

async function cut(record, options = {}) {
  const rawPath = record.raw_file_path;
  if (!rawPath || !fs.existsSync(rawPath)) return { success: false, error: '原始下载文件不存在' };
  const workDir = ReplayService.getRecordWorkDir(record);
  const base = path.basename(rawPath, path.extname(rawPath));
  const videoSubDir = ensureInside(workDir, path.join(workDir, base));
  if (!fs.existsSync(videoSubDir)) {
    fs.mkdirSync(videoSubDir, { recursive: true });
  }

  const outputPath = ensureInside(videoSubDir, path.join(videoSubDir, 'p.mkv'));
  const result = await runCommand('mkvmerge', ['-o', outputPath, '--split', 'duration:01:00:00', rawPath], {
    cwd: workDir,
    logStream: options.logStream,
    onProcessStart: options.onProcessStart,
    onProcessEnd: options.onProcessEnd,
  });
  if (!result.success) {
    const fallbackPattern = ensureInside(videoSubDir, path.join(videoSubDir, 'p%02d.ts'));
    const fallback = await runCommand(
      'ffmpeg',
      [
        '-y',
        '-i',
        rawPath,
        '-c',
        'copy',
        '-map',
        '0',
        '-f',
        'segment',
        '-segment_time',
        '3600',
        '-segment_start_number',
        '1',
        '-reset_timestamps',
        '1',
        fallbackPattern,
      ],
      {
        cwd: workDir,
        logStream: options.logStream,
        onProcessStart: options.onProcessStart,
        onProcessEnd: options.onProcessEnd,
      }
    );
    if (!fallback.success) return fallback;
  }
  const files = fs
    .readdirSync(videoSubDir)
    .filter((name) => /^p(\-\d+)?\.mkv$|^p\d+\.ts$/i.test(name))
    .map((name) => ensureInside(videoSubDir, path.join(videoSubDir, name)));
  return { success: true, cutFilePaths: files.length ? files : [outputPath] };
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
async function fix(record, options = {}) {
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
      {
        cwd: workDir,
        logStream: options.logStream,
        onProcessStart: options.onProcessStart,
        onProcessEnd: options.onProcessEnd,
      }
    );
    if (!result.success) return result;
    fixed.push(output);
  }
  return { success: true, fixedFilePaths: fixed, finalFilePaths: fixed };
}

/**
 * 通过 ffprobe 获取视频文件的分辨率
 * @param {string} filePath - 视频文件路径
 * @returns {{width: number, height: number}|null}
 */
function getVideoResolution(filePath) {
  const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
  try {
    const { execSync } = require('child_process');
    const output = execSync(
      `"${ffprobePath}" -v error -select_streams v:0 -show_entries stream=width,height -of json "${filePath}"`,
      { encoding: 'utf-8', timeout: 30000 }
    );
    const data = JSON.parse(output);
    if (data.streams && data.streams.length > 0) {
      return {
        width: parseInt(data.streams[0].width),
        height: parseInt(data.streams[0].height),
      };
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  extract,
  download,
  cut,
  fix,
  runCommand,
  ensureInside,
  getVideoResolution,
};
