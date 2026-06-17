'use strict';

/**
 * Playwright 浏览器 m3u8 提取器
 * 参考 wuyan-replay/lib/browser.js extractM3u8Url 实现
 *
 * 当 HTTP API 方案无法获取 playUrlV3 时，通过浏览器打开回放页面，
 * 拦截 playback/detail API 响应或网络 m3u8 流来提取最佳清晰度 URL。
 */

const { RemoteBrowserClient } = require('../browser/RemoteBrowserClient');

/** 页面加载后等待时间（毫秒），确保播放器初始化和网络请求完成 */
const PAGE_WAIT_MS = 12000;

/**
 * 解析 m3u8 内容，提取清晰度列表
 * @param {string} text - m3u8 文件内容
 * @param {string} baseUrl - 用于解析相对路径的基础 URL
 * @returns {Array<{bandwidth: number, resolution: string|null, url: string}>}
 */
function parseM3u8(text, baseUrl) {
  const items = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const matchBandwidth = lines[i].match(/BANDWIDTH=(\d+)/);
      const matchRes = lines[i].match(/RESOLUTION=(\d+x\d+)/);
      const bandwidth = matchBandwidth ? parseInt(matchBandwidth[1]) : 0;
      const resolution = matchRes ? matchRes[1] : null;

      const targetUrl = lines[i + 1]?.trim();
      if (targetUrl && !targetUrl.startsWith('#')) {
        try {
          items.push({ bandwidth, resolution, url: new URL(targetUrl, baseUrl).href });
        } catch {
          items.push({ bandwidth, resolution, url: targetUrl });
        }
      }
    }
  }
  return items;
}

/**
 * 从 playUrlV3 结构中选择最佳流（优先 H264 + 最高分辨率）
 * 与 KuaishouReplayClient.selectBestStreamFromV3 逻辑一致
 */
function selectBestStreamFromV3(playUrlV3) {
  if (!playUrlV3) return null;

  const candidates = [];
  const codecEntries = [
    { key: 'h264', name: 'avc' },
    { key: 'hevc', name: 'hevc' },
  ];

  for (const { key, name } of codecEntries) {
    const codecData = playUrlV3[key];
    if (!codecData?.adaptationSet) continue;

    for (const as of codecData.adaptationSet) {
      if (!as.representation) continue;
      for (const rep of as.representation) {
        if (rep.hidden || !rep.url) continue;
        candidates.push({
          url: rep.url,
          width: rep.width || 0,
          height: rep.height || 0,
          pixels: (rep.width || 0) * (rep.height || 0),
          maxBitrate: rep.maxBitrate || 0,
          codec: name,
        });
      }
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (b.pixels !== a.pixels) return b.pixels - a.pixels;
    const aIsAvc = a.codec === 'avc' ? 1 : 0;
    const bIsAvc = b.codec === 'avc' ? 1 : 0;
    if (bIsAvc !== aIsAvc) return bIsAvc - aIsAvc;
    return b.maxBitrate - a.maxBitrate;
  });

  return candidates[0].url || null;
}

/**
 * 将标准 Cookie 字符串转换为 Playwright 格式
 * @param {string} cookieStr - "key1=value1; key2=value2" 格式
 * @returns {Array} Playwright cookie 数组
 */
function parseCookies(cookieStr) {
  if (!cookieStr || !cookieStr.trim()) return [];

  // 尝试 JSON 格式
  try {
    const parsed = JSON.parse(cookieStr);
    if (Array.isArray(parsed)) {
      return parsed
        .map((c) => {
          const fixed = { ...c };
          if (fixed.url && fixed.domain) delete fixed.url;
          if (!fixed.domain && !fixed.url) fixed.domain = '.kuaishou.com';
          if (!fixed.name || !fixed.value) return null;
          return fixed;
        })
        .filter(Boolean);
    }
  } catch {
    // 不是 JSON，按字符串处理
  }

  const cookies = [];
  const pairs = cookieStr
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);

  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = pair.substring(0, eqIndex).trim();
    const value = pair.substring(eqIndex + 1).trim();
    if (!key || !value) continue;
    cookies.push({
      name: key,
      value,
      domain: '.kuaishou.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'Lax',
    });
  }
  return cookies;
}

