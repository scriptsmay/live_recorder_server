const PlatformChecker = require('./PlatformChecker');

const HUYA_MP_BASE_URL = 'https://mp.huya.com';
const HUYA_WEB_BASE_URL = 'https://www.huya.com';
const HUYA_WEB_ROOM_DATA_REGEX = /var\s+TT_ROOM_DATA\s*=\s*(.*);/;

// CDN 优先级（参考 DouyinLiveRecorder）
const CDN_PRIORITY = ['TX', 'HW', 'HS', 'AL'];

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
      // 注意：必须使用桌面 User-Agent，iOS UA 会返回移动端页面（不含 TT_ROOM_DATA）
      const response = await fetch(`${HUYA_WEB_BASE_URL}/${roomId}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
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

  /**
   * 从微信小程序 API 获取流地址（参考 DouyinLiveRecorder 实现）
   * 关键点：
   * 1. 使用 iOS User-Agent
   * 2. 使用 HTTP 协议而非 HTTPS
   * 3. 使用原始 antiCode，不重新签名
   * 4. TX CDN 需要特殊处理 URL 参数
   */
  async getStreamFromMpApi() {
    try {
      const roomId = await this.resolveRealRoomId();
      if (!roomId) {
        console.error('[HuyaChecker] 无法获取房间ID');
        return null;
      }

      // 参考 DouyinLiveRecorder：使用微信小程序 API
      const params = new URLSearchParams({
        m: 'Live',
        do: 'profileRoom',
        roomid: roomId,
        showSecret: '1',
      });

      // 参考 DouyinLiveRecorder：使用 iOS User-Agent
      const response = await fetch(`${HUYA_MP_BASE_URL}/cache.php?${params}`, {
        headers: {
          'User-Agent': 'ios/7.830 (ios 17.0; ; iPhone 15 (A2846/A2847/A2848/A2849))',
          xweb_xhr: '1',
          referer: 'https://servicewechat.com/wx74767bf0b684f7d3/301/page-frame.html',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (data.status !== 200) {
        console.error(`[HuyaChecker] API 返回错误:`, data.message);
        return null;
      }

      const liveData = data.data;
      const isLive = liveData.realLiveStatus === 'ON';
      const anchorName = liveData.profileInfo?.nick || '';
      const liveTitle = liveData.liveData?.introduction || '';

      if (!isLive) {
        return {
          isLive: false,
          anchorName,
          liveTitle,
        };
      }

      // 获取流信息列表
      const baseSteamInfoList = liveData.stream?.baseSteamInfoList || [];
      if (!baseSteamInfoList || baseSteamInfoList.length === 0) {
        console.warn('[HuyaChecker] 未找到流信息');
        return null;
      }

      // 构建播放 URL 列表
      const playUrlList = [];
      for (const stream of baseSteamInfoList) {
        const cdnType = stream.sCdnType;
        const streamName = stream.sStreamName;
        const sFlvUrl = stream.sFlvUrl;
        const flvAntiCode = stream.sFlvAntiCode;

        // 参考 DouyinLiveRecorder：使用原始 antiCode，不重新签名
        const flvUrl = `${sFlvUrl}/${streamName}.flv?${flvAntiCode}`;

        playUrlList.push({
          cdnType,
          flvUrl,
        });
      }

      // 参考 DouyinLiveRecorder：按优先级选择 CDN
      let selectedFlvUrl = null;
      let selectedCdnType = null;

      for (const cdn of CDN_PRIORITY) {
        for (const item of playUrlList) {
          if (item.cdnType === cdn) {
            selectedFlvUrl = item.flvUrl;
            selectedCdnType = cdn;
            break;
          }
        }
        if (selectedFlvUrl) {
          break;
        }
      }

      if (!selectedFlvUrl) {
        // 如果没有找到优先的 CDN，使用第一个
        selectedFlvUrl = playUrlList[0]?.flvUrl;
        selectedCdnType = playUrlList[0]?.cdnType;
      }

      if (!selectedFlvUrl) {
        console.error('[HuyaChecker] 未找到可用的流地址');
        return null;
      }

      // 参考 DouyinLiveRecorder：使用 HTTP 而不是 HTTPS
      let flvUrl = selectedFlvUrl.replace('https://', 'http://');

      // 参考 DouyinLiveRecorder：TX CDN 特殊处理
      if (selectedCdnType === 'TX') {
        flvUrl = flvUrl.replace(/&ctype=(tars_mp|huya_live)/, '&ctype=huya_webh5').replace('&fs=bhct', '&fs=bgct');
        console.log(`[HuyaChecker] 应用 TX CDN 特殊处理`);
      }

      console.log(`[HuyaChecker] 获取流地址 (${selectedCdnType}): ${flvUrl.slice(0, 120)}...`);

      return {
        isLive: true,
        anchorName,
        liveTitle,
        streamUrl: flvUrl,
        cdnType: selectedCdnType,
      };
    } catch (err) {
      console.error(`[HuyaChecker] 从 API 获取流地址失败:`, err.message);
      return null;
    }
  }

  async checkStatus() {
    // 使用微信小程序 API 获取流地址（参考 DouyinLiveRecorder）
    const streamData = await this.getStreamFromMpApi();

    if (!streamData) {
      return { isLive: false, error: '无法获取流信息' };
    }

    return {
      isLive: streamData.isLive,
      roomName: streamData.anchorName,
      roomTitle: streamData.liveTitle,
      roomCover: '',
      streamUrl: streamData.streamUrl,
      streamInfo: streamData.isLive ? { cdnType: streamData.cdnType } : null,
    };
  }
}

module.exports = HuyaChecker;
