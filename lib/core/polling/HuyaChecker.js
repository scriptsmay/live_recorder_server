const PlatformChecker = require('./PlatformChecker');

const HUYA_MP_BASE_URL = 'https://mp.huya.com';
const HUYA_WEB_BASE_URL = 'https://www.huya.com';
const HUYA_WEB_ROOM_DATA_REGEX = /var\s+TT_ROOM_DATA\s*=\s*(.*);/;

class HuyaChecker extends PlatformChecker {
  constructor(roomUrl) {
    super(roomUrl);
    this._roomId = null;
  }

  static getPlatformId() {
    return 'huya';
  }

  static canHandleUrl(url) {
    return /huya\.com/i.test(url);
  }

  getRoomId() {
    if (this._roomId) return this._roomId;
    const match = this.roomUrl.match(/huya\.com\/([^/?#]+)/i);
    if (match) {
      this._roomId = match[1].split('?')[0].split('#')[0];
    }
    return this._roomId;
  }

  async resolveRealRoomId() {
    const roomId = this.getRoomId();
    if (!roomId) return null;

    if (/^\d+$/.test(roomId)) {
      return roomId;
    }

    try {
      const response = await fetch(`${HUYA_WEB_BASE_URL}/${roomId}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();
      const match = html.match(HUYA_WEB_ROOM_DATA_REGEX);
      if (match) {
        try {
          const roomData = JSON.parse(match[1]);
          if (roomData?.profileRoom) {
            return String(roomData.profileRoom);
          }
        } catch (e) {
          console.error(`[HuyaChecker] 解析 roomData 失败:`, e.message);
        }
      }

      throw new Error('未找到 profileRoom');
    } catch (err) {
      console.error(`[HuyaChecker] 解析真实 roomId 失败 (${this.roomUrl}):`, err.message);
      return null;
    }
  }

  async checkStatus() {
    const roomId = await this.resolveRealRoomId();
    if (!roomId) {
      return { isLive: false, error: '无法获取房间ID' };
    }

    try {
      const params = new URLSearchParams({
        m: 'Live',
        do: 'profileRoom',
        roomid: roomId,
        showSecret: '1',
      });

      const response = await fetch(`${HUYA_MP_BASE_URL}/cache.php?${params}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: `${HUYA_MP_BASE_URL}/`,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (data.status !== 200) {
        return { isLive: false, error: data.message || 'API 返回错误' };
      }

      const liveData = data.data;
      const isLive = liveData.liveStatus === 'ON';

      return {
        isLive,
        roomName: liveData.liveData?.nick || liveData.nick || '',
        roomTitle: liveData.liveData?.introduction || liveData.introduction || '',
        roomCover: liveData.liveData?.screenshot || liveData.screenshot || '',
        streamInfo: isLive ? this.extractStreamInfo(liveData) : null,
      };
    } catch (err) {
      console.error(`[HuyaChecker] 检查状态失败 (${this.roomUrl}):`, err.message);
      return { isLive: false, error: err.message };
    }
  }

  extractStreamInfo(liveData) {
    try {
      const stream = liveData.stream?.baseSteamInfoList || liveData.gameStreamInfoList || [];
      const bitRateInfo = liveData.liveData?.bitRateInfo ? JSON.parse(liveData.liveData.bitRateInfo) : [];

      if (stream.length === 0) {
        return null;
      }

      return {
        streams: stream,
        bitRateInfo: bitRateInfo,
        maxBitrate: liveData.liveData?.bitRate || liveData.bitRate || 0,
      };
    } catch (err) {
      console.error(`[HuyaChecker] 解析流信息失败:`, err.message);
      return null;
    }
  }
}

module.exports = HuyaChecker;
