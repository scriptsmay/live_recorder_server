const path = require('path');

const { getDanmakuJsonlPath, getDanmakuDir, DANMAKU_DIR_NAME } = require('../server/lib/utils/tool');

// v1.8.0 弹幕路径扁平化：VIDEO_DOWNLOAD_DIR/danmaku/[sessionId].jsonl
// 该函数是弹幕路径的唯一生成入口，业务代码禁止自行 path.join 拼接。
describe('getDanmakuJsonlPath', () => {
  const ORIGINAL_DIR = process.env.VIDEO_DOWNLOAD_DIR;

  afterEach(() => {
    if (ORIGINAL_DIR === undefined) {
      delete process.env.VIDEO_DOWNLOAD_DIR;
    } else {
      process.env.VIDEO_DOWNLOAD_DIR = ORIGINAL_DIR;
    }
  });

  test('按 sessionId 生成扁平路径', () => {
    process.env.VIDEO_DOWNLOAD_DIR = '/data/video_downloads';
    expect(getDanmakuJsonlPath(118)).toBe(path.join('/data/video_downloads', 'danmaku', '118.jsonl'));
  });

  test('sessionId 为字符串时结果一致', () => {
    process.env.VIDEO_DOWNLOAD_DIR = '/data/video_downloads';
    expect(getDanmakuJsonlPath('118')).toBe(getDanmakuJsonlPath(118));
  });

  test('路径不再包含会话子目录层级', () => {
    process.env.VIDEO_DOWNLOAD_DIR = '/data/video_downloads';
    const result = getDanmakuJsonlPath(28);
    expect(result).not.toContain(path.join('28', 'danmaku'));
    expect(result.endsWith('28.jsonl')).toBe(true);
  });

  test('sessionId 缺失时抛错，避免生成 undefined.jsonl', () => {
    process.env.VIDEO_DOWNLOAD_DIR = '/data/video_downloads';
    expect(() => getDanmakuJsonlPath(null)).toThrow(/sessionId/);
    expect(() => getDanmakuJsonlPath(undefined)).toThrow(/sessionId/);
    expect(() => getDanmakuJsonlPath('')).toThrow(/sessionId/);
  });

  test('VIDEO_DOWNLOAD_DIR 未配置时抛错', () => {
    delete process.env.VIDEO_DOWNLOAD_DIR;
    expect(() => getDanmakuJsonlPath(1)).toThrow(/VIDEO_DOWNLOAD_DIR/);
  });
});

describe('getDanmakuDir', () => {
  const ORIGINAL_DIR = process.env.VIDEO_DOWNLOAD_DIR;

  afterEach(() => {
    if (ORIGINAL_DIR === undefined) {
      delete process.env.VIDEO_DOWNLOAD_DIR;
    } else {
      process.env.VIDEO_DOWNLOAD_DIR = ORIGINAL_DIR;
    }
  });

  test('返回集中目录且与 JSONL 路径同源', () => {
    process.env.VIDEO_DOWNLOAD_DIR = '/data/video_downloads';
    expect(getDanmakuDir()).toBe(path.join('/data/video_downloads', DANMAKU_DIR_NAME));
    expect(path.dirname(getDanmakuJsonlPath(7))).toBe(getDanmakuDir());
  });

  test('VIDEO_DOWNLOAD_DIR 未配置时回落到默认值不抛错', () => {
    delete process.env.VIDEO_DOWNLOAD_DIR;
    expect(getDanmakuDir()).toBe(path.join('/data/video_downloads', DANMAKU_DIR_NAME));
  });
});
