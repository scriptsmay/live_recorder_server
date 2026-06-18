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

function writeLog(logStream, message) {
  logStream?.write(`[${new Date().toISOString()}] ${message}\n`);
}

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

async function switchToHighestQuality(page, logStream) {
  writeLog(logStream, '[m3u8-extractor] 尝试切换最高清晰度');

  let hovered = false;
  const qualitySelectors = [
    '.kwai-player-quality',
    '.kwai-player-quality .tooltip-trigger',
    '[class*="player-quality"]',
    '[class*="player-quality"] .tooltip-trigger',
  ];

  for (const selector of qualitySelectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.hover({ timeout: 5000 });
        hovered = true;
        writeLog(logStream, `[m3u8-extractor] hover 成功: ${selector}`);
        break;
      }
    } catch {
      // 尝试下一个 selector
    }
  }

  if (!hovered) {
    try {
      const box = await page.evaluate(() => {
        const el =
          document.querySelector('.kwai-player-quality') || document.querySelector('[class*="player-quality"]');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      if (box) {
        const client = await page.context().newCDPSession(page);
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: box.x,
          y: box.y,
        });
        hovered = true;
        writeLog(logStream, `[m3u8-extractor] CDP hover 成功: ${Math.round(box.x)},${Math.round(box.y)}`);
      }
    } catch (err) {
      writeLog(logStream, `[m3u8-extractor] CDP hover 失败: ${err.message}`);
    }
  }

  if (!hovered) {
    writeLog(logStream, '[m3u8-extractor] 未找到清晰度按钮，尝试 JS API');
    return switchQualityViaJS(page, logStream);
  }

  await page.waitForTimeout(2000);
  const menuHtml = await page
    .evaluate(() => {
      const el = document.querySelector('.kwai-player-quality') || document.querySelector('[class*="player-quality"]');
      return el ? el.innerHTML : '';
    })
    .catch(() => '');
  if (menuHtml) {
    writeLog(logStream, `[m3u8-extractor] 清晰度菜单 HTML: ${menuHtml.substring(0, 200)}`);
  }

  const clicked = await clickHighestQualityOption(page, logStream);
  if (clicked) {
    writeLog(logStream, '[m3u8-extractor] 清晰度选项点击成功，等待高质量流加载');
    await page.waitForTimeout(8000);
    return true;
  }

  return switchQualityViaJS(page, logStream);
}

async function clickHighestQualityOption(page, logStream) {
  const qualityKeywords = ['原画', '蓝光', '4K', '超清', '1080P', '高清', '720P'];

  for (const keyword of qualityKeywords) {
    try {
      const qualityEl =
        (await page.locator('.kwai-player-quality').first().elementHandle()) ||
        (await page.locator('[class*="player-quality"]').first().elementHandle());
      if (!qualityEl) continue;

      const itemTexts = await qualityEl.$$eval('*', (els) =>
        els
          .filter((el) => {
            const text = el.textContent?.trim() || '';
            return text.includes(keyword) && text.length < 15;
          })
          .map((el) => ({ tag: el.tagName, text: el.textContent?.trim(), classes: el.className }))
      );

      if (itemTexts.length > 0) {
        writeLog(logStream, `[m3u8-extractor] 找到清晰度选项: ${keyword} (${itemTexts[0].text})`);
        const clicked = await page.evaluate((kw) => {
          const container =
            document.querySelector('.kwai-player-quality') || document.querySelector('[class*="player-quality"]');
          if (!container) return false;
          const allEls = container.querySelectorAll('*');
          for (const el of allEls) {
            const text = el.textContent?.trim() || '';
            if (text.includes(kw) && text.length < 15) {
              el.click();
              return true;
            }
          }
          return false;
        }, keyword);

        if (clicked) {
          writeLog(logStream, `[m3u8-extractor] 已点击清晰度: ${keyword}`);
          return true;
        }
      }
    } catch {
      // 尝试下一个关键词
    }
  }

  for (const keyword of qualityKeywords) {
    try {
      const el = page.getByText(keyword, { exact: false }).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click({ timeout: 3000 });
        writeLog(logStream, `[m3u8-extractor] getByText 点击成功: ${keyword}`);
        return true;
      }
    } catch {
      // 尝试下一个关键词
    }
  }

  writeLog(logStream, '[m3u8-extractor] 未找到可点击的清晰度选项');
  return false;
}

