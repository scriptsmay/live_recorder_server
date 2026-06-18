'use strict';

jest.mock('../db/index', () => ({ query: jest.fn() }));
jest.mock('../db/redis', () => ({ get: jest.fn(), set: jest.fn(), del: jest.fn() }));
jest.mock('../services/DataService', () => ({
  getSetting: jest.fn(async () => ''),
}));
jest.mock('../services/ReplayService', () => ({
  upsertRecord: jest.fn(async () => ({ id: 1 })),
  getRecordByReplayId: jest.fn(async () => null),
  getSettings: jest.fn(async () => ({ principal_name: '' })),
}));

const ReplayService = require('../services/ReplayService');
const DataService = require('../services/DataService');
const {
  generateHxfalcon,
  buildHeaders,
  getKuaishouCookies,
  formatTimestamp,
  selectBestStreamFromV3,
  syncReplays,
} = require('../lib/core/replay/KuaishouReplayClient');

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.POLLING_KUAISHOU_COOKIE;
  delete process.env.KW_COOKIE;
  delete process.env.KW_KWW;
});

describe('KuaishouReplayClient', () => {
  describe('generateHxfalcon', () => {
    test('空 kww 返回空字符串', () => {
      expect(generateHxfalcon('')).toBe('');
      expect(generateHxfalcon(null)).toBe('');
      expect(generateHxfalcon(undefined)).toBe('');
    });

    test('生成以 HUDR_ 开头的字符串', () => {
      const result = generateHxfalcon('test-kww-value');
      expect(result).toMatch(/^HUDR_/);
    });

    test('每次生成不同的值', () => {
      const a = generateHxfalcon('test');
      const b = generateHxfalcon('test');
      expect(a).not.toBe(b);
    });
  });

  describe('formatTimestamp', () => {
    test('固定使用 Asia/Shanghai 时区', () => {
      expect(formatTimestamp('2026-06-17T11:30:05.000Z')).toBe('2026-06-17_19_30_05');
    });
  });

  describe('syncReplays', () => {
    test('使用 principal_name 设置生成可读文件名', async () => {
      global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            list: [
              {
                id: 'r1',
                playUrl: 'https://live.kuaishou.com/playback/r1',
                createTime: '2026-06-17T11:30:05.000Z',
                duration: 60,
              },
            ],
          },
        }),
      }));
      ReplayService.getSettings.mockResolvedValueOnce({ principal_name: '主播名' });

      await syncReplays('abc', 1);

      expect(ReplayService.getSettings).toHaveBeenCalledWith('abc');
      expect(ReplayService.upsertRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          principal_name: '主播名',
          video_file_name: '主播名_2026-06-17_19_30_05',
        })
      );
    });
  });

  describe('buildHeaders', () => {
    test('getKuaishouCookies 优先复用 POLLING_KUAISHOU_COOKIE', async () => {
      process.env.POLLING_KUAISHOU_COOKIE = 'did=web_x; client_key=abc';
      DataService.getSetting.mockResolvedValue('');

      const cookies = await getKuaishouCookies();

      expect(cookies.cookie).toBe('did=web_x; client_key=abc');
      expect(DataService.getSetting).not.toHaveBeenCalledWith('kuaishou_cookie', '');
    });

    test('getKuaishouCookies 兼容旧 settings 字段', async () => {
      DataService.getSetting.mockImplementation(async (key) => {
        if (key === 'kuaishou_cookie') return 'legacy_cookie=1';
        if (key === 'kuaishou_kww') return 'legacy-kww';
        return '';
      });

      const cookies = await getKuaishouCookies();

      expect(cookies.cookie).toBe('legacy_cookie=1');
      expect(cookies.kww).toBe('legacy-kww');
    });

    test('构建包含所有必需头的对象', () => {
      const cookies = {
        cookie: 'test_cookie',
        kwfv1: 'fv1',
        kwssectoken: 'sectoken',
        kwscode: 'scode',
        bfb1s: 'bfb',
        webSt: 'st',
        webPh: 'ph',
        kww: 'kww-value',
      };
      const headers = buildHeaders(cookies, 'principal123');

      expect(headers.accept).toContain('application/json');
      expect(headers.kww).toBe('kww-value');
      expect(headers.cookie).toContain('test_cookie');
      expect(headers.cookie).toContain('kwfv1=fv1');
      expect(headers.cookie).toContain('kwssectoken=sectoken');
      expect(headers.Referer).toContain('principal123');
    });

    test('空 cookie 字段被跳过', () => {
      const cookies = { cookie: '', kwfv1: '', kwssectoken: '', kwscode: '', bfb1s: '', webSt: '', webPh: '', kww: '' };
      const headers = buildHeaders(cookies, 'test');

      expect(headers.cookie).toBe('');
    });
  });

  describe('selectBestStreamFromV3', () => {
    test('优先选择 H264 + 最高分辨率', () => {
      const playUrlV3 = {
        h264: {
          adaptationSet: [
            {
              representation: [
                { url: 'https://h264-720p.m3u8', width: 1280, height: 720, maxBitrate: 3000 },
                { url: 'https://h264-1080p.m3u8', width: 1920, height: 1080, maxBitrate: 5000 },
              ],
            },
          ],
        },
        hevc: {
          adaptationSet: [
            {
              representation: [{ url: 'https://hevc-1080p.m3u8', width: 1920, height: 1080, maxBitrate: 4000 }],
            },
          ],
        },
      };
      const url = selectBestStreamFromV3(playUrlV3);
      expect(url).toBe('https://h264-1080p.m3u8');
    });

    test('hidden 流被跳过', () => {
      const playUrlV3 = {
        h264: {
          adaptationSet: [
            {
              representation: [
                { url: 'https://hidden.m3u8', width: 1920, height: 1080, maxBitrate: 8000, hidden: true },
                { url: 'https://visible.m3u8', width: 1280, height: 720, maxBitrate: 3000 },
              ],
            },
          ],
        },
      };
      const url = selectBestStreamFromV3(playUrlV3);
      expect(url).toBe('https://visible.m3u8');
    });

    test('空 adaptationSet 返回 null', () => {
      const playUrlV3 = { h264: {}, hevc: {} };
      expect(selectBestStreamFromV3(playUrlV3)).toBeNull();
    });

    test('仅有 HEVC 时也能返回', () => {
      const playUrlV3 = {
        hevc: {
          adaptationSet: [
            {
              representation: [{ url: 'https://hevc-only.m3u8', width: 1920, height: 1080, maxBitrate: 5000 }],
            },
          ],
        },
      };
      expect(selectBestStreamFromV3(playUrlV3)).toBe('https://hevc-only.m3u8');
    });
  });
});
