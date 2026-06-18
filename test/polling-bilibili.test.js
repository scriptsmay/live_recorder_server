const PlatformChecker = require('../server/lib/core/polling/PlatformChecker');
const BilibiliChecker = require('../server/lib/core/polling/BilibiliChecker');

jest.spyOn(PlatformChecker, 'fetchJson').mockImplementation(jest.fn());
jest.spyOn(PlatformChecker, 'extractLastPathSegment').mockImplementation((url) => {
  const match = url.match(/live\.bilibili\.com\/([^/?#]+)/i);
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

describe('BilibiliChecker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('静态方法', () => {
    it('should return correct platform id', () => {
      expect(BilibiliChecker.getPlatformId()).toBe('bilibili');
    });

    it('should handle bilibili.com URLs', () => {
      expect(BilibiliChecker.canHandleUrl('https://live.bilibili.com/123456')).toBe(true);
      expect(BilibiliChecker.canHandleUrl('https://live.bilibili.com/123456?from=abc')).toBe(true);
      expect(BilibiliChecker.canHandleUrl('https://live.bilibili.com/room/123456')).toBe(true);
    });

    it('should not handle non-bilibili URLs', () => {
      expect(BilibiliChecker.canHandleUrl('https://www.huya.com/123456')).toBe(false);
      expect(BilibiliChecker.canHandleUrl('https://www.douyu.com/123456')).toBe(false);
    });
  });

  describe('getRoomId', () => {
    it('should extract room id from URL', () => {
      const checker = new BilibiliChecker('https://live.bilibili.com/123456');
      expect(checker.getRoomId()).toBe('123456');
    });

    it('should strip query parameters from room id', () => {
      const checker = new BilibiliChecker('https://live.bilibili.com/123456?from=abc');
      expect(checker.getRoomId()).toBe('123456');
    });

    it('should cache room id', () => {
      const checker = new BilibiliChecker('https://live.bilibili.com/123456');
      checker.getRoomId();
      checker.getRoomId();
      expect(PlatformChecker.extractLastPathSegment).toHaveBeenCalledTimes(1);
    });
  });

  describe('getRoomInit', () => {
    it('should parse room_init response correctly', async () => {
      const mockData = {
        code: 0,
        data: {
          room_id: 123456,
          uid: 789012,
          live_status: 1,
        },
      };
      PlatformChecker.fetchJson.mockResolvedValue(mockData);

      const checker = new BilibiliChecker('https://live.bilibili.com/123456');
      const result = await checker.getRoomInit('123456');

      expect(result).toEqual({
        roomId: '123456',
        uid: 789012,
        liveStatus: true,
        shortId: '123456',
      });
    });

    it('should handle short room id mapping', async () => {
      const mockData = {
        code: 0,
        data: {
          room_id: 999999,
          uid: 789012,
          live_status: 0,
        },
      };
      PlatformChecker.fetchJson.mockResolvedValue(mockData);

      const checker = new BilibiliChecker('https://live.bilibili.com/123456');
      const result = await checker.getRoomInit('123456');

      expect(result).toEqual({
        roomId: '999999',
        uid: 789012,
        liveStatus: false,
        shortId: '123456',
      });
    });

    it('should throw error on API failure', async () => {
      const mockData = { code: -1, message: 'error' };
      PlatformChecker.fetchJson.mockResolvedValue(mockData);

      const checker = new BilibiliChecker('https://live.bilibili.com/123456');

      await expect(checker.getRoomInit('123456')).rejects.toThrow('room_init API 错误');
    });
  });

  describe('getAnchorInfo', () => {
    it('should return anchor name from response', async () => {
      const mockData = {
        code: 0,
        data: {
          info: { uname: 'TestAnchor' },
        },
      };
      PlatformChecker.fetchJson.mockResolvedValue(mockData);

      const checker = new BilibiliChecker('https://live.bilibili.com/123456');
      const result = await checker.getAnchorInfo(789012);

      expect(result).toEqual({ anchorName: 'TestAnchor' });
    });

    it('should return empty name on API failure', async () => {
      const mockData = { code: -1, message: 'error' };
      PlatformChecker.fetchJson.mockResolvedValue(mockData);

      const checker = new BilibiliChecker('https://live.bilibili.com/123456');
      const result = await checker.getAnchorInfo(789012);

      expect(result).toEqual({ anchorName: '' });
    });
  });

  describe('getRoomTitle', () => {
    it('should return title and cover from response', async () => {
      const mockData = {
        code: 0,
        data: {
          room_info: {
            title: 'Test Title',
            cover: 'https://example.com/cover.jpg',
          },
        },
      };
      PlatformChecker.fetchJson.mockResolvedValue(mockData);

      const checker = new BilibiliChecker('https://live.bilibili.com/123456');
      const result = await checker.getRoomTitle('123456');

      expect(result).toEqual({
        title: 'Test Title',
        cover: 'https://example.com/cover.jpg',
      });
    });

    it('should return empty values on API failure', async () => {
      const mockData = { code: -1, message: 'error' };
      PlatformChecker.fetchJson.mockResolvedValue(mockData);

      const checker = new BilibiliChecker('https://live.bilibili.com/123456');
      const result = await checker.getRoomTitle('123456');

      expect(result).toEqual({ title: '', cover: '' });
    });
  });

  describe('getStreamUrl', () => {
    it('should return stream url from playUrl API', async () => {
      const mockData = {
        code: 0,
        data: {
          durl: [{ url: 'https://d1--cn-gotcha.example.com/live.flv' }, { url: 'https://other.example.com/live.flv' }],
        },
      };
      PlatformChecker.fetchJson.mockResolvedValue(mockData);

      const checker = new BilibiliChecker('https://live.bilibili.com/123456');
      const result = await checker.getStreamUrl('123456');

      expect(result).toEqual({ streamUrl: 'https://d1--cn-gotcha.example.com/live.flv', format: 'flv' });
    });

    it('should fall back to getStreamUrlV2 on failure', async () => {
      const mockData1 = { code: -1, data: {} };
      const mockData2 = {
        code: 0,
        data: {
          playurl_info: {
            playurl: {
              stream: [
                {
                  format: [
                    {
                      codec: [
                        {
                          current_qn: 10000,
                          base_url: '/live.flv',
                          url_info: [{ host: 'https://example.com', extra: '?token=abc' }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      };
      PlatformChecker.fetchJson.mockResolvedValueOnce(mockData1).mockResolvedValueOnce(mockData2);

      const checker = new BilibiliChecker('https://live.bilibili.com/123456');
      const result = await checker.getStreamUrl('123456');

      expect(result.streamUrl).toBe('https://example.com/live.flv?token=abc');
      expect(result.format).toBe('flv');
    });
  });

  describe('checkStatus', () => {
    it('should return error for invalid URL', async () => {
      const checker = new BilibiliChecker('https://invalid.url');
      checker.getRoomId = jest.fn().mockReturnValue(null);

      const result = await checker.checkStatus();

      expect(result.error).toBe('无法解析房间号');
    });

    it('should return offline status correctly', async () => {
      PlatformChecker.fetchJson
        .mockResolvedValueOnce({
          code: 0,
          data: { room_id: 123456, uid: 789012, live_status: 0 },
        })
        .mockResolvedValueOnce({ code: 0, data: { info: { uname: 'TestAnchor' } } })
        .mockResolvedValueOnce({
          code: 0,
          data: { room_info: { title: 'Test Title', cover: 'https://example.com/cover.jpg' } },
        });

      const checker = new BilibiliChecker('https://live.bilibili.com/123456');
      const result = await checker.checkStatus();

      expect(result.isLive).toBe(false);
      expect(result.recordable).toBe(true);
      expect(result.roomName).toBe('TestAnchor');
      expect(result.roomTitle).toBe('Test Title');
      expect(result.streamUrl).toBeNull();
    });

    it('should return live status with stream URL', async () => {
      PlatformChecker.fetchJson
        .mockResolvedValueOnce({
          code: 0,
          data: { room_id: 123456, uid: 789012, live_status: 1 },
        })
        .mockResolvedValueOnce({ code: 0, data: { info: { uname: 'TestAnchor' } } })
        .mockResolvedValueOnce({
          code: 0,
          data: { room_info: { title: 'Test Title', cover: 'https://example.com/cover.jpg' } },
        })
        .mockResolvedValueOnce({
          code: 0,
          data: { durl: [{ url: 'https://example.com/live.flv' }] },
        });

      const checker = new BilibiliChecker('https://live.bilibili.com/123456');
      const result = await checker.checkStatus();

      expect(result.isLive).toBe(true);
      expect(result.recordable).toBe(true);
      expect(result.streamUrl).toBe('https://example.com/live.flv');
    });

    it('should handle API errors gracefully', async () => {
      PlatformChecker.fetchJson.mockRejectedValue(new Error('Network error'));

      const checker = new BilibiliChecker('https://live.bilibili.com/123456');
      const result = await checker.checkStatus();

      expect(result.error).toBe('Network error');
    });
  });
});