/**
 * 通过浏览器拦截网络请求提取 m3u8 URL
 *
 * 策略：
 *   1. 打开回放页面，监听 playback/detail API 响应，解析 playUrlV3
 *   2. 同时监听网络中的 m3u8 响应，收集候选流
 *   3. API 方式优先；失败时从网络捕获的 m3u8 中选最佳流
 *
 * @param {string} playbackUrl - 回放页面 URL
 * @param {string} cookieStr - Cookie 字符串
 * @returns {Promise<{m3u8Url: string|null, duration: number|null}>}
 */
async function extractM3u8WithBrowser(playbackUrl, cookieStr) {
  const client = new RemoteBrowserClient();

  try {
    const result = await client.withPage(
      async (page, context) => {
        // 注入 cookies
        const cookies = parseCookies(cookieStr);
        if (cookies.length > 0) {
          await context.addCookies(cookies);
        }

        const m3u8Candidates = [];
        let playbackDetailData = null;

        // 监听器 1: 捕获网络 m3u8 响应（降级方案）
        page.on('response', async (response) => {
          try {
            const url = response.url();
            const contentType = response.headers()['content-type'] || '';

            if (!url.includes('.m3u8') && !url.includes('live-playback')) return;
            if (!(contentType.includes('application/vnd.apple.mpegurl') || url.includes('.m3u8'))) return;

            const text = await response.text();
            const parsed = parseM3u8(text, url);

            if (parsed.length > 0) {
              parsed.forEach((s) => {
                if (!m3u8Candidates.find((c) => c.url === s.url)) {
                  m3u8Candidates.push(s);
                }
              });
            } else if (text.includes('#EXTM3U')) {
              if (!m3u8Candidates.find((c) => c.url === url)) {
                m3u8Candidates.push({ bandwidth: 0, url, resolution: '', type: 'media' });
              }
            }
          } catch {
            // 忽略响应读取错误
          }
        });

        // 监听器 2: 捕获 playback/detail API 响应
        page.on('response', async (res) => {
          if (res.url().includes('playback/detail')) {
            try {
              playbackDetailData = JSON.parse(await res.text());
            } catch {
              // 忽略解析错误
            }
          }
        });

        // 导航到回放页面
        await page.goto(playbackUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(PAGE_WAIT_MS);

        // 获取视频时长
        let duration = null;
        try {
          duration = await page.evaluate(() => {
            const video = document.querySelector('video');
            return video?.duration ? Math.floor(video.duration) : null;
          });
        } catch {
          // 忽略
        }

        // 方案 1: 从 API 响应中解析 playUrlV3
        let bestM3u8 = null;
        const currentWork = playbackDetailData?.data?.currentWork;
        if (currentWork?.playUrlV3) {
          const bestStream = selectBestStreamFromV3(currentWork.playUrlV3);
          if (bestStream) {
            bestM3u8 = bestStream;
          }
        }

        // 方案 2: 从网络捕获的 m3u8 中选择最佳流
        if (!bestM3u8 && m3u8Candidates.length > 0) {
          bestM3u8 = m3u8Candidates.reduce((prev, curr) => {
            if (!prev) return curr;
            return curr.bandwidth > prev.bandwidth ? curr : prev;
          }, null);
        }

        return {
          m3u8Url: bestM3u8?.url || null,
          duration,
        };
      },
      {
        timeoutMs: 45000,
        blockResources: false,
        allowFirstScreenResources: true,
      }
    );

    return result;
  } catch (err) {
    console.error(`[m3u8-extractor] 浏览器提取失败: ${err.message}`);
    return { m3u8Url: null, duration: null };
  } finally {
    await client.close();
  }
}

module.exports = {
  extractM3u8WithBrowser,
  parseM3u8,
  parseCookies,
  selectBestStreamFromV3,
};
