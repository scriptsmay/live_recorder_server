const PlatformChecker = require('./PlatformChecker');
const { getSignParams } = require('./signers/douyu');

const DOYU_API_BASE = 'https://www.douyu.com';
const DOYU_MOBILE_API = 'https://m.douyu.com';

class DouyuChecker extends PlatformChecker {
  constructor(roomUrl) {
    super(roomUrl);
    this._roomId = null;
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

      if (!data || !data.data) {
        return null;
      }

      return {
        roomName: data.data.owner_name || '',
        roomTitle: data.data.room_name || '',
        roomCover: data.data.room_pic || '',
        status: data.data.show_status,
        videoLoop: data.data.videoLoop || 0,
      };
    } catch (err) {
      console.error(`[DouyuChecker] 获取房间状态失败 (${rid}):`, err.message);
      return null;
    }
  }

  isVideoLoop(roomData) {
    return roomData?.videoLoop === 1;
  }

  async getStreamUrl(rid, signParams) {
    if (!signParams) {
      return null;
    }

    try {
      const { v, did, tt, sign } = signParams;
      const url = `${DOYU_API_BASE}/lapi/live/getH5Play/${rid}`;

      const params = new URLSearchParams({
        rid,
        did,
        tt,
        v,
        sign,
      });

      const data = await PlatformChecker.fetchJson(`${url}?${params.toString()}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: `${DOYU_API_BASE}/${rid}`,
        },
      });

      if (!data || data.error !== 0 || !data.data) {
        console.error(`[DouyuChecker] 获取流地址失败: ${data?.msg || '未知错误'}`);
        return null;
      }

      const streamData = data.data;
      const rtmpUrl = streamData.rtmp_url;
      const rtmpLive = streamData.rtmp_live;

      if (!rtmpUrl || !rtmpLive) {
        console.error('[DouyuChecker] 流地址参数不完整');
        return null;
      }

      let streamUrl = `${rtmpUrl}/${rtmpLive}`;

      if (streamData.rtmp_live_url) {
        streamUrl = streamData.rtmp_live_url;
      }

      return {
        streamUrl,
        format: 'flv',
      };
    } catch (err) {
      console.error(`[DouyuChecker] 获取流地址异常 (${rid}):`, err.message);
      return null;
    }
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

      if (roomStatus.status !== 1 || this.isVideoLoop(roomStatus)) {
        return PlatformChecker.normalizeResult({
          isLive: false,
          roomName: roomStatus.roomName,
          roomTitle: roomStatus.roomTitle,
          roomCover: roomStatus.roomCover,
        });
      }

      const signParams = await getSignParams(realRoomId);

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
        streamInfo: { format: streamData.format },
      });
    } catch (err) {
      console.error(`[DouyuChecker] 检查失败 (${this.roomUrl}):`, err.message);
      return PlatformChecker.normalizeResult({ error: err.message });
    }
  }
}

module.exports = DouyuChecker;
