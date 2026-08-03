const PlatformChecker = require('./PlatformChecker');

const { createModuleLogger } = require('../logger');
const log = createModuleLogger('polling');
const { generateABogus } = require('./signers/douyin');

const DOUBYIN_LIVE_BASE = 'https://live.douyin.com';
const DOUBYIN_API_BASE = 'https://webcast.amemv.com';

class DouyinChecker extends PlatformChecker {
  constructor(roomUrl) {
    super(roomUrl);
    this._roomId = null;
    this._userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36';
  }

  static getPlatformId() {
    return 'douyin';
  }

  static canHandleUrl(url) {
    return /douyin\.com/i.test(url) || /live\.douyin\.com/i.test(url);
  }

  getRoomId() {
    if (this._roomId) return this._roomId;

    let roomId = PlatformChecker.extractLastPathSegment(this.roomUrl);
    if (!roomId) {
      const match = this.roomUrl.match(/web_rid=(\d+)/);
      if (match) {
        roomId = match[1];
      }
    }

    if (roomId) {
      this._roomId = roomId.split('?')[0].split('#')[0];
    }
    return this._roomId;
  }

  async resolveShortUrl(url) {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'manual',
        headers: {
          'User-Agent': this._userAgent,
        },
      });

      const location = response.headers.get('Location');
      if (location) {
        return location;
      }

      const textResponse = await fetch(url, {
        headers: {
          'User-Agent': this._userAgent,
        },
      });

      if (!textResponse.ok) {
        return url;
      }

      const html = await textResponse.text();
      const match = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
      if (match) {
        return match[1];
      }

      return url;
    } catch (err) {
      log.error(`[DouyinChecker] 解析短链接失败 (${url}):`, err.message);
      return url;
    }
  }

  async getRoomInfoViaWebAPI(webRid) {
    try {
      const params = new URLSearchParams({
        aid: '6383',
        app_name: 'douyin_web',
        live_id: '1',
        device_platform: 'web',
        language: 'zh-CN',
        browser_language: 'zh-CN',
        browser_platform: 'Win32',
        browser_name: 'Chrome',
        browser_version: '116.0.0.0',
        web_rid: webRid,
        msToken: '',
      });

      const aBogus = generateABogus(params.toString(), this._userAgent);
      if (!aBogus) {
        log.error('[DouyinChecker] a_bogus 签名生成失败');
        return null;
      }

      params.set('a_bogus', aBogus);

      const headers = {
        'User-Agent': this._userAgent,
        Origin: DOUBYIN_LIVE_BASE,
        Referer: `${DOUBYIN_LIVE_BASE}/${webRid}`,
      };

      const cookie = process.env.POLLING_DOUYIN_COOKIE;
      if (cookie) {
        headers.Cookie = cookie;
      }

      const data = await PlatformChecker.fetchJson(`${DOUBYIN_API_BASE}/webcast/room/web/enter/?${params.toString()}`, {
        headers,
      });

      if (!data || data.code !== 0 || !data.data) {
        return null;
      }

      return data.data;
    } catch (err) {
      log.error(`[DouyinChecker] Web API 请求失败 (${webRid}):`, err.message);
      return null;
    }
  }

  async getRoomInfoViaHTML(webRid) {
    try {
      const url = `${DOUBYIN_LIVE_BASE}/${webRid}`;
      const html = await PlatformChecker.fetchText(url, {
        headers: {
          'User-Agent': this._userAgent,
        },
      });

      // 优先尝试旧格式 __INITIAL_STATE__
      const renderDataMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/);
      if (renderDataMatch) {
        try {
          return JSON.parse(renderDataMatch[1]);
        } catch (e) {
          log.error('[DouyinChecker] 解析 INITIAL_STATE 失败:', e.message);
        }
      }

      // 新格式：从 __pace_f.push 的 RSC 数据中提取 roomStore
      const roomData = this._extractRoomFromPaceF(html);
      if (roomData) {
        return roomData;
      }

      return null;
    } catch (err) {
      log.error(`[DouyinChecker] HTML 解析失败 (${webRid}):`, err.message);
      return null;
    }
  }

  _extractRoomFromPaceF(html) {
    try {
      // 遍历所有 __pace_f.push 块，查找包含 roomInfo.room 的块
      const startMarker = 'self.__pace_f.push([1,"';
      const endMarker = '"])';
      let searchIdx = 0;

      while (true) {
        const start = html.indexOf(startMarker, searchIdx);
        if (start === -1) break;

        const contentStart = start + startMarker.length;
        // 查找块结束位置（跳过转义的 \"]）
        let end = contentStart;
        while (end < html.length) {
          const nextEnd = html.indexOf(endMarker, end);
          if (nextEnd === -1) break;
          if (html[nextEnd - 1] === '\\') {
            end = nextEnd + endMarker.length;
            continue;
          }
          end = nextEnd;
          break;
        }

        const block = html.substring(contentStart, end);
        searchIdx = end + endMarker.length;

        // 只处理包含实际房间数据的块
        if (!block.includes('roomInfo') || !block.includes('\\"room\\"')) continue;

        // 反转义 \" 引号
        const unescaped = block.replace(/\\"/g, '"');

        // 定位 roomInfo.room 区域
        const roomInfoIdx = unescaped.indexOf('"roomInfo":{"room"');
        if (roomInfoIdx === -1) continue;

        const region = unescaped.substring(roomInfoIdx, roomInfoIdx + 10000);

        // 逐字段提取
        const titleMatch = region.match(/"title":"([^"]+)"/);
        const statusMatch = region.match(/"status":(\d+)/);
        const idMatch = region.match(/"id_str":"(\d+)"/);
        const nicknameMatch = [...region.matchAll(/"nickname":"([^"]+)"/g)].find((m) => m[1] !== '$undefined');
        const coverMatch = region.match(/"url_list":\["(http[^"]+)"/);

        // 提取流地址（优先 flv HD1）
        let streamUrl = null;
        let format = 'flv';
        const flvMatch = region.match(/"HD1":"(http[^"]+\.flv[^"]*)"/);
        if (flvMatch) {
          streamUrl = flvMatch[1].replace(/\\u0026/g, '&');
        } else {
          const flvFullMatch = region.match(/"FULL_HD1":"(http[^"]+\.flv[^"]*)"/);
          if (flvFullMatch) {
            streamUrl = flvFullMatch[1].replace(/\\u0026/g, '&');
          } else {
            const hlsMatch = region.match(/"hls_pull_url_map":\{[^}]*?"HD1":"(http[^"]+\.m3u8[^"]*)"/);
            if (hlsMatch) {
              streamUrl = hlsMatch[1].replace(/\\u0026/g, '&');
              format = 'hls';
            }
          }
        }

        if (statusMatch) {
          return {
            room_info: {
              id_str: idMatch ? idMatch[1] : '',
              status: parseInt(statusMatch[1], 10),
              title: titleMatch ? titleMatch[1] : '',
              nickname: nicknameMatch ? nicknameMatch[1] : '',
              cover: coverMatch ? { url_list: [coverMatch[1]] } : undefined,
            },
            stream_url: streamUrl
              ? {
                  flv_pull_url: format === 'flv' ? { HD1: streamUrl } : undefined,
                  hls_pull_url_map: format === 'hls' ? { HD1: streamUrl } : undefined,
                }
              : undefined,
          };
        }
      }

      return null;
    } catch (err) {
      log.error('[DouyinChecker] 解析 __pace_f 数据失败:', err.message);
      return null;
    }
  }

  parseStreamData(apiResponse) {
    try {
      if (!apiResponse) {
        return null;
      }

      let streamUrl = null;
      let format = 'flv';

      if (apiResponse.stream_url?.pull_datas) {
        const pullDatas = apiResponse.stream_url.pull_datas;
        for (const data of pullDatas) {
          if (data.pull_url && data.pull_url.includes('.flv')) {
            streamUrl = data.pull_url;
            format = 'flv';
            break;
          } else if (data.pull_url && data.pull_url.includes('.m3u8')) {
            streamUrl = data.pull_url;
            format = 'hls';
          }
        }
      }

      if (!streamUrl && apiResponse.live_core_sdk_data?.pull_data?.stream_data) {
        try {
          const streamData = JSON.parse(apiResponse.live_core_sdk_data.pull_data.stream_data);
          if (streamData.data?.stream_url?.pull_datas) {
            for (const data of streamData.data.stream_url.pull_datas) {
              if (data.pull_url) {
                streamUrl = data.pull_url;
                format = data.pull_url.includes('.m3u8') ? 'hls' : 'flv';
                break;
              }
            }
          }
        } catch (e) {
          log.error('[DouyinChecker] 解析 stream_data 失败:', e.message);
        }
      }

      if (!streamUrl && apiResponse.stream_url?.flv_pull_url) {
        const flvUrl = apiResponse.stream_url.flv_pull_url;
        if (typeof flvUrl === 'object') {
          streamUrl = flvUrl.HD1 || flvUrl.FULL_HD1 || flvUrl.SD1 || Object.values(flvUrl)[0];
        } else {
          streamUrl = flvUrl;
        }
        format = 'flv';
      }

      if (!streamUrl && apiResponse.stream_url?.hls_pull_url) {
        const hlsUrl = apiResponse.stream_url.hls_pull_url;
        if (typeof hlsUrl === 'object') {
          streamUrl = hlsUrl.HD1 || hlsUrl.FULL_HD1 || hlsUrl.SD1 || Object.values(hlsUrl)[0];
        } else {
          streamUrl = hlsUrl;
        }
        format = 'hls';
      }

      if (!streamUrl && apiResponse.stream_url?.hls_pull_url_map) {
        const hlsMap = apiResponse.stream_url.hls_pull_url_map;
        if (typeof hlsMap === 'object') {
          streamUrl = hlsMap.HD1 || hlsMap.FULL_HD1 || hlsMap.SD1 || Object.values(hlsMap)[0];
          format = 'hls';
        }
      }

      if (!streamUrl) {
        return null;
      }

      return { streamUrl, format };
    } catch (err) {
      log.error('[DouyinChecker] 解析流数据失败:', err.message);
      return null;
    }
  }

  checkUnsupportedType(roomData) {
    if (!roomData) {
      return false;
    }

    const roomType = roomData.room_type || roomData.type;
    const unsupportedTypes = [2, 3, 4, 5];

    if (unsupportedTypes.includes(roomType)) {
      return true;
    }

    const streamType = roomData.stream_type;
    if (streamType && (streamType.includes('vr') || streamType.includes('连麦'))) {
      return true;
    }

    return false;
  }

  async checkStatus() {
    let roomId = this.getRoomId();

    if (!roomId) {
      return PlatformChecker.normalizeResult({ error: '无法解析房间号' });
    }

    try {
      const originalUrl = this.roomUrl;
      if (originalUrl.includes('douyin.com/') && !originalUrl.includes('live.douyin.com')) {
        const resolvedUrl = await this.resolveShortUrl(originalUrl);
        const match = resolvedUrl.match(/live\.douyin\.com\/(\d+)/);
        if (match) {
          roomId = match[1];
        }
      }

      let apiResponse = await this.getRoomInfoViaWebAPI(roomId);
      let isFromWebAPI = true;

      if (!apiResponse) {
        apiResponse = await this.getRoomInfoViaHTML(roomId);
        isFromWebAPI = false;
      }

      if (!apiResponse) {
        return PlatformChecker.normalizeResult({ error: '无法获取房间信息' });
      }

      const roomInfo =
        apiResponse.room_info || apiResponse.data?.room_info || apiResponse.room?.room_info || apiResponse;
      const status = roomInfo.status || roomInfo.live_status;

      const roomName =
        roomInfo.owner_name || roomInfo.anchor_name || roomInfo.nickname || roomInfo.data?.owner_name || '';
      const roomTitle = roomInfo.title || roomInfo.room_title || '';
      const roomCover = roomInfo.cover?.url_list?.[0] || roomInfo.cover || roomInfo.room_cover || '';

      if (status !== 2) {
        return PlatformChecker.normalizeResult({
          isLive: false,
          roomName,
          roomTitle,
          roomCover,
        });
      }

      if (this.checkUnsupportedType(roomInfo)) {
        return PlatformChecker.normalizeResult({
          isLive: true,
          recordable: false,
          roomName,
          roomTitle,
          roomCover,
          error: '不支持的直播类型',
        });
      }

      const streamData = this.parseStreamData(apiResponse);

      if (!streamData) {
        return PlatformChecker.normalizeResult({
          isLive: true,
          recordable: false,
          roomName,
          roomTitle,
          roomCover,
          error: '无法获取流地址',
        });
      }

      return PlatformChecker.normalizeResult({
        isLive: true,
        roomName,
        roomTitle,
        roomCover,
        streamUrl: streamData.streamUrl,
        streamInfo: { format: streamData.format, source: isFromWebAPI ? 'webapi' : 'html' },
      });
    } catch (err) {
      log.error(`[DouyinChecker] 检查失败 (${this.roomUrl}):`, err.message);
      return PlatformChecker.normalizeResult({ error: err.message });
    }
  }
}

module.exports = DouyinChecker;
