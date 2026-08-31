const FFmpegDownloader = require('../server/lib/core/downloaders/FFmpegDownloader');

describe('FFmpegDownloader - B站 Referer 注入（v1.10.1）', () => {
  const dl = new FFmpegDownloader();
  const out = '/tmp/out.ts';

  test('B站平台 FLV 注入 -headers Referer', () => {
    const url = 'https://cn-hbyc-ct-01-02.bilivideo.com/live-bvc/438369/live.flv';
    const args = dl.buildArgs(url, out, { streamType: 'flv', platform: 'bilibili' });
    const idx = args.indexOf('-headers');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('Referer: https://live.bilibili.com/\r\n');
    // -headers 必须出现在 -i 之前
    expect(idx).toBeLessThan(args.indexOf('-i'));
  });

  test('B站 HLS 也注入 Referer（避免 m3u8 拉取 403）', () => {
    const args = dl.buildArgs('https://xxx/hls.m3u8', out, { streamType: 'hls', platform: 'bilibili' });
    const idx = args.indexOf('-headers');
    expect(idx).toBeGreaterThan(-1);
  });

  test('命中 bilivideo.com URL 时也注入，即使 platform 未传', () => {
    const args = dl.buildArgs('https://upos-blabla.bilivideo.com/xx.flv', out, { streamType: 'flv' });
    expect(args).toContain('-headers');
  });

  test('非 B站平台不注入 -headers', () => {
    const args = dl.buildArgs('https://tx.flv.huya.com/src/123', out, { streamType: 'flv', platform: 'huya' });
    expect(args).not.toContain('-headers');
  });

  test('快手/douyin/douyu 等非 B站不注入', () => {
    ['kuaishou', 'douyin', 'douyu'].forEach((p) => {
      const args = dl.buildArgs('https://example.com/x.flv', out, { streamType: 'flv', platform: p });
      expect(args).not.toContain('-headers');
    });
  });
});
