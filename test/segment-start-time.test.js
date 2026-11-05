const { parseSegmentStartFromFilename } = require('../server/lib/utils/tool');

// v1.14.5：分段 started_at 统一以文件名里的 strftime 时间戳为准，
// 保证 recordSegment / watchdog / finishSession / scan-files 四条写入路径口径一致。
describe('parseSegmentStartFromFilename', () => {
  test('从分段文件名解析出真实起始时间（本地时区）', () => {
    const result = parseSegmentStartFromFilename('/data/video_downloads/82/成都AG超玩会染详_20261105_214304.ts');
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(10); // 11 月
    expect(result.getDate()).toBe(5);
    expect(result.getHours()).toBe(21);
    expect(result.getMinutes()).toBe(43);
    expect(result.getSeconds()).toBe(4);
  });

  test('传入纯文件名与完整路径结果一致', () => {
    const name = 'room_20260101_083000.ts';
    expect(parseSegmentStartFromFilename(name).getTime()).toBe(
      parseSegmentStartFromFilename(`/data/video_downloads/1/${name}`).getTime()
    );
  });

  test('旧会话不分段产物名含 {datetime} 时间戳时仍按文件名解析', () => {
    const fallback = new Date('2026-11-05T21:43:03.000Z');
    const result = parseSegmentStartFromFilename(
      '/data/video_downloads/80/成都AG超玩会染详_20261104_213441.ts',
      fallback
    );
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(10);
    expect(result.getDate()).toBe(4);
    expect(result.getHours()).toBe(21);
    expect(result.getMinutes()).toBe(34);
    expect(result.getSeconds()).toBe(41);
  });

  test('无时间戳的文件名回退到 fallback（Date 入参）', () => {
    const fallback = new Date('2026-11-05T21:43:03.000Z');
    expect(parseSegmentStartFromFilename('/data/video_downloads/80/room_fixed.ts', fallback)).toBe(fallback);
  });

  test('无时间戳的文件名回退到 fallback（字符串入参，模拟 DB timestamp）', () => {
    const result = parseSegmentStartFromFilename('room_fixed.ts', '2026-11-05T21:43:03.000Z');
    expect(result.toISOString()).toBe('2026-11-05T21:43:03.000Z');
  });

  test('无时间戳的文件名回退到 fallback（毫秒数入参，模拟 stat.mtimeMs）', () => {
    const ms = Date.parse('2026-11-05T21:43:03.000Z');
    const result = parseSegmentStartFromFilename('room_fixed.ts', ms);
    expect(result.getTime()).toBe(ms);
  });

  test('空路径或空文件名回退到 fallback', () => {
    const fallback = new Date('2026-11-05T21:43:03.000Z');
    expect(parseSegmentStartFromFilename('', fallback)).toBe(fallback);
    expect(parseSegmentStartFromFilename(null, fallback)).toBe(fallback);
  });

  test('自定义模板含独立年月日时分秒也能解析', () => {
    const result = parseSegmentStartFromFilename('room_20261231_235959.ts');
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(11);
    expect(result.getDate()).toBe(31);
    expect(result.getHours()).toBe(23);
    expect(result.getMinutes()).toBe(59);
    expect(result.getSeconds()).toBe(59);
  });

  test('房间名含 8 位数字不会误判（取文件名最后一组时间戳）', () => {
    const result = parseSegmentStartFromFilename('20240101_主播_20261105_214304.ts');
    expect(result.getHours()).toBe(21);
    expect(result.getMinutes()).toBe(43);
  });

  test('时间戳非法（如月份 99）回退到 fallback', () => {
    const fallback = new Date('2026-11-05T21:43:03.000Z');
    expect(parseSegmentStartFromFilename('room_20269905_214304.ts', fallback)).toBe(fallback);
  });

  test('可空 DB 列（null / 空串 / NaN）作为 fallback 时不写入 Invalid Date', () => {
    for (const bad of [null, '', NaN]) {
      const result = parseSegmentStartFromFilename('room_fixed.ts', bad);
      expect(result).toBeInstanceOf(Date);
      expect(Number.isNaN(result.getTime())).toBe(false);
    }
  });
});
