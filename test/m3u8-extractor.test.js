'use strict';

const { parseM3u8, parseCookies, selectBestStreamFromV3 } = require('../lib/core/replay/m3u8-extractor');

describe('m3u8-extractor', () => {
  describe('parseM3u8', () => {
    test('解析标准 m3u8 master playlist', () => {
      const content = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
playlist_720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480
playlist_480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360
playlist_360p.m3u8`;

      const result = parseM3u8(content, 'https://example.com/master.m3u8');

      expect(result).toHaveLength(3);
      expect(result[0].bandwidth).toBe(2000000);
      expect(result[0].resolution).toBe('1280x720');
      expect(result[0].url).toBe('https://example.com/playlist_720p.m3u8');
      expect(result[1].bandwidth).toBe(1000000);
      expect(result[2].bandwidth).toBe(500000);
    });

    test('空内容返回空数组', () => {
      expect(parseM3u8('', 'https://example.com/')).toHaveLength(0);
    });

    test('无清晰度信息返回空数组', () => {
      const content = `#EXTM3U
#EXTINF:10.0,
segment001.ts`;
      expect(parseM3u8(content, 'https://example.com/')).toHaveLength(0);
    });
  });

  describe('parseCookies', () => {
    test('解析标准 Cookie 字符串', () => {
      const cookies = parseCookies('key1=value1; key2=value2');
      expect(cookies).toHaveLength(2);
      expect(cookies[0].name).toBe('key1');
      expect(cookies[0].value).toBe('value1');
      expect(cookies[0].domain).toBe('.kuaishou.com');
    });

    test('空字符串返回空数组', () => {
      expect(parseCookies('')).toHaveLength(0);
      expect(parseCookies(null)).toHaveLength(0);
    });

    test('解析 JSON 格式 Cookie', () => {
      const json = JSON.stringify([{ name: 'k1', value: 'v1', domain: '.kuaishou.com' }]);
      const cookies = parseCookies(json);
      expect(cookies).toHaveLength(1);
      expect(cookies[0].name).toBe('k1');
    });
  });

  describe('selectBestStreamFromV3', () => {
    test('选择最高分辨率的 H264 流', () => {
      const playUrlV3 = {
        h264: {
          adaptationSet: [
            {
              representation: [
                { url: 'low.m3u8', width: 640, height: 360, maxBitrate: 500, hidden: false },
                { url: 'high.m3u8', width: 1920, height: 1080, maxBitrate: 3000, hidden: false },
              ],
            },
          ],
        },
        hevc: {
          adaptationSet: [
            {
              representation: [{ url: 'hevc_4k.m3u8', width: 3840, height: 2160, maxBitrate: 8000, hidden: false }],
            },
          ],
        },
      };

      const result = selectBestStreamFromV3(playUrlV3);
      // H264 优先，但 HEVC 分辨率更高时选 HEVC
      expect(result).toBe('hevc_4k.m3u8');
    });

    test('空对象返回 null', () => {
      expect(selectBestStreamFromV3(null)).toBeNull();
      expect(selectBestStreamFromV3({})).toBeNull();
    });

    test('跳过 hidden 流', () => {
      const playUrlV3 = {
        h264: {
          adaptationSet: [
            {
              representation: [
                { url: 'hidden.m3u8', width: 1920, height: 1080, maxBitrate: 3000, hidden: true },
                { url: 'visible.m3u8', width: 1280, height: 720, maxBitrate: 2000, hidden: false },
              ],
            },
          ],
        },
      };

      const result = selectBestStreamFromV3(playUrlV3);
      expect(result).toBe('visible.m3u8');
    });

    test('同分辨率下 H264 优先于 HEVC', () => {
      const playUrlV3 = {
        h264: {
          adaptationSet: [
            {
              representation: [{ url: 'h264_720p.m3u8', width: 1280, height: 720, maxBitrate: 2000, hidden: false }],
            },
          ],
        },
        hevc: {
          adaptationSet: [
            {
              representation: [{ url: 'hevc_720p.m3u8', width: 1280, height: 720, maxBitrate: 2500, hidden: false }],
            },
          ],
        },
      };

      const result = selectBestStreamFromV3(playUrlV3);
      expect(result).toBe('h264_720p.m3u8');
    });
  });
});
