'use strict';

const { spawn } = require('child_process');

/**
 * 直播流画质探测（ffprobe）。
 *
 * 小红书等平台的播放地址里没有可解析的清晰度信息（`_hcv530` 之类的后缀是 CDN
 * 流变体标识），只能实际探测。扩展 Popup 在用户手动推送前调用本服务，拿到真实的
 * 分辨率 / 编码 / 码率，避免盲选。
 *
 * 安全约束：
 * - 只允许探测小红书直播 CDN（live*.xhscdn.com / .net），避免任意 URL 变成
 *   SSRF 或带宽放大器；
 * - 并发上限 + 结果缓存，避免被反复刷探测。
 */

const PROBE_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 60 * 1000;
const CACHE_LIMIT = 200;
const MAX_CONCURRENT = 3;

const cache = new Map();
let activeProbes = 0;

/**
 * 是否允许探测该地址（小红书直播 CDN）。
 *
 * @param {*} rawUrl
 * @returns {boolean}
 */
function isProbeableStreamUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl || rawUrl.length > 2048) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    const isXhsLiveCdn = (host.endsWith('.xhscdn.com') || host.endsWith('.xhscdn.net')) && host.startsWith('live');
    return isXhsLiveCdn;
  } catch (_) {
    return false;
  }
}

/** 同一路径的签名参数会变化，缓存按 pathname 收敛。 */
function cacheKey(rawUrl) {
  const parsed = new URL(rawUrl);
  return `${parsed.origin}${parsed.pathname}`;
}

function setCache(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/**
 * 用 ffprobe 读取首帧视频流信息。
 *
 * @param {string} url
 * @returns {Promise<{ok:boolean, width?:number, height?:number, codec?:string,
 *   bit_rate?:number|null, fps?:string, error?:string, message?:string}>}
 */
function runProbe(url) {
  return new Promise((resolve) => {
    const args = [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,width,height,bit_rate,avg_frame_rate',
      '-of',
      'json',
      '-rw_timeout',
      '5000000',
      url,
    ];

    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'timeout' });
      try {
        child?.kill('SIGKILL');
      } catch (_) {}
    }, PROBE_TIMEOUT_MS);

    try {
      child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish({ ok: false, error: 'ffprobe_unavailable', message: err.message });
      return;
    }

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 64 * 1024) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.on('error', (err) => finish({ ok: false, error: 'ffprobe_unavailable', message: err.message }));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        return finish({ ok: false, error: 'probe_failed', message: stderr.trim().slice(0, 300) });
      }
      try {
        const json = JSON.parse(stdout);
        const stream = Array.isArray(json?.streams) ? json.streams[0] : null;
        if (!stream?.width || !stream?.height) {
          return finish({ ok: false, error: 'no_video_stream' });
        }
        finish({
          ok: true,
          width: Number(stream.width),
          height: Number(stream.height),
          codec: stream.codec_name || '',
          bit_rate: Number(stream.bit_rate) || null,
          fps: stream.avg_frame_rate || '',
          measured_at: new Date().toISOString(),
        });
      } catch (_) {
        finish({ ok: false, error: 'parse_failed' });
      }
    });
  });
}

/**
 * 探测直播流画质。
 *
 * @param {string} url
 * @returns {Promise<Object>} 与 runProbe 相同；不允许的地址返回 unsupported_url，
 *   并发已满返回 busy（均不触发 ffprobe）。
 */
async function probeStream(url) {
  if (!isProbeableStreamUrl(url)) {
    return { ok: false, error: 'unsupported_url' };
  }

  const key = cacheKey(url);
  const cached = cache.get(key);
  if (cached) {
    const ttl = cached.value.ok ? CACHE_TTL_MS : FAILURE_CACHE_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.value;
  }

  if (activeProbes >= MAX_CONCURRENT) {
    return { ok: false, error: 'busy' };
  }

  activeProbes++;
  try {
    const result = await runProbe(url);
    setCache(key, result);
    return result;
  } finally {
    activeProbes--;
  }
}

module.exports = { probeStream, isProbeableStreamUrl };
