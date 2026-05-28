const PlatformChecker = require('./PlatformChecker');
const { getSignParams } = require('./signers/douyu');
const { getVipSignParams, fetchVipJsCode } = require('./signers/douyu-vip');

const DOYU_API_BASE = 'https://www.douyu.com';
const DOYU_MOBILE_API = 'https://m.douyu.com';
const DOYU_PLAY_API = 'https://playweb.douyucdn.cn';

class DouyuChecker extends PlatformChecker {
  constructor(roomUrl, options = {}) {
    super(roomUrl);
    this._roomId = null;
    this.options = {
      cdn: options.cdn || 'hw-h5',
      rate: options.rate || 0,
      detectInteractiveGame: options.detectInteractiveGame ?? false,
      ...options,
    };
  }

  static getPlatformId() {
    return 'douyu';
  }

  static canHandleUrl(url) {
    return /douyu\.com/i.test(url);
  }

  getRoomId() {
    if (this._roomId) return this._roomId;
    const roomId = PlatformChecker.extractLastPathSegment(this.roomUrl);
    if (roomId) {
      this._roomId = roomId.split('?')[0].split('#')[0];
    }
    return this._roomId;
  }

  async resolveRealRoomId(shortId) {
    if (!shortId) return null;

    if (/^\d+$/.test(shortId)) {
      return shortId;
    }

    try {
      const url = `${DOYU_MOBILE_API}/${shortId}`;
      const html = await PlatformChecker.fetchText(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
      });

      const match = html.match(/room_id\s*:\s*(\d+)/);
      if (match) {
        return match[1];
      }

      return null;
    } catch (err) {
      console.error(`[DouyuChecker] 解析真实房间ID失败 (${shortId}):`, err.message);
      return null;
    }
  }

  async getRoomStatus(rid) {
    try {
      const url = `${DOYU_API_BASE}/betard/${rid}`;
      const data = await PlatformChecker.fetchJson(url, {
        headers: {
          Referer: `${DOYU_API_BASE}/${rid}`,
        },
      });

      if (!data) return null;

      const room = data.data || data.room;
      if (!room) return null;

      return {
        roomName: room.owner_name || '',
        roomTitle: room.room_name || '',
        roomCover: room.room_pic || '',
        status: room.show_status,
        videoLoop: room.videoLoop || 0,
        isVip: room.isVip === 1,
      };
    } catch (err) {
      console.error(`[DouyuChecker] 获取房间状态失败 (${rid}):`, err.message);
      return null;
    }
  }

  isVideoLoop(roomData) {
    return roomData?.videoLoop === 1;
  }

  /**
   * 检测是否为互动游戏（非直播内容）
   */
  async isInteractiveGame(rid) {
    if (!this.options.detectInteractiveGame) {
      return false;
    }

    try {
      const url = `${DOYU_API_BASE}/api/interactive/web/v2/list?rid=${rid}`;
      const data = await PlatformChecker.fetchJson(url, {
        headers: {
          Referer: `${DOYU_API_BASE}/${rid}`,
        },
      });

      const giftInfo = data?.data;
      return giftInfo && Object.keys(giftInfo).length > 0;
    } catch (err) {
      console.warn(`[DouyuChecker] 互动游戏检测失败 (${rid}):`, err.message);
      return false;
    }
  }

  /**
   * 构建播放信息请求参数
   */
  buildPlayQuery(rid) {
    return {
      cdn: this.options.cdn,
      rate: String(this.options.rate),
      ver: 'Douyu_new',
      iar: '0',
      ive: '0',
      rid: String(rid),
      hevc: '0',
      fa: '0',
      sov: '0',
    };
  }

  async getStreamUrl(rid, signParams) {
    if (!signParams) {
      return null;
    }

    const query = this.buildPlayQuery(rid);
    let attempt = 0;

    // 尝试获取流地址，自动避开 scdn（最多重试 1 次）
    while (attempt < 2) {
      try {
        const streamData = await this._fetchStreamUrl(rid, signParams, query);

        if (!streamData) {
          return null;
        }

        // 检测是否为 scdn，如果是则切换 CDN 重试
        if (streamData.rtmp_cdn?.startsWith('scdn') && attempt < 1) {
          const availableCdns = streamData.cdnsWithName || [];
          // 选择一个非 scdn 且不同于当前 CDN 的选项
          const newCdn = availableCdns.find((c) => !c.cdn?.startsWith('scdn') && c.cdn !== query.cdn)?.cdn;
          if (newCdn) {
            console.log(`[DouyuChecker] 检测到 scdn，切换 CDN: ${query.cdn} -> ${newCdn}`);
            query.cdn = newCdn;
            attempt++;
            continue;
          }
        }

        const rtmpUrl = streamData.rtmp_url;
        const rtmpLive = streamData.rtmp_live;

        if (!rtmpUrl || !rtmpLive) {
          console.error('[DouyuChecker] 流地址参数不完整');
          return null;
        }

        // 判断流类型
        const streamUrl = `${rtmpUrl}/${rtmpLive}`;
        const format = streamUrl.includes('.m3u8') || rtmpLive.includes('.m3u8') ? 'hls' : 'flv';

        return {
          streamUrl,
          format,
          cdn: streamData.rtmp_cdn,
          rate: streamData.rate,
        };
      } catch (err) {
        console.error(`[DouyuChecker] 获取流地址异常 (${rid}):`, err.message);
        return null;
      }
    }

    return null;
  }

  async _fetchStreamUrl(rid, signParams, query) {
    const { did, time, sign, enc_data } = signParams;

    // 构建请求体
    const bodyParams = new URLSearchParams({
      did,
      rid: String(rid),
      ...query,
    });

    // 如果有完整签名参数，添加到请求
    if (enc_data) {
      bodyParams.append('enc_data', enc_data);
      bodyParams.append('tt', time);
      bodyParams.append('auth', sign);
    }

    const url = `${DOYU_PLAY_API}/lapi/live/hlsH5Preview/${rid}`;

    const data = await PlatformChecker.fetchJson(url, {
      method: 'POST',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        rid: String(rid),
        time,
        auth: sign,
      },
      body: bodyParams.toString(),
    });

    if (!data || data.error !== 0 || !data.data) {
      console.error(`[DouyuChecker] 获取流地址失败: ${data?.msg || '未知错误'}`);
      return null;
    }

    return data.data;
  }

  async checkStatus() {
    const roomId = this.getRoomId();

    if (!roomId) {
      return PlatformChecker.normalizeResult({ error: '无法解析房间号' });
    }

    try {
      const realRoomId = await this.resolveRealRoomId(roomId);

      if (!realRoomId) {
        return PlatformChecker.normalizeResult({ error: '无法解析真实房间ID' });
      }

      const roomStatus = await this.getRoomStatus(realRoomId);

      if (!roomStatus) {
        return PlatformChecker.normalizeResult({ error: '无法获取房间状态' });
      }

      // 检查是否开播
      if (roomStatus.status !== 1) {
        return PlatformChecker.normalizeResult({
          isLive: false,
          roomName: roomStatus.roomName,
          roomTitle: roomStatus.roomTitle,
          roomCover: roomStatus.roomCover,
        });
      }

      // 检查是否录播
      if (this.isVideoLoop(roomStatus)) {
        return PlatformChecker.normalizeResult({
          isLive: false,
          roomName: roomStatus.roomName,
          roomTitle: roomStatus.roomTitle,
          roomCover: roomStatus.roomCover,
          error: '当前为录播回放',
        });
      }

      // 检查是否为互动游戏
      const isGame = await this.isInteractiveGame(realRoomId);
      if (isGame) {
        return PlatformChecker.normalizeResult({
          isLive: false,
          roomName: roomStatus.roomName,
          roomTitle: roomStatus.roomTitle,
          roomCover: roomStatus.roomCover,
          error: '当前为互动游戏',
        });
      }

      // 获取签名（VIP 房间优先使用 JS 签名）
      let signParams = null;
      if (roomStatus.isVip) {
        try {
          const jsCode = await fetchVipJsCode(realRoomId);
          signParams = await getVipSignParams(realRoomId, jsCode);
        } catch (err) {
          console.warn(`[DouyuChecker] VIP 签名失败，降级到普通签名: ${err.message}`);
        }
      }

      if (!signParams) {
        signParams = await getSignParams(realRoomId);
      }

      if (!signParams) {
        return PlatformChecker.normalizeResult({
          isLive: true,
          recordable: false,
          roomName: roomStatus.roomName,
          roomTitle: roomStatus.roomTitle,
          roomCover: roomStatus.roomCover,
          error: '签名获取失败',
        });
      }

      const streamData = await this.getStreamUrl(realRoomId, signParams);

      if (!streamData) {
        return PlatformChecker.normalizeResult({
          isLive: true,
          recordable: false,
          roomName: roomStatus.roomName,
          roomTitle: roomStatus.roomTitle,
          roomCover: roomStatus.roomCover,
          error: '无法获取流地址',
        });
      }

      return PlatformChecker.normalizeResult({
        isLive: true,
        roomName: roomStatus.roomName,
        roomTitle: roomStatus.roomTitle,
        roomCover: roomStatus.roomCover,
        streamUrl: streamData.streamUrl,
        streamInfo: {
          format: streamData.format,
          cdn: streamData.cdn,
          rate: streamData.rate,
          isFallback: signParams._fallback,
        },
      });
    } catch (err) {
      console.error(`[DouyuChecker] 检查失败 (${this.roomUrl}):`, err.message);
      return PlatformChecker.normalizeResult({ error: err.message });
    }
  }
}

module.exports = DouyuChecker;
