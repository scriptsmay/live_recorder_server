const PlatformChecker = require('./PlatformChecker');
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
      console.error(`[DouyinChecker] 解析短链接失败 (${url}):`, err.message);
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
        console.error('[DouyinChecker] a_bogus 签名生成失败');
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

      const data = await PlatformChecker.fetchJson(
        `${DOUBYIN_API_BASE}/webcast/room/web/enter/?${params.toString()}`,
        { headers }
      );

      if (!data || data.code !== 0 || !data.data) {
        return null;
      }

      return data.data;
    } catch (err) {
      console.error(`[DouyinChecker] Web API 请求失败 (${webRid}):`, err.message);
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

      const renderDataMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/);
      if (!renderDataMatch) {
        return null;
      }

      let jsonData;
      try {
        jsonData = JSON.parse(renderDataMatch[1]);
      } catch (e) {
        console.error('[DouyinChecker] 解析 INITIAL_STATE 失败:', e.message);
        return null;
      }

      return jsonData;
    } catch (err) {
      console.error(`[DouyinChecker] HTML 解析失败 (${webRid}):`, err.message);
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
          console.error('[DouyinChecker] 解析 stream_data 失败:', e.message);
        }
      }

      if (!streamUrl && apiResponse.stream_url?.flv_pull_url) {
        streamUrl = apiResponse.stream_url.flv_pull_url;
        format = 'flv';
      }

      if (!streamUrl && apiResponse.stream_url?.hls_pull_url) {
        streamUrl = apiResponse.stream_url.hls_pull_url;
        format = 'hls';
      }

      if (!streamUrl) {
        return null;
      }

      return { streamUrl, format };
    } catch (err) {
      console.error('[DouyinChecker] 解析流数据失败:', err.message);
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

      const roomInfo = apiResponse.room_info || apiResponse.data?.room_info || apiResponse.room?.room_info || apiResponse;
      const status = roomInfo.status || roomInfo.live_status;

      const roomName =
        roomInfo.owner_name ||
        roomInfo.anchor_name ||
        roomInfo.data?.owner_name ||
        '';
      const roomTitle = roomInfo.title || roomInfo.room_title || '';
      const roomCover = roomInfo.cover || roomInfo.room_cover || '';

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
      console.error(`[DouyinChecker] 检查失败 (${this.roomUrl}):`, err.message);
      return PlatformChecker.normalizeResult({ error: err.message });
    }
  }
}

module.exports = DouyinChecker;
