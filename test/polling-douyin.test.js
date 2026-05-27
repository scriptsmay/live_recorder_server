const PlatformChecker = require('../lib/core/polling/PlatformChecker');
const DouyinChecker = require('../lib/core/polling/DouyinChecker');

jest.spyOn(PlatformChecker, 'fetchJson').mockImplementation(jest.fn());
jest.spyOn(PlatformChecker, 'fetchText').mockImplementation(jest.fn());
jest.spyOn(PlatformChecker, 'extractLastPathSegment').mockImplementation((url) => {
  const match = url.match(/(?:live\.douyin\.com|douyin\.com)\/([^/?#]+)/i);
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

jest.mock('../lib/core/polling/signers/douyin', () => ({
  generateABogus: jest.fn((query) => {
    if (!query) return null;
    return 'test_abogus';
  }),
}));

describe('DouyinChecker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('静态方法', () => {
    it('should return correct platform id', () => {
      expect(DouyinChecker.getPlatformId()).toBe('douyin');
    });

    it('should handle douyin URLs', () => {
      expect(DouyinChecker.canHandleUrl('https://live.douyin.com/123456')).toBe(true);
      expect(DouyinChecker.canHandleUrl('https://www.douyin.com/live/123456')).toBe(true);
      expect(DouyinChecker.canHandleUrl('https://douyin.com/i/123456')).toBe(true);
    });

    it('should not handle non-douyin URLs', () => {
      expect(DouyinChecker.canHandleUrl('https://www.huya.com/123456')).toBe(false);
      expect(DouyinChecker.canHandleUrl('https://live.bilibili.com/123456')).toBe(false);
    });
  });

  describe('getRoomId', () => {
    it('should extract room id from live.douyin.com URL', () => {
      const checker = new DouyinChecker('https://live.douyin.com/123456');
      expect(checker.getRoomId()).toBe('123456');
    });

    it('should extract room id from web_rid parameter', () => {
      const checker = new DouyinChecker('https://live.douyin.com/?web_rid=123456');
      expect(checker.getRoomId()).toBe('123456');
    });

    it('should strip query parameters from room id', () => {
      const checker = new DouyinChecker('https://live.douyin.com/123456?from=abc');
      expect(checker.getRoomId()).toBe('123456');
    });
  });

  describe('checkUnsupportedType', () => {
    it('should detect VR type', () => {
      const checker = new DouyinChecker('https://live.douyin.com/123456');
      expect(checker.checkUnsupportedType({ room_type: 2 })).toBe(true);
      expect(checker.checkUnsupportedType({ room_type: 3 })).toBe(true);
    });

    it('should detect normal type', () => {
      const checker = new DouyinChecker('https://live.douyin.com/123456');
      expect(checker.checkUnsupportedType({ room_type: 1 })).toBe(false);
      expect(checker.checkUnsupportedType({ room_type: 0 })).toBe(false);
    });

    it('should detect VR stream type', () => {
      const checker = new DouyinChecker('https://live.douyin.com/123456');
      expect(checker.checkUnsupportedType({ stream_type: 'vr_stream' })).toBe(true);
      expect(checker.checkUnsupportedType({ stream_type: 'normal' })).toBe(false);
    });
  });

  describe('parseStreamData', () => {
    it('should parse stream data from pull_datas', () => {
      const checker = new DouyinChecker('https://live.douyin.com/123456');
      const apiResponse = {
        stream_url: {
          pull_datas: [
            { pull_url: 'https://example.com/live.flv' },
          ],
        },
      };
      const result = checker.parseStreamData(apiResponse);
      expect(result).toEqual({ streamUrl: 'https://example.com/live.flv', format: 'flv' });
    });

    it('should prefer FLV over HLS', () => {
      const checker = new DouyinChecker('https://live.douyin.com/123456');
      const apiResponse = {
        stream_url: {
          pull_datas: [
            { pull_url: 'https://example.com/live.m3u8' },
            { pull_url: 'https://example.com/live.flv' },
          ],
        },
      };
      const result = checker.parseStreamData(apiResponse);
      expect(result.format).toBe('flv');
    });

    it('should parse from live_core_sdk_data', () => {
      const checker = new DouyinChecker('https://live.douyin.com/123456');
      const apiResponse = {
        live_core_sdk_data: {
          pull_data: {
            stream_data: JSON.stringify({
              data: {
                stream_url: {
                  pull_datas: [{ pull_url: 'https://example.com/live.flv' }],
                },
              },
            }),
          },
        },
      };
      const result = checker.parseStreamData(apiResponse);
      expect(result).toEqual({ streamUrl: 'https://example.com/live.flv', format: 'flv' });
    });

    it('should return null for missing stream data', () => {
      const checker = new DouyinChecker('https://live.douyin.com/123456');
      expect(checker.parseStreamData(null)).toBeNull();
      expect(checker.parseStreamData({})).toBeNull();
    });
  });

  describe('checkStatus', () => {
    it('should return error for invalid URL', async () => {
      const checker = new DouyinChecker('https://invalid.url');
      checker.getRoomId = jest.fn().mockReturnValue(null);

      const result = await checker.checkStatus();

      expect(result.error).toBe('无法解析房间号');
    });

    it('should return offline status correctly', async () => {
      PlatformChecker.fetchJson.mockResolvedValue({
        code: 0,
        data: {
          room_info: {
            status: 0,
            owner_name: 'TestAnchor',
            title: 'Test Title',
            cover: 'https://example.com/cover.jpg',
          },
        },
      });

      const checker = new DouyinChecker('https://live.douyin.com/123456');
      const result = await checker.checkStatus();

      expect(result.isLive).toBe(false);
      expect(result.roomName).toBe('TestAnchor');
      expect(result.roomTitle).toBe('Test Title');
    });

    it('should return recordable: false for unsupported types', async () => {
      PlatformChecker.fetchJson.mockResolvedValue({
        code: 0,
        data: {
          room_info: {
            status: 2,
            room_type: 2,
            owner_name: 'TestAnchor',
            title: 'VR Stream',
          },
        },
      });

      const checker = new DouyinChecker('https://live.douyin.com/123456');
      const result = await checker.checkStatus();

      expect(result.isLive).toBe(true);
      expect(result.recordable).toBe(false);
      expect(result.error).toBe('不支持的直播类型');
    });

    it('should return live status with stream URL', async () => {
      PlatformChecker.fetchJson.mockResolvedValue({
        code: 0,
        data: {
          room_info: {
            status: 2,
            room_type: 1,
            owner_name: 'TestAnchor',
            title: 'Live Stream',
            cover: 'https://example.com/cover.jpg',
          },
          stream_url: {
            pull_datas: [{ pull_url: 'https://example.com/live.flv' }],
          },
        },
      });

      const checker = new DouyinChecker('https://live.douyin.com/123456');
      const result = await checker.checkStatus();

      expect(result.isLive).toBe(true);
      expect(result.recordable).toBe(true);
      expect(result.streamUrl).toBe('https://example.com/live.flv');
    });

    it('should fall back to HTML parsing when API fails', async () => {
      PlatformChecker.fetchJson.mockResolvedValue({ code: -1, message: 'error' });
      PlatformChecker.fetchText.mockResolvedValue(
        '<html><script>window.__INITIAL_STATE__ = {"room":{"room_info":{"status":2,"owner_name":"TestAnchor","title":"Test Title"},"stream_url":{"flv_pull_url":"https://example.com/live.flv"}}};</script></html>'
      );

      const checker = new DouyinChecker('https://live.douyin.com/123456');
      const result = await checker.checkStatus();

      expect(result.isLive).toBe(true);
      expect(result.roomName).toBe('TestAnchor');
    });

    it('should handle API errors gracefully', async () => {
      PlatformChecker.fetchJson.mockRejectedValue(new Error('Network error'));
      PlatformChecker.fetchText.mockRejectedValue(new Error('Network error'));

      const checker = new DouyinChecker('https://live.douyin.com/123456');
      const result = await checker.checkStatus();

      expect(result.error).toBe('无法获取房间信息');
    });
  });
});

describe('Douyin Signer', () => {
  it('should generate a_bogus signature', () => {
    const { generateABogus } = jest.requireActual('../lib/core/polling/signers/douyin');
    const result = generateABogus('test=123&foo=bar');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should return null for empty input', () => {
    const { generateABogus } = jest.requireActual('../lib/core/polling/signers/douyin');
    expect(generateABogus('')).toBeNull();
    expect(generateABogus(null)).toBeNull();
  });
});
