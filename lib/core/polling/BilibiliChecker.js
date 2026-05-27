const PlatformChecker = require('./PlatformChecker');

const BILIBILI_API_BASE = 'https://api.live.bilibili.com';

class BilibiliChecker extends PlatformChecker {
  constructor(roomUrl) {
    super(roomUrl);
    this._roomId = null;
  }

  static getPlatformId() {
    return 'bilibili';
  }

  static canHandleUrl(url) {
    return /live\.bilibili\.com/i.test(url);
  }

  getRoomId() {
    if (this._roomId) return this._roomId;
    const roomId = PlatformChecker.extractLastPathSegment(this.roomUrl);
    if (roomId) {
      this._roomId = roomId.split('?')[0].split('#')[0];
    }
    return this._roomId;
  }

  async getRoomInit(roomId) {
    const data = await PlatformChecker.fetchJson(`${BILIBILI_API_BASE}/room/v1/Room/room_init?id=${roomId}`, {
      headers: {
        Origin: 'https://live.bilibili.com',
        Referer: `https://live.bilibili.com/${roomId}`,
      },
    });

    if (data.code !== 0 || !data.data) {
      throw new Error(`room_init API 错误: ${data.message}`);
    }

    return {
      roomId: String(data.data.room_id),
      uid: data.data.uid,
      liveStatus: data.data.live_status === 1,
      shortId: String(roomId),
    };
  }

  async getAnchorInfo(uid) {
    const data = await PlatformChecker.fetchJson(`${BILIBILI_API_BASE}/live_user/v1/Master/info?uid=${uid}`, {
      headers: {
        Origin: 'https://live.bilibili.com',
        Referer: 'https://live.bilibili.com',
      },
    });

    if (data.code !== 0 || !data.data) {
      return { anchorName: '' };
    }

    return {
      anchorName: data.data.info?.uname || '',
    };
  }

  async getRoomTitle(roomId) {
    const data = await PlatformChecker.fetchJson(
      `${BILIBILI_API_BASE}/xlive/web-room/v1/index/getH5InfoByRoom?room_id=${roomId}`,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 11; SAMSUNG SM-G973U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36',
          Origin: 'https://live.bilibili.com',
          Referer: `https://live.bilibili.com/${roomId}`,
        },
      }
    );

    if (data.code !== 0 || !data.data) {
      return { title: '', cover: '' };
    }

    return {
      title: data.data.room_info?.title || '',
      cover: data.data.room_info?.cover || '',
    };
  }

  async getStreamUrl(roomId) {
    const params = new URLSearchParams({
      cid: roomId,
      qn: '10000',
      platform: 'web',
    });

    const data = await PlatformChecker.fetchJson(
      `${BILIBILI_API_BASE}/room/v1/Room/playUrl?${params.toString()}`,
      {
        headers: {
          Origin: 'https://live.bilibili.com',
          Referer: `https://live.bilibili.com/${roomId}`,
        },
      }
    );

    if (data.code !== 0 || !data.data?.durl?.length) {
      return this.getStreamUrlV2(roomId);
    }

    const durls = data.data.durl;
    for (const durl of durls) {
      if (durl.url.includes('d1--cn-gotcha')) {
        return { streamUrl: durl.url, format: 'flv' };
      }
    }

    return { streamUrl: durls[durls.length - 1].url, format: 'flv' };
  }

  async getStreamUrlV2(roomId) {
    const params = new URLSearchParams({
      room_id: roomId,
      protocol: '0,1',
      format: '0,1,2',
      codec: '0,1,2',
      qn: '10000',
      platform: 'web',
      ptype: '8',
      dolby: '5',
      panorama: '1',
      hdr_type: '0,1',
    });

    const data = await PlatformChecker.fetchJson(
      `${BILIBILI_API_BASE}/xlive/web-room/v2/index/getRoomPlayInfo?${params.toString()}`,
      {
        headers: {
          Origin: 'https://live.bilibili.com',
          Referer: `https://live.bilibili.com/${roomId}`,
        },
      }
    );

    if (data.code !== 0 || !data.data?.playurl_info) {
      return { streamUrl: null, format: null };
    }

    if (data.data.live_status === 0) {
      return { streamUrl: null, format: null };
    }

    const playurl = data.data.playurl_info.playurl;
    const stream = playurl?.stream?.[0];
    const codecList = stream?.format?.[0]?.codec;

    if (!codecList || !Array.isArray(codecList) || codecList.length === 0) {
      return { streamUrl: null, format: null };
    }

    const sortedCodecs = [...codecList].sort((a, b) => b.current_qn - a.current_qn);
    const selectedCodec = sortedCodecs[0];
    const baseUrl = selectedCodec.base_url;
    const host = selectedCodec.url_info?.[0]?.host || '';
    const extra = selectedCodec.url_info?.[0]?.extra || '';

    if (!host || !baseUrl) {
      return { streamUrl: null, format: null };
    }

    const streamUrl = host + baseUrl + extra;
    const format = baseUrl.includes('.m3u8') ? 'hls' : 'flv';

    return { streamUrl, format };
  }

  async checkStatus() {
    const roomId = this.getRoomId();

    if (!roomId) {
      return PlatformChecker.normalizeResult({ error: '无法解析房间号' });
    }

    try {
      const initData = await this.getRoomInit(roomId);
      const { roomId: realRoomId, uid, liveStatus } = initData;

      const [anchorData, titleData] = await Promise.all([
        this.getAnchorInfo(uid),
        this.getRoomTitle(realRoomId),
      ]);

      if (!liveStatus) {
        return PlatformChecker.normalizeResult({
          isLive: false,
          roomName: anchorData.anchorName,
          roomTitle: titleData.title,
          roomCover: titleData.cover,
        });
      }

      const { streamUrl, format } = await this.getStreamUrl(realRoomId);

      return PlatformChecker.normalizeResult({
        isLive: true,
        roomName: anchorData.anchorName,
        roomTitle: titleData.title,
        roomCover: titleData.cover,
        streamUrl,
        streamInfo: streamUrl ? { format } : null,
      });
    } catch (err) {
      console.error(`[BilibiliChecker] 检查失败 (${this.roomUrl}):`, err.message);
      return PlatformChecker.normalizeResult({ error: err.message });
    }
  }
}

module.exports = BilibiliChecker;
