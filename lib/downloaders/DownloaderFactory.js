const pool = require('../../db/index');
const FFmpegDownloader = require('./FFmpegDownloader');

const INSTANCES = {
  ffmpeg: new FFmpegDownloader(),
};

let streamGearsInstance = null;

async function getStreamGearsInstance() {
  if (streamGearsInstance) return streamGearsInstance;
  try {
    const { spawn } = require('child_process');
    const proc = spawn('python3', ['-c', 'from stream_gears import download; print("ok")'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await new Promise((resolve) => {
      let out = '';
      proc.stdout.on('data', (d) => (out += d.toString()));
      proc.on('close', (code) => resolve(code === 0));
    });
    if (result) {
      const StreamGearsDownloader = require('./StreamGearsDownloader');
      streamGearsInstance = new StreamGearsDownloader();
      return streamGearsInstance;
    }
  } catch (_) {}
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
