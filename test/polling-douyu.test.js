const PlatformChecker = require('../lib/core/polling/PlatformChecker');
const DouyuChecker = require('../lib/core/polling/DouyuChecker');
const { getSignParams } = require('../lib/core/polling/signers/douyu');

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

jest.mock('../lib/core/polling/signers/douyu', () => ({
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
      });
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

  describe('getStreamUrl', () => {
    it('should return stream url correctly', async () => {
      const mockData = {
        error: 0,
        data: {
          rtmp_url: 'rtmp://hdltctwk.douyucdn.cn/live',
          rtmp_live: '12345678abcdef_0',
        },
      };
      PlatformChecker.fetchJson.mockResolvedValue(mockData);

      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.getStreamUrl('123456', { did: '10000000000000000000000000001501', rid: '123456', time: '1234567890', sign: 'abc' });

      expect(result).toEqual({ streamUrl: 'rtmp://hdltctwk.douyucdn.cn/live/12345678abcdef_0', format: 'flv' });
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
      const result = await checker.getStreamUrl('123456', { did: '10000000000000000000000000001501', rid: '123456', time: '1234567890', sign: 'abc' });

      expect(result).toBeNull();
    });

    it('should return null on API failure', async () => {
      PlatformChecker.fetchJson.mockResolvedValue({ error: -1, msg: 'error' });
      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.getStreamUrl('123456', { did: '10000000000000000000000000001501', rid: '123456', time: '1234567890', sign: 'abc' });
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
          },
        })
        .mockResolvedValueOnce({
          error: 0,
          data: {
            rtmp_url: 'rtmp://hdltctwk.douyucdn.cn/live',
            rtmp_live: '12345678abcdef_0',
          },
        });

      getSignParams.mockResolvedValue({ did: '10000000000000000000000000001501', rid: '123456', time: '1234567890', sign: 'abc' });

      const checker = new DouyuChecker('https://www.douyu.com/123456');
      const result = await checker.checkStatus();

      expect(result.isLive).toBe(true);
      expect(result.recordable).toBe(true);
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
  });
});
