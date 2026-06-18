const PlatformChecker = require('../server/lib/core/polling/PlatformChecker');
const DouyuChecker = require('../server/lib/core/polling/DouyuChecker');
const { getSignParams } = require('../server/lib/core/polling/signers/douyu');

jest.spyOn(PlatformChecker, 'fetchJson').mockImplementation(jest.fn());
jest.spyOn(PlatformChecker, 'fetchText').mockImplementation(jest.fn());
jest.spyOn(PlatformChecker, 'extractLastPathSegment').mockImplementation((url) => {
  const match = url.match(/douyu\.com\/([^/?#]+)/i);
  return match ? match[1] : null;
});
jest.spyOn(PlatformChecker, 'normalizeResult').mockImplementation((partial) => ({
  isLive: partial.isLive ?? false,
  recordable: partial.recordable ?? true,
  roomName: partial.roomName ?? '',
  roomTitle: partial.roomTitle ?? '',
  roomCover: partial.roomCover ?? '',
  streamUrl: partial.streamUrl ?? null,
  streamInfo: partial.streamInfo ?? null,
  error: partial.error ?? null,
}));

jest.mock('../server/lib/core/polling/signers/douyu', () => ({
  getSignParams: jest.fn(),
}));

describe('DouyuChecker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('静态方法', () => {
    it('should return correct platform id', () => {
      expect(DouyuChecker.getPlatformId()).toBe('douyu');
    });

    it('should handle douyu.com URLs', () => {
      expect(DouyuChecker.canHandleUrl('https://www.douyu.com/123456')).toBe(true);
      expect(DouyuChecker.canHandleUrl('https://www.douyu.com/room/123456')).toBe(true);
      expect(DouyuChecker.canHandleUrl('https://m.douyu.com/123456')).toBe(true);
    });

    it('should not handle non-douyu URLs', () => {
      expect(DouyuChecker.canHandleUrl('https://www.huya.com/123456')).toBe(false);
      expect(DouyuChecker.canHandleUrl('https://live.bilibili.com/123456')).toBe(false);
    });
  });

  describe('构造函数', () => {
    it('should use default options', () => {
      const checker = new DouyuChecker('https://www.douyu.com/123456');
      expect(checker.options).toEqual({
        cdn: 'hw-h5',
        rate: 0,
        detectInteractiveGame: false,
      });
    });

    it('should accept custom options', () => {
      const checker = new DouyuChecker('https://www.douyu.com/123456', {
        cdn: 'tct',
        rate: 0,
        detectInteractiveGame: true,
      });
      expect(checker.options.cdn).toBe('tct');
      expect(checker.options.detectInteractiveGame).toBe(true);
    });
  });

  describe('getRoomId', () => {
    it('should extract room id from URL', () => {
      const checker = new DouyuChecker('https://www.douyu.com/123456');
      expect(checker.getRoomId()).toBe('123456');
    });

    it('should strip query parameters from room id', () => {
      const checker = new DouyuChecker('https://www.douyu.com/123456?from=abc');
      expect(checker.getRoomId()).toBe('123456');
    });

    it('should cache room id', () => {
      const checker = new DouyuChecker('https://www.douyu.com/123456');
      checker.getRoomId();
      checker.getRoomId();
      expect(PlatformChecker.extractLastPathSegment).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveRealRoomId', () => {
    it('should return numeric room id as-is', async () => {
      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.resolveRealRoomId('123456');
      expect(result).toBe('123456');
    });

    it('should resolve short id to numeric id', async () => {
      PlatformChecker.fetchText.mockResolvedValue('<html><script>room_id:999999</script></html>');
      const checker = new DouyuChecker('https://www.douyu.com/shortname');
      const result = await checker.resolveRealRoomId('shortname');
      expect(result).toBe('999999');
    });

    it('should return null on resolution failure', async () => {
      PlatformChecker.fetchText.mockResolvedValue('<html></html>');
      const checker = new DouyuChecker('https://www.douyu.com/shortname');
      const result = await checker.resolveRealRoomId('shortname');
      expect(result).toBeNull();
    });
  });

  describe('getRoomStatus', () => {
    it('should return room status correctly', async () => {
      const mockData = {
        data: {
          owner_name: 'TestAnchor',
          room_name: 'Test Title',
          room_pic: 'https://example.com/cover.jpg',
          show_status: 1,
          videoLoop: 0,
          isVip: 0,
        },
      };
      PlatformChecker.fetchJson.mockResolvedValue(mockData);

      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.getRoomStatus('123456');

      expect(result).toEqual({
        roomName: 'TestAnchor',
        roomTitle: 'Test Title',
        roomCover: 'https://example.com/cover.jpg',
        status: 1,
        videoLoop: 0,
        isVip: false,
      });
    });

    it('should detect VIP rooms', async () => {
      const mockData = {
        data: {
          owner_name: 'VipAnchor',
          room_name: 'VIP Room',
          room_pic: 'https://example.com/cover.jpg',
          show_status: 1,
          videoLoop: 0,
          isVip: 1,
        },
      };
      PlatformChecker.fetchJson.mockResolvedValue(mockData);

      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.getRoomStatus('123456');

      expect(result.isVip).toBe(true);
    });

    it('should return null on API failure', async () => {
      PlatformChecker.fetchJson.mockRejectedValue(new Error('Network error'));
      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.getRoomStatus('123456');
      expect(result).toBeNull();
    });
  });

  describe('isVideoLoop', () => {
    it('should detect video loop', () => {
      const checker = new DouyuChecker('https://www.douyu.com/123456');
      expect(checker.isVideoLoop({ videoLoop: 1 })).toBe(true);
      expect(checker.isVideoLoop({ videoLoop: 0 })).toBe(false);
    });
  });

  describe('isInteractiveGame', () => {
    it('should return false when disabled', async () => {
      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.isInteractiveGame('123456');
      expect(result).toBe(false);
    });

    it('should detect interactive games when enabled', async () => {
      PlatformChecker.fetchJson.mockResolvedValue({ data: { gift: 'info' } });
      const checker = new DouyuChecker('https://www.douyu.com/123456', { detectInteractiveGame: true });
      const result = await checker.isInteractiveGame('123456');
      expect(result).toBe(true);
    });

    it('should return false when no interactive game data', async () => {
      PlatformChecker.fetchJson.mockResolvedValue({ data: {} });
      const checker = new DouyuChecker('https://www.douyu.com/123456', { detectInteractiveGame: true });
      const result = await checker.isInteractiveGame('123456');
      expect(result).toBe(false);
    });

    it('should return false on API failure', async () => {
      PlatformChecker.fetchJson.mockRejectedValue(new Error('Network error'));
      const checker = new DouyuChecker('https://www.douyu.com/123456', { detectInteractiveGame: true });
      const result = await checker.isInteractiveGame('123456');
      expect(result).toBe(false);
    });
  });

  describe('buildPlayQuery', () => {
    it('should build query with default options', () => {
      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const query = checker.buildPlayQuery('123456');
      expect(query).toEqual({
        cdn: 'hw-h5',
        rate: '0',
        ver: 'Douyu_new',
        ive: '0',
        hevc: '0',
        fa: '0',
      });
    });

    it('should use custom CDN and rate', () => {
      const checker = new DouyuChecker('https://www.douyu.com/123456', { cdn: 'tct', rate: 0 });
      const query = checker.buildPlayQuery('123456');
      expect(query.cdn).toBe('tct');
      expect(query.rate).toBe('0');
    });
  });

  describe('getStreamUrl', () => {
    it('should return stream url with format detection (flv)', async () => {
      const mockData = {
        error: 0,
        data: {
          rtmp_url: 'rtmp://hdltctwk.douyucdn.cn/live',
          rtmp_live: '12345678abcdef_0',
          rtmp_cdn: 'hw-h5',
          rate: 0,
        },
      };
      PlatformChecker.fetchJson.mockResolvedValue(mockData);

      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.getStreamUrl('123456', {
        did: '10000000000000000000000000001501',
        rid: '123456',
        time: '1234567890',
        sign: 'abc',
      });

      expect(result).toEqual({
        streamUrl: 'rtmp://hdltctwk.douyucdn.cn/live/12345678abcdef_0',
        format: 'flv',
        cdn: 'hw-h5',
        rate: 0,
      });
    });

    it('should detect HLS format from m3u8 URL', async () => {
      const mockData = {
        error: 0,
        data: {
          rtmp_url: 'http://example.com/live',
          rtmp_live: 'stream.m3u8',
          rtmp_cdn: 'hw-h5',
          rate: 0,
        },
      };
      PlatformChecker.fetchJson.mockResolvedValue(mockData);

      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.getStreamUrl('123456', {
        did: '10000000000000000000000000001501',
        rid: '123456',
        time: '1234567890',
        sign: 'abc',
      });

      expect(result.format).toBe('hls');
    });

    it('should switch CDN when scdn detected', async () => {
      const scdnData = {
        rtmp_url: 'rtmp://scdn.example.com/live',
        rtmp_live: '12345678abcdef_0',
        rtmp_cdn: 'scdn-h5',
        rate: 0,
        cdnsWithName: [{ cdn: 'scdn-h5' }, { cdn: 'tct-h5' }],
      };

      const normalData = {
        rtmp_url: 'rtmp://tct.example.com/live',
        rtmp_live: 'stream_54321',
        rtmp_cdn: 'tct-h5',
        rate: 0,
      };

      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const calls = [];
      checker._fetchStreamUrl = async function (rid) {
        calls.push({ rid });
        return calls.length === 1 ? scdnData : normalData;
      };

      const result = await checker.getStreamUrl('123456', {
        did: '10000000000000000000000000001501',
        rid: '123456',
        time: '1234567890',
        sign: 'abc',
      });

      // Should have retried with new CDN
      expect(calls).toHaveLength(2);

      // Verify CDN was switched in options (new API stores cdn in this.options)
      expect(checker.options.cdn).toBe('tct-h5');

      // Should return the result from the second call
      expect(result).not.toBeNull();
      expect(result.cdn).toBe('tct-h5');
      expect(result.streamUrl).toBe('rtmp://tct.example.com/live/stream_54321');
    });

    it('should return null when rtmp_live is missing', async () => {
      const mockData = {
        error: 0,
        data: {
          rtmp_url: 'rtmp://hdltctwk.douyucdn.cn/live',
        },
      };
      PlatformChecker.fetchJson.mockResolvedValue(mockData);

      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.getStreamUrl('123456', {
        did: '10000000000000000000000000001501',
        rid: '123456',
        time: '1234567890',
        sign: 'abc',
      });

      expect(result).toBeNull();
    });

    it('should return null on API failure', async () => {
      PlatformChecker.fetchJson.mockResolvedValue({ error: -1, msg: 'error' });
      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.getStreamUrl('123456', {
        did: '10000000000000000000000000001501',
        rid: '123456',
        time: '1234567890',
        sign: 'abc',
      });
      expect(result).toBeNull();
    });

    it('should return null when signParams is null', async () => {
      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.getStreamUrl('123456', null);
      expect(result).toBeNull();
    });
  });

  describe('checkStatus', () => {
    it('should return error for invalid URL', async () => {
      const checker = new DouyuChecker('https://invalid.url');
      checker.getRoomId = jest.fn().mockReturnValue(null);

      const result = await checker.checkStatus();

      expect(result.error).toBe('无法解析房间号');
    });

    it('should return offline status correctly', async () => {
      PlatformChecker.fetchJson.mockResolvedValue({
        data: {
          owner_name: 'TestAnchor',
          room_name: 'Test Title',
          room_pic: 'https://example.com/cover.jpg',
          show_status: 0,
          videoLoop: 0,
          isVip: 0,
        },
      });

      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.checkStatus();

      expect(result.isLive).toBe(false);
      expect(result.roomName).toBe('TestAnchor');
      expect(result.roomTitle).toBe('Test Title');
    });

    it('should return offline for video loop', async () => {
      PlatformChecker.fetchJson.mockResolvedValue({
        data: {
          owner_name: 'TestAnchor',
          room_name: 'Test Title',
          room_pic: 'https://example.com/cover.jpg',
          show_status: 1,
          videoLoop: 1,
          isVip: 0,
        },
      });

      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.checkStatus();

      expect(result.isLive).toBe(false);
    });

    it('should return live status with stream URL', async () => {
      PlatformChecker.fetchJson
        .mockResolvedValueOnce({
          data: {
            owner_name: 'TestAnchor',
            room_name: 'Test Title',
            room_pic: 'https://example.com/cover.jpg',
            show_status: 1,
            videoLoop: 0,
            isVip: 0,
          },
        })
        .mockResolvedValueOnce({
          error: 0,
          data: {
            rtmp_url: 'rtmp://hdltctwk.douyucdn.cn/live',
            rtmp_live: '12345678abcdef_0',
            rtmp_cdn: 'hw-h5',
            rate: 0,
          },
        });

      getSignParams.mockResolvedValue({
        did: '10000000000000000000000000001501',
        rid: '123456',
        time: '1234567890',
        sign: 'abc',
      });

      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.checkStatus();

      expect(result.isLive).toBe(true);
      expect(result.recordable).toBe(true);
      expect(result.streamUrl).toBe('rtmp://hdltctwk.douyucdn.cn/live/12345678abcdef_0');
      expect(result.streamInfo).toEqual({
        format: 'flv',
        cdn: 'hw-h5',
        rate: 0,
        isFallback: undefined,
      });
    });

    it('should use unified signing for all rooms (VIP rooms included)', async () => {
      PlatformChecker.fetchJson
        .mockResolvedValueOnce({
          data: {
            owner_name: 'VipAnchor',
            room_name: 'VIP Room',
            room_pic: 'https://example.com/cover.jpg',
            show_status: 1,
            videoLoop: 0,
            isVip: 1,
          },
        })
        .mockResolvedValueOnce({
          error: 0,
          data: {
            rtmp_url: 'rtmp://hdltctwk.douyucdn.cn/live',
            rtmp_live: '12345678abcdef_0',
            rtmp_cdn: 'hw-h5',
            rate: 0,
          },
        });

      getSignParams.mockResolvedValue({
        did: '10000000000000000000000000001501',
        rid: '123456',
        time: '1234567890',
        sign: 'abc',
      });

      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.checkStatus();

      expect(getSignParams).toHaveBeenCalledWith('123456');
      expect(result.isLive).toBe(true);
      expect(result.streamUrl).toBe('rtmp://hdltctwk.douyucdn.cn/live/12345678abcdef_0');
    });

    it('should return recordable: false when sign fails', async () => {
      PlatformChecker.fetchJson.mockResolvedValue({
        data: {
          owner_name: 'TestAnchor',
          room_name: 'Test Title',
          room_pic: 'https://example.com/cover.jpg',
          show_status: 1,
          videoLoop: 0,
          isVip: 0,
        },
      });

      getSignParams.mockResolvedValue(null);

      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.checkStatus();

      expect(result.isLive).toBe(true);
      expect(result.recordable).toBe(false);
      expect(result.error).toBe('签名获取失败');
    });

    it('should handle API errors gracefully', async () => {
      PlatformChecker.fetchJson.mockRejectedValue(new Error('Network error'));

      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.checkStatus();

      expect(result.error).toBe('无法获取房间状态');
    });

    it('should report fallback signing in streamInfo', async () => {
      PlatformChecker.fetchJson
        .mockResolvedValueOnce({
          data: {
            owner_name: 'TestAnchor',
            room_name: 'Test Title',
            room_pic: 'https://example.com/cover.jpg',
            show_status: 1,
            videoLoop: 0,
            isVip: 0,
          },
        })
        .mockResolvedValueOnce({
          error: 0,
          data: {
            rtmp_url: 'rtmp://hdltctwk.douyucdn.cn/live',
            rtmp_live: '12345678abcdef_0',
            rtmp_cdn: 'hw-h5',
            rate: 0,
          },
        });

      getSignParams.mockResolvedValue({
        did: '10000000000000000000000000001501',
        rid: '123456',
        time: '1234567890',
        sign: 'abc',
        _fallback: true,
      });

      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.checkStatus();

      expect(result.streamInfo.isFallback).toBe(true);
    });
  });
});
