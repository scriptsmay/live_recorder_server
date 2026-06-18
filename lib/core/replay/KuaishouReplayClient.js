'use strict';

/**
 * 快手回放 API 客户端
 * 参考 wuyan-replay/lib/api.js 实现，适配 live_recorder_server 环境
 */

const ReplayService = require('../../../services/ReplayService');

const KUAISHOU_API_BASE = 'https://live.kuaishou.com/live_api/playback/list';
const KUAISHOU_PLAYBACK_DETAIL_API = 'https://live.kuaishou.com/live_api/playback/detail';

function writeLog(logStream, message) {
  logStream?.write(`[${new Date().toISOString()}] ${message}\n`);
}

async function getLegacyKuaishouSetting(key) {
  const DataService = require('../../../services/DataService');
  return (await DataService.getSetting(key, '')) || '';
}

/**
 * 获取快手访问态配置。
 *
 * 主 cookie 统一复用直播轮询的 POLLING_KUAISHOU_COOKIE，旧的 settings.kuaishou_* 和 KW_* 仅作兼容 fallback。
 */
async function getKuaishouCookies() {
  const env = process.env;

  const cookie = env.POLLING_KUAISHOU_COOKIE || (await getLegacyKuaishouSetting('kuaishou_cookie')) || env.KW_COOKIE || '';
  const kwfv1 = (await getLegacyKuaishouSetting('kuaishou_kwfv1')) || env.KW_KWSFV1 || '';
  const kwssectoken = (await getLegacyKuaishouSetting('kuaishou_kwssectoken')) || env.KW_KWSSECTOKEN || '';
  const kwscode = (await getLegacyKuaishouSetting('kuaishou_kwscode')) || env.KW_KWSCODE || '';
  const bfb1s = (await getLegacyKuaishouSetting('kuaishou_bfb1s')) || env.KW_BFB1S || '';
  const webSt = (await getLegacyKuaishouSetting('kuaishou_web_st')) || env.KW_WEB_ST || '';
  const webPh = (await getLegacyKuaishouSetting('kuaishou_web_ph')) || env.KW_WEB_PH || '';
  const kww = (await getLegacyKuaishouSetting('kuaishou_kww')) || env.KW_KWW || '';

  return { cookie, kwfv1, kwssectoken, kwscode, bfb1s, webSt, webPh, kww };
}

/**
 * 构建快手 API 请求头
 */
function buildHeaders(cookies, principalId) {
  const cookieParts = [];
  if (cookies.cookie) cookieParts.push(cookies.cookie);
  if (cookies.kwfv1) cookieParts.push(`kwfv1=${cookies.kwfv1}`);
  if (cookies.kwssectoken) cookieParts.push(`kwssectoken=${cookies.kwssectoken}`);
  if (cookies.kwscode) cookieParts.push(`kwscode=${cookies.kwscode}`);
  if (cookies.bfb1s) cookieParts.push(`kuaishou.live.bfb1s=${cookies.bfb1s}`);
  if (cookies.webSt) cookieParts.push(`kuaishou.live.web_st=${cookies.webSt}`);
  if (cookies.webPh) cookieParts.push(`kuaishou.live.web_ph=${cookies.webPh}`);

  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,zh-TW;q=0.7',
    kww: cookies.kww || '',
    'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    cookie: cookieParts.join('; '),
    Referer: `https://live.kuaishou.com/profile/${principalId}`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  };
}

/**
 * 生成 __NS_hxfalcon 参数
 */
