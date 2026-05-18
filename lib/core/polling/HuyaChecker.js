const PlatformChecker = require('./PlatformChecker');
const crypto = require('crypto');

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

  md5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
  }

  getAntiCode(oldAntiCode, streamName) {
    const paramsT = 100;
    const sdkVersion = 2403051612;

    const t13 = Date.now() * 1000;
    const sdkSid = t13;

    const initUuid = Math.floor(((t13 % 10000000000) * 1000 + Math.random() * 1000) % 4294967295);
    const uid = Math.floor(Math.random() * 1000000000) + 1400000000000;
    const seqId = uid + sdkSid;

    const targetUnixTime = Math.floor((t13 + 110624) / 1000);
    const wsTime = targetUnixTime.toString(16).toLowerCase();

    const urlQuery = new URLSearchParams(oldAntiCode);
    const fm = urlQuery.get('fm') || '';
    const decodedFm = Buffer.from(decodeURIComponent(fm), 'base64').toString();
    const wsSecretPf = decodedFm.split('_')[0];

    const ctype = urlQuery.get('ctype') || '';
    const wsSecretHash = this.md5(`${seqId}|${ctype}|${paramsT}`);
    const wsSecret = `${wsSecretPf}_${uid}_${streamName}_${wsSecretHash}_${wsTime}`;
    const wsSecretMd5 = this.md5(wsSecret);

    const newAntiCodeParams = new URLSearchParams({
      wsSecret: wsSecretMd5,
      wsTime: wsTime,
      seqid: seqId,
      ctype: ctype,
      ver: '1',
      fs: urlQuery.get('fs') || '',
      uuid: initUuid,
      u: uid,
      t: paramsT,
      sv: sdkVersion,
      sdk_sid: sdkSid,
      codec: '264',
    });

    return newAntiCodeParams.toString();
  }

  getQualityRatio(antiCode, quality = 'UHD') {
    const qualityOptions = {
      UHD: 0,
      HD: 1,
      SD: 2,
      LD: 3,
    };

    if (quality === 'OD' || quality === 'BD') {
      return '';
    }

    const exsphdMatch = antiCode.match(/exsphd=([^&]*)/);
    if (!exsphdMatch) {
      return '';
    }

    const exsphd = exsphdMatch[1];
    const pattern = /(?<=264_)\d+/g;
    const qualityList = [];
    let match;
    while ((match = pattern.exec(exsphd)) !== null) {
      qualityList.push(match[0]);
    }
    qualityList.reverse();

    while (qualityList.length < 5) {
      if (qualityList.length > 0) {
        qualityList.push(qualityList[qualityList.length - 1]);
      } else {
        qualityList.push('0');
      }
    }

    const qualityIndex = qualityOptions[quality] || 0;
    if (qualityList[qualityIndex]) {
      return qualityList[qualityIndex];
    }

    return '';
  }

  extractStreamUrl(liveData) {
    try {
      const streamInfoList = liveData.stream?.baseSteamInfoList || liveData.gameStreamInfoList || [];
      if (!streamInfoList || streamInfoList.length === 0) {
        console.warn('[HuyaChecker] 未找到 streamInfoList');
        return null;
      }

      const selectCdn = streamInfoList[0];
      const flvUrl = selectCdn.sFlvUrl;
      const streamName = selectCdn.sStreamName;
      const flvUrlSuffix = selectCdn.sFlvUrlSuffix;
      const flvAntiCode = selectCdn.sFlvAntiCode;

      if (!flvUrl || !streamName || !flvUrlSuffix || !flvAntiCode) {
        console.warn('[HuyaChecker] 流信息不完整');
        return null;
      }

      const cleanStreamName = streamName.replace('-imgplus', '');
      const newAntiCode = this.getAntiCode(flvAntiCode, cleanStreamName);
      const qualityRatio = this.getQualityRatio(flvAntiCode, 'UHD');

      const fullFlvUrl = `${flvUrl}/${cleanStreamName}.${flvUrlSuffix}?${newAntiCode}&ratio=${qualityRatio}`;
      console.log(`[HuyaChecker] 构建虎牙流地址: ${fullFlvUrl.slice(0, 120)}...`);

      return fullFlvUrl;
    } catch (err) {
      console.error(`[HuyaChecker] 提取虎牙直播流地址失败:`, err.message);
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
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
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

      const streamUrl = isLive ? this.extractStreamUrl(liveData) : null;

      return {
        isLive,
        roomName: liveData.liveData?.nick || liveData.nick || '',
        roomTitle: liveData.liveData?.introduction || liveData.introduction || '',
        roomCover: liveData.liveData?.screenshot || liveData.screenshot || '',
        streamUrl: streamUrl,
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
