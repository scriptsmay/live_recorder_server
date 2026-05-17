const pool = require('../../../db/index');
const FFmpegDownloader = require('./FFmpegDownloader');

const INSTANCES = {
  ffmpeg: new FFmpegDownloader(),
};

let streamGearsInstance = null;

/**
 * 获取 StreamGears 下载器实例（单例模式）。
 *
 * 该函数首先检查是否已存在缓存实例，若存在则直接返回。
 * 若不存在，则通过启动一个子进程运行 Python 命令来验证 `stream_gears` 模块是否可用。
 * 如果验证成功，则创建并缓存一个新的 StreamGearsDownloader 实例并返回；
 * 如果验证失败或发生异常，则返回 null。
 *
 * @returns {Promise<StreamGearsDownloader|null>} 返回 StreamGearsDownloader 实例，如果初始化失败则返回 null。
 */
async function getStreamGearsInstance() {
  // 如果实例已存在，直接返回缓存的实例
  if (streamGearsInstance) return streamGearsInstance;
  try {
    const { spawn } = require('child_process');
    // 启动 Python 子进程以检查 stream_gears 模块是否可导入
    const proc = spawn('python3', ['-c', 'from stream_gears import download; print("ok")'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 等待子进程执行完毕，并根据退出码判断模块是否可用
    const result = await new Promise((resolve) => {
      let out = '';
      proc.stdout.on('data', (d) => (out += d.toString()));
      proc.on('close', (code) => resolve(code === 0));
    });

    // 如果 Python 环境检查通过，则创建并缓存下载器实例
    if (result) {
      const StreamGearsDownloader = require('./StreamGearsDownloader');
      streamGearsInstance = new StreamGearsDownloader();
      return streamGearsInstance;
    }
  } catch (_) {}
  // 如果检查失败或发生异常，返回 null
  return null;
}

async function getDownloader(name) {
  const key = (name || 'ffmpeg').toLowerCase();
  if (key === 'stream-gears' || key === 'stream_gears') {
    const inst = await getStreamGearsInstance();
    if (inst) return inst;
    console.warn('[下载器] stream-gears 不可用，回退到 ffmpeg');
  }
  return INSTANCES.ffmpeg;
}

async function getActiveDownloader() {
  let name = 'ffmpeg';
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key = 'downloader'");
    if (r.rows.length) name = r.rows[0].value || 'ffmpeg';
  } catch (_) {}
  return getDownloader(name);
}

function getAll() {
  return INSTANCES;
}

module.exports = { getDownloader, getActiveDownloader, getAll };