function generateHxfalcon(kww) {
  if (!kww) return '';
  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(2, 15);
  return `HUDR_sFnX-DtsB0FXsbDPQXTMP-sk0is9B7dAtQleg__VsxK3cJBScjfyoZuJDKCd0dFhpVOXKHFtTrFSOUNZnJTTlJFc98xCkEx5ZgnSHUamh8T1mQj2KahjLnk5k4h7AzVSQOFDJx_cz7yJPw1Sk0LdBXDB7EldiNpP-bUrhQif$HE_${timestamp.toString(16)}${randomStr}`;
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}_${get('hour')}_${get('minute')}_${get('second')}`;
}

/**
 * 获取回放列表（单页）
 */
async function fetchLiveList(principalId, cookies, count = 12, cursor = '') {
  const hxfalcon = generateHxfalcon(cookies.kww);
  const url = new URL(KUAISHOU_API_BASE);
  url.searchParams.set('__NS_hxfalcon', hxfalcon);
  url.searchParams.set('caver', '2');
  url.searchParams.set('count', String(count));
  url.searchParams.set('cursor', cursor);
  url.searchParams.set('hasMore', 'true');
  url.searchParams.set('principalId', principalId);

  const headers = buildHeaders(cookies, principalId);

  try {
    const response = await fetch(url.toString(), { method: 'GET', headers, signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      return { error: `HTTP ${response.status}: ${response.statusText}` };
    }
    const data = await response.json();
    if (!data || !data.data || !Array.isArray(data.data.list)) {
      return { error: 'API 响应格式异常' };
    }
    return { data: data.data };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * 获取回放列表并写入数据库
 * @param {string} principalId - 主播 ID
 * @param {number} count - 拉取条数
 * @param {string} [principalName] - 主播名称
 * @returns {Promise<{created: number, updated: number, records: Array}>}
 */
async function syncReplays(principalId, count = 12, principalName) {
  const settings = await ReplayService.getSettings(principalId);
  const displayName = settings.principal_name || principalName || principalId;
  const cookies = await getKuaishouCookies();

  const result = await fetchLiveList(principalId, cookies, Math.min(count, 50));
  if (result.error) {
    throw new Error(`获取回放列表失败: ${result.error}`);
  }

  const items = result.data.list || [];
  let created = 0;
  let updated = 0;

  for (const item of items) {
    const replayId = item.id || item.photoId || '';
    if (!replayId) continue;

    const existing = await ReplayService.getRecordByReplayId(principalId, replayId);
    const timePart = item.createTime ? formatTimestamp(item.createTime) : '';
    const recordData = {
      principal_id: principalId,
      principal_name: displayName,
      replay_id: replayId,
      play_url: item.playUrl || `https://live.kuaishou.com/playback/${replayId}`,
      video_file_name: timePart ? `${displayName}_${timePart}` : `${displayName}_${replayId}`,
      status: 'pending',
      start_time: item.createTime ? new Date(item.createTime) : null,
      duration: item.duration || 0,
    };

    if (existing) {
      updated++;
    } else {
      created++;
    }
    await ReplayService.upsertRecord(recordData);
  }

  return { created, updated, records: items };
}

/**
 * 通过 HTTP API 提取 m3u8 URL（尝试 playback/detail 接口）
 * API 失败时自动降级到 Playwright 浏览器方案
 * @param {object} record - 回放记录
 * @returns {Promise<{success: boolean, m3u8Url?: string, duration?: number, error?: string}>}
 */