async function switchQualityViaJS(page, logStream) {
  writeLog(logStream, '[m3u8-extractor] 尝试 JS 播放器 API 切换');

  const result = await page.evaluate(() => {
    const video = document.querySelector('video');
    if (!video) return { error: '未找到 video 元素' };

    const containers = [
      video.closest('[class*="player"]'),
      video.parentElement,
      document.querySelector('.kwai-player'),
      document.querySelector('[class*="kwai-player"]'),
    ].filter(Boolean);

    for (const container of containers) {
      for (const key of Object.keys(container)) {
        const obj = container[key];
        if (
          obj &&
          typeof obj === 'object' &&
          (typeof obj.getQuality === 'function' ||
            typeof obj.getQualities === 'function' ||
            typeof obj.qualityLevels === 'function' ||
            typeof obj.setQuality === 'function')
        ) {
          if (typeof obj.getQualities === 'function') {
            const qualities = obj.getQualities();
            if (Array.isArray(qualities) && qualities.length > 1) {
              const highest = qualities.sort(
                (a, b) => (b.bitrate || b.bandwidth || 0) - (a.bitrate || a.bandwidth || 0)
              )[0];
              if (typeof obj.setQuality === 'function') {
                obj.setQuality(highest.id || highest.name || highest.key);
                return { success: true, quality: highest };
              }
            }
          }
          if (typeof obj.qualityLevels === 'function') {
            const levels = obj.qualityLevels();
            if (levels && levels.length > 0) {
              const highest = Array.from(levels).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
              if (typeof obj.setQuality === 'function') {
                obj.setQuality(highest.id);
                return { success: true, quality: highest };
              }
            }
          }
        }
      }
    }

    return { error: '未找到播放器质量切换 API' };
  });

  if (result?.success) {
    writeLog(logStream, `[m3u8-extractor] JS API 切换成功: ${JSON.stringify(result.quality)}`);
    await page.waitForTimeout(8000);
    return true;
  }

  writeLog(logStream, `[m3u8-extractor] JS API 切换失败: ${result?.error || '未知原因'}`);
  return false;
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
async function extractM3u8WithBrowser(playbackUrl, cookieStr, options = {}) {
  const client = new RemoteBrowserClient();
  const logStream = options.logStream;

  try {
    const result = await client.withPage(
      async (page, context) => {
        // 注入 cookies
        const cookies = parseCookies(cookieStr);
        writeLog(logStream, `[m3u8-extractor] cookies=${cookies.length}`);
        if (cookies.length > 0) {
          await context.addCookies(cookies);
        }

        const m3u8Candidates = [];
        const apiResponses = [];
        const responseSamples = [];
        let playbackDetailData = null;

        // 监听器 1: 捕获网络 m3u8 响应（降级方案）
        page.on('response', async (response) => {
          try {
            const url = response.url();
            const contentType = response.headers()['content-type'] || '';
            if (/playback|m3u8|live-playback|m3u8/i.test(url)) {
              responseSamples.push(`${response.status()} ${contentType} ${url}`);
              if (responseSamples.length > 20) responseSamples.shift();
            }

            if (!url.includes('.m3u8') && !url.includes('live-playback')) return;
            if (!(contentType.includes('application/vnd.apple.mpegurl') || url.includes('.m3u8'))) return;

            const text = await response.text();
            const parsed = parseM3u8(text, url);
            writeLog(
              logStream,
              `[m3u8-extractor] 捕获 m3u8 响应 status=${response.status()} parsed=${parsed.length} url=${url}`
            );

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
              apiResponses.push(`${res.status()} ${res.url()}`);
              playbackDetailData = JSON.parse(await res.text());
              writeLog(logStream, `[m3u8-extractor] 捕获 playback/detail status=${res.status()}`);
            } catch {
              writeLog(logStream, `[m3u8-extractor] playback/detail 解析失败 status=${res.status()} url=${res.url()}`);
            }
          }
        });

        // 导航到回放页面
        writeLog(logStream, `[m3u8-extractor] goto ${playbackUrl}`);
        await page.goto(playbackUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        writeLog(logStream, `[m3u8-extractor] navigated url=${page.url()}`);
        await page.waitForTimeout(PAGE_WAIT_MS);
        const title = await page.title().catch(() => '');
        writeLog(logStream, `[m3u8-extractor] title=${title}`);

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
        writeLog(
          logStream,
          `[m3u8-extractor] playbackDetail=${playbackDetailData ? 'yes' : 'no'} currentWork=${currentWork ? 'yes' : 'no'} candidates=${m3u8Candidates.length}`
        );
        if (currentWork?.playUrlV3) {
          const bestStream = selectBestStreamFromV3(currentWork.playUrlV3);
          if (bestStream) {
            bestM3u8 = {
              url: typeof bestStream === 'string' ? bestStream : bestStream.url,
              bandwidth: bestStream.maxBitrate ? bestStream.maxBitrate * 1000 : 0,
              resolution: bestStream.resolution || '',
              type: 'api',
            };
          }
        }

        // 方案 2: 从网络捕获的 m3u8 中选择最佳流
        if (!bestM3u8) {
          const beforeSwitch = m3u8Candidates.length;
          await switchToHighestQuality(page, logStream);
          writeLog(logStream, `[m3u8-extractor] UI 切换前候选=${beforeSwitch} 切换后候选=${m3u8Candidates.length}`);
        }

        if (!bestM3u8 && m3u8Candidates.length > 0) {
          bestM3u8 = m3u8Candidates.reduce((prev, curr) => {
            if (!prev) return curr;
            return curr.bandwidth > prev.bandwidth ? curr : prev;
          }, null);
        }

        return {
          m3u8Url: bestM3u8?.url || null,
          duration,
          error: bestM3u8
            ? ''
            : [
                '浏览器方案未捕获可用 m3u8',
                `page_url=${page.url()}`,
                `title=${title || '-'}`,
                `playback_detail=${apiResponses.length ? apiResponses.join(' | ') : 'not-captured'}`,
                `m3u8_candidates=${m3u8Candidates.length}`,
                `samples=${responseSamples.slice(-5).join(' || ') || '-'}`,
              ].join('; '),
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
    writeLog(logStream, `[m3u8-extractor] 浏览器提取异常: ${err.message}`);
    return { m3u8Url: null, duration: null, error: `浏览器提取异常: ${err.message}` };
  } finally {
    await client.close();
  }
}

module.exports = {
  extractM3u8WithBrowser,
  parseM3u8,
  parseCookies,
  selectBestStreamFromV3,
  switchToHighestQuality,
};