async function extractM3u8(record, options = {}) {
  const logStream = options.logStream;
  if (record.m3u8_url) {
    writeLog(logStream, `已有 m3u8_url，跳过提取: ${record.m3u8_url}`);
    return { success: true, m3u8Url: record.m3u8_url };
  }

  const replayId = record.replay_id;
  if (!replayId) {
    return { success: false, error: '缺少 replay_id，无法提取 m3u8' };
  }

  const cookies = await getKuaishouCookies();
  writeLog(logStream, `开始提取 m3u8 replay_id=${replayId}`);
  writeLog(logStream, `Cookie 配置: ${cookies.cookie ? 'KW_COOKIE 已配置' : 'KW_COOKIE 为空'}`);

  // 方案 1: HTTP API 直接调用 playback/detail 接口
  try {
    const headers = buildHeaders(cookies, record.principal_id);
    const detailUrl = new URL(KUAISHOU_PLAYBACK_DETAIL_API);
    detailUrl.searchParams.set('photoId', replayId);
    detailUrl.searchParams.set('isLongVideo', 'false');

    const response = await fetch(detailUrl.toString(), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15000),
    });

    writeLog(logStream, `detail API HTTP ${response.status} ${response.statusText}`);
    if (response.ok) {
      const data = await response.json();
      const playUrlV3 = data?.data?.currentWork?.playUrlV3;
      writeLog(logStream, `detail API currentWork=${data?.data?.currentWork ? 'yes' : 'no'} playUrlV3=${playUrlV3 ? 'yes' : 'no'}`);

      if (playUrlV3) {
        const m3u8Url = selectBestStreamFromV3(playUrlV3);
        if (m3u8Url) {
          writeLog(logStream, `detail API 提取成功: ${m3u8Url}`);
          return { success: true, m3u8Url };
        }
      }

      // Fallback: 检查 mainMvUrls
      const mainMvUrls = data?.data?.mainMvUrls;
      if (mainMvUrls && Array.isArray(mainMvUrls) && mainMvUrls.length > 0) {
        const sorted = mainMvUrls.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (sorted[0]?.url) {
          writeLog(logStream, `detail API mainMvUrls 提取成功: ${sorted[0].url}`);
          return { success: true, m3u8Url: sorted[0].url };
        }
      }
    }
  } catch (err) {
    console.log(`[KuaishouReplay] API 提取 m3u8 失败，降级到浏览器方案: ${err.message}`);
    writeLog(logStream, `detail API 异常: ${err.message}`);
  }

  // 方案 2: Playwright 浏览器兜底 — 打开回放页面拦截 API/网络请求
  try {
    const { extractM3u8WithBrowser } = require('./m3u8-extractor');
    const playbackUrl = record.play_url || `https://live.kuaishou.com/playback/${replayId}`;
    const cookieStr = cookies.cookie || '';

    console.log(`[KuaishouReplay] 使用浏览器方案提取 m3u8: ${playbackUrl}`);
    writeLog(logStream, `浏览器方案开始: ${playbackUrl}`);
    const result = await extractM3u8WithBrowser(playbackUrl, cookieStr, { logStream });

    if (result.m3u8Url) {
      writeLog(logStream, `浏览器方案提取成功: ${result.m3u8Url}`);
      return { success: true, m3u8Url: result.m3u8Url, duration: result.duration };
    }

    const detail = result.error || '浏览器方案也未能提取到 m3u8 地址';
    writeLog(logStream, `浏览器方案失败: ${detail}`);
    return { success: false, error: detail };
  } catch (err) {
    writeLog(logStream, `浏览器提取异常: ${err.message}`);
    return { success: false, error: `浏览器提取 m3u8 失败: ${err.message}` };
  }
}

/**
 * 从 playUrlV3 结构中选择最佳流（优先 H264 + 最高分辨率）
 * 参考 wuyan-replay/lib/browser.js selectBestStreamFromV3
 */
function selectBestStreamFromV3(playUrlV3) {
  const candidates = [];

  const collectFromAdaptation = (adaptationSets, codec) => {
    if (!Array.isArray(adaptationSets)) return;
    for (const adaptation of adaptationSets) {
      const representations = adaptation.representation || [];
      for (const rep of representations) {
        if (rep.hidden) continue;
        candidates.push({
          url: rep.url,
          width: rep.width || 0,
          height: rep.height || 0,
          maxBitrate: rep.maxBitrate || 0,
          codec,
        });
      }
    }
  };

  collectFromAdaptation(playUrlV3.h264?.adaptationSet, 'h264');
  collectFromAdaptation(playUrlV3.hevc?.adaptationSet, 'hevc');

  if (candidates.length === 0) return null;

  // 排序：像素数降序 → H264 优先 → 码率降序
  candidates.sort((a, b) => {
    const pixelsA = a.width * a.height;
    const pixelsB = b.width * b.height;
    if (pixelsB !== pixelsA) return pixelsB - pixelsA;
    if (a.codec !== b.codec) return a.codec === 'h264' ? -1 : 1;
    return b.maxBitrate - a.maxBitrate;
  });

  return candidates[0].url || null;
}

module.exports = {
  fetchLiveList,
  syncReplays,
  extractM3u8,
  getKuaishouCookies,
  buildHeaders,
  generateHxfalcon,
  formatTimestamp,
  selectBestStreamFromV3,
};
