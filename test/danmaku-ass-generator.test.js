const fs = require('fs');
const path = require('path');
const pool = require('../server/db/index');

jest.mock('../server/db/index', () => ({
  query: jest.fn(),
}));

const danmakuAssGenerator = require('../server/lib/core/danmaku/DanmakuAssGenerator');

// ============================================================
// 辅助函数：创建临时测试目录和 mock 数据
// ============================================================

const TMP_DIR = path.join(__dirname, 'tmp_danmaku_test');

function makeJsonlPath(filename) {
  return path.join(TMP_DIR, filename);
}

function writeMockJsonl(filepath, events) {
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  if (!fs.existsSync(path.dirname(filepath))) {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
  }
  fs.writeFileSync(filepath, lines, 'utf-8');
}

function makeComment(ts_ms, text, user) {
  return { ts_ms, type: 'comment', text, user: user || 'test_user' };
}

function makeGift(ts_ms, giftName) {
  return { ts_ms, type: 'gift', text: giftName };
}

// ============================================================
// T2-8: ASS 特殊字符转义
// ============================================================

describe('DanmakuAssGenerator._escapeAssText', () => {
  test('普通文本不转义', () => {
    expect(danmakuAssGenerator._escapeAssText('你好世界')).toBe('你好世界');
  });

  test('转义反斜杠', () => {
    expect(danmakuAssGenerator._escapeAssText('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  test('转义花括号', () => {
    expect(danmakuAssGenerator._escapeAssText('{hello}')).toBe('\\{hello\\}');
  });

  test('转义换行符 \\n → \\N', () => {
    expect(danmakuAssGenerator._escapeAssText('第一行\n第二行')).toBe('第一行\\N第二行');
  });

  test('删除回车符 \\r', () => {
    expect(danmakuAssGenerator._escapeAssText('line\r\n')).toBe('line\\N');
  });

  test('处理组合特殊字符', () => {
    expect(danmakuAssGenerator._escapeAssText('\\{弹幕\\}')).toBe('\\\\\\{弹幕\\\\\\}');
  });

  test('空字符串返回空', () => {
    expect(danmakuAssGenerator._escapeAssText('')).toBe('');
    expect(danmakuAssGenerator._escapeAssText(null)).toBe('');
    expect(danmakuAssGenerator._escapeAssText()).toBe('');
  });

  test('emoji 不转义', () => {
    expect(danmakuAssGenerator._escapeAssText('哈哈😂666')).toBe('哈哈😂666');
  });
});

// ============================================================
// _msToAssTime — 毫秒转 ASS 时间格式
// ============================================================

describe('DanmakuAssGenerator._msToAssTime', () => {
  test('0ms → 0:00:00.00', () => {
    expect(danmakuAssGenerator._msToAssTime(0)).toBe('0:00:00.00');
  });

  test('1s → 0:00:01.00', () => {
    expect(danmakuAssGenerator._msToAssTime(1000)).toBe('0:00:01.00');
  });

  test('1min → 0:01:00.00', () => {
    expect(danmakuAssGenerator._msToAssTime(60000)).toBe('0:01:00.00');
  });

  test('1h → 1:00:00.00', () => {
    expect(danmakuAssGenerator._msToAssTime(3600000)).toBe('1:00:00.00');
  });

  test('90 分 30 秒 → 1:30:30.00', () => {
    expect(danmakuAssGenerator._msToAssTime(5430000)).toBe('1:30:30.00');
  });

  test('精确到 centisecond', () => {
    // 12345ms = 1234.5cs → 1234cs → 20s + 34cs
    expect(danmakuAssGenerator._msToAssTime(12345)).toBe('0:00:12.34');
  });

  test('大时间值（>24h）', () => {
    // 25h = 90000000ms
    expect(danmakuAssGenerator._msToAssTime(90000000)).toBe('25:00:00.00');
  });
});

// ============================================================
// _scaleFontSize — 按视频高度缩放字号
// ============================================================

describe('DanmakuAssGenerator._scaleFontSize', () => {
  test('1080p 使用原始字号', () => {
    expect(danmakuAssGenerator._scaleFontSize(32, 1080)).toBe(32);
  });

  test('2160p (4K) 也使用原始字号', () => {
    expect(danmakuAssGenerator._scaleFontSize(32, 2160)).toBe(32);
  });

  test('720p 缩放至 75%', () => {
    expect(danmakuAssGenerator._scaleFontSize(32, 720)).toBe(24);
  });

  test('480p 缩放至 60%', () => {
    expect(danmakuAssGenerator._scaleFontSize(32, 480)).toBe(19);
  });

  test('360p 缩放至 50%', () => {
    expect(danmakuAssGenerator._scaleFontSize(32, 360)).toBe(16);
  });
});

// ============================================================
// T2-10: 密度限制 _applyDensityLimit
// ============================================================

describe('DanmakuAssGenerator._applyDensityLimit', () => {
  test('不限制时返回全部', () => {
    const events = [makeComment(0, '弹幕1'), makeComment(500, '弹幕2'), makeComment(900, '弹幕3')];
    const result = danmakuAssGenerator._applyDensityLimit(events, 0);
    expect(result).toHaveLength(3);
  });

  test('maxPerSecond=2 限制生效', () => {
    const events = [
      makeComment(100, '弹幕1'),
      makeComment(200, '弹幕2'),
      makeComment(300, '弹幕3'), // 第 3 条丢弃
      makeComment(400, '弹幕4'), // 第 4 条丢弃
    ];
    const result = danmakuAssGenerator._applyDensityLimit(events, 2);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('弹幕1');
    expect(result[1].text).toBe('弹幕2');
  });

  test('跨秒窗口重置计数', () => {
    const events = [
      makeComment(100, '秒0-1'),
      makeComment(200, '秒0-2'),
      makeComment(900, '秒0-3'), // 丢弃
      makeComment(1100, '秒1-1'),
      makeComment(1200, '秒1-2'),
      makeComment(1900, '秒1-3'), // 丢弃
      makeComment(2100, '秒2-1'),
    ];
    const result = danmakuAssGenerator._applyDensityLimit(events, 2);
    expect(result).toHaveLength(5);
    expect(result.map((e) => e.text)).toEqual(['秒0-1', '秒0-2', '秒1-1', '秒1-2', '秒2-1']);
  });

  test('每毫秒边界都正确重置', () => {
    const events = [
      makeComment(999, '0秒最后'),
      makeComment(1000, '1秒首条'),
      makeComment(1001, '1秒第2条'),
      makeComment(1900, '1秒第3条'), // 丢弃
    ];
    const result = danmakuAssGenerator._applyDensityLimit(events, 2);
    expect(result).toHaveLength(3);
  });

  test('空数组返回空', () => {
    expect(danmakuAssGenerator._applyDensityLimit([], 10)).toEqual([]);
  });
});

// ============================================================
// T2-9: 轨道分配 _generateAssEvents
// ============================================================

describe('DanmakuAssGenerator._generateAssEvents', () => {
  const videoWidth = 1920;
  const videoHeight = 1080;
  const style = {
    fontName: 'Noto Sans CJK SC',
    fontSize: 32,
    outline: 2,
    shadow: 0,
    alpha: 0x4d,
    scrollDuration: 10000,
    screenUsage: 0.65,
  };

  test('单条弹幕分配到轨道 0', () => {
    const comments = [makeComment(0, '弹幕1')];
    const events = danmakuAssGenerator._generateAssEvents(comments, videoWidth, videoHeight, style, null);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('\\move(');
    expect(events[0]).toContain('弹幕1');
  });

  test('多条同时弹幕分配到不同轨道', () => {
    const comments = [makeComment(100, '弹幕A'), makeComment(100, '弹幕B'), makeComment(100, '弹幕C')];
    const events = danmakuAssGenerator._generateAssEvents(comments, videoWidth, videoHeight, style, null);
    expect(events).toHaveLength(3);

    // 同一时间的弹幕应分到不同轨道 → y 值不同
    const yValues = events.map((e) => {
      const match = e.match(/\\move\(\d+,(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    });
    const uniqueY = new Set(yValues);
    expect(uniqueY.size).toBe(3);
  });

  test('轨道占用过期后复用', () => {
    // 第一条在 t=0，持续到 t=10000
    // 第二条在 t=11000，轨道 0 已空闲
    const comments = [makeComment(0, '弹幕1'), makeComment(11000, '弹幕2')];
    const events = danmakuAssGenerator._generateAssEvents(comments, videoWidth, videoHeight, style, null);
    expect(events).toHaveLength(2);

    // 两条应分配到同一轨道的同一 y 值
    const yValues = events.map((e) => {
      const match = e.match(/\\move\(\d+,(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    });
    expect(yValues[0]).toBe(yValues[1]);
  });

  test('轨道满时丢弃新弹幕', () => {
    // 创建大量同时弹幕，超过 maxTracks
    const maxTracks = Math.floor((1080 * 0.65) / 36); // fontSize(32) + 4 = 36
    const comments = [];
    for (let i = 0; i < maxTracks + 5; i++) {
      comments.push(makeComment(0, `弹幕${i}`));
    }

    const events = danmakuAssGenerator._generateAssEvents(comments, videoWidth, videoHeight, style, null);
    expect(events.length).toBeLessThanOrEqual(maxTracks);
  });

  test('超过 80 字符的弹幕被丢弃', () => {
    const comments = [makeComment(0, 'A'.repeat(81)), makeComment(100, '正常弹幕')];
    const events = danmakuAssGenerator._generateAssEvents(comments, videoWidth, videoHeight, style, null);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('正常弹幕');
  });

  test('空文本弹幕被丢弃', () => {
    const comments = [makeComment(0, '   '), makeComment(100, '有效弹幕')];
    const events = danmakuAssGenerator._generateAssEvents(comments, videoWidth, videoHeight, style, null);
    expect(events).toHaveLength(1);
  });

  test('durationMs 截断', () => {
    const comments = [
      makeComment(0, '前半段'),
      makeComment(60000, '后半段'), // 超过 30s duration
    ];
    const events = danmakuAssGenerator._generateAssEvents(
      comments,
      videoWidth,
      videoHeight,
      style,
      30000 // 只取 0-30s
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('前半段');
  });

  test('ASS 转义在 generate 中生效', () => {
    const comments = [makeComment(0, 'test\\{path\\}')];
    const events = danmakuAssGenerator._generateAssEvents(comments, videoWidth, videoHeight, style, null);
    expect(events).toHaveLength(1);
    // 花括号应被转义，不会裸出现在 ASS 中
    // 原始文本 test\{path\} 经过转义后，{ 变为 \{，输出中不会有裸的 {
    // 注意：由于 JS 字符串中 \\{ 表示字面量 \{，_escapeAssText 会把 \→\\, {→\{
    // 最终 ASS 中会出现 \\\{ (三个反斜杠后跟花括号)，这是正确的 ASS 转义
    expect(events[0]).toContain('test');
    expect(events[0]).not.toContain('{path}');
  });

  test('生成的 ASS 时间格式正确', () => {
    const comments = [makeComment(12345, '弹幕')];
    const events = danmakuAssGenerator._generateAssEvents(comments, videoWidth, videoHeight, style, null);
    expect(events).toHaveLength(1);
    // 检查 Dialogue 格式
    expect(events[0]).toMatch(/^Dialogue: 0,\d:\d{2}:\d{2}\.\d{2},\d:\d{2}:\d{2}\.\d{2}/);
  });
});

// ============================================================
// _buildAssFile — ASS 文件整体构建
// ============================================================

describe('DanmakuAssGenerator._buildAssFile', () => {
  const style = {
    fontName: 'TestFont',
    fontSize: 28,
    outline: 2,
    shadow: 0,
    alpha: 0x4d,
    screenUsage: 0.65,
  };

  test('ASS 文件包含必需的头部', () => {
    const ass = danmakuAssGenerator._buildAssFile(1920, 1080, style, []);
    expect(ass).toContain('[Script Info]');
    expect(ass).toContain('PlayResX: 1920');
    expect(ass).toContain('PlayResY: 1080');
    expect(ass).toContain('[V4+ Styles]');
    expect(ass).toContain('[Events]');
  });

  test('包含字体名称', () => {
    const ass = danmakuAssGenerator._buildAssFile(1920, 1080, style, []);
    expect(ass).toContain('TestFont');
  });

  test('包含 alpha 颜色编码', () => {
    const ass = danmakuAssGenerator._buildAssFile(1920, 1080, style, []);
    expect(ass).toContain('&H4DFFFFFF');
  });

  test('包含样式定义行', () => {
    const ass = danmakuAssGenerator._buildAssFile(1920, 1080, style, []);
    expect(ass).toContain('Style: Scroll,');
    expect(ass).toContain(',2,20,20,80,1');
  });

  test('720p 字号缩放', () => {
    const ass = danmakuAssGenerator._buildAssFile(1280, 720, style, []);
    // fontSize=28 * 0.75 = 21
    expect(ass).toContain(',21,');
  });
});

// ============================================================
// T2-12: 端到端 generateFromJsonl（mock fs + db）
// ============================================================

describe('DanmakuAssGenerator.generateFromJsonl', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Mock DB query — default return no settings
    pool.query.mockResolvedValue({ rows: [] });

    // Create tmp dir
    fs.mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('正常生成 ASS 文件', async () => {
    const jsonlPath = makeJsonlPath('test.jsonl');
    const assPath = makeJsonlPath('test.ass');

    writeMockJsonl(jsonlPath, [
      makeComment(0, '第一条弹幕'),
      makeComment(2000, '第二条弹幕'),
      makeComment(5000, '第三条弹幕'),
    ]);

    const result = await danmakuAssGenerator.generateFromJsonl({
      jsonlPath,
      assPath,
    });

    expect(result.success).toBe(true);
    expect(result.eventCount).toBe(3);
    expect(fs.existsSync(assPath)).toBe(true);

    const assContent = fs.readFileSync(assPath, 'utf-8');
    expect(assContent).toContain('第一条弹幕');
    expect(assContent).toContain('第二条弹幕');
    expect(assContent).toContain('第三条弹幕');
    expect(assContent).toContain('[Events]');
  });

  test('空 JSONL 返回 no_events', async () => {
    const jsonlPath = makeJsonlPath('empty.jsonl');
    const assPath = makeJsonlPath('empty.ass');
    fs.writeFileSync(jsonlPath, '', 'utf-8');

    const result = await danmakuAssGenerator.generateFromJsonl({
      jsonlPath,
      assPath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('no_events');
  });

  test('JSONL 不存在抛出异常', async () => {
    const result = await danmakuAssGenerator.generateFromJsonl({
      jsonlPath: makeJsonlPath('nope.jsonl'),
      assPath: makeJsonlPath('nope.ass'),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('JSONL 文件不存在');
  });

  test('只有礼物没有评论文本时返回 no_comments', async () => {
    const jsonlPath = makeJsonlPath('gifts.jsonl');
    const assPath = makeJsonlPath('gifts.ass');

    writeMockJsonl(jsonlPath, [makeGift(100, '玫瑰花'), makeGift(200, '啤酒')]);

    const result = await danmakuAssGenerator.generateFromJsonl({
      jsonlPath,
      assPath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('no_comments');
  });

  test('过滤无效行，正常弹幕不受影响', async () => {
    const jsonlPath = makeJsonlPath('with_invalid.jsonl');
    const assPath = makeJsonlPath('with_invalid.ass');

    fs.writeFileSync(
      jsonlPath,
      [
        JSON.stringify(makeComment(0, '正常弹幕')),
        '',
        '这不是JSON',
        JSON.stringify(makeComment(1000, '也是正常弹幕')),
      ].join('\n'),
      'utf-8'
    );

    const result = await danmakuAssGenerator.generateFromJsonl({
      jsonlPath,
      assPath,
    });

    expect(result.success).toBe(true);
    expect(result.eventCount).toBe(2);
  });

  test('使用 settings 中的密度限制', async () => {
    pool.query.mockResolvedValue({ rows: [{ key: 'danmaku_density_per_second', value: '1' }] });

    const jsonlPath = makeJsonlPath('density.jsonl');
    const assPath = makeJsonlPath('density.ass');

    const comments = [];
    for (let i = 0; i < 10; i++) {
      comments.push(makeComment(i * 100, `弹幕${i}`));
    }
    writeMockJsonl(jsonlPath, comments);

    const result = await danmakuAssGenerator.generateFromJsonl({
      jsonlPath,
      assPath,
    });

    expect(result.success).toBe(true);
    // 10 条弹幕分散在 1 秒内，密度限制为 1 条/秒 → 只有 1 条
    expect(result.eventCount).toBe(1);
  });

  test('读取数据库样式覆盖默认样式', async () => {
    pool.query.mockImplementation((sql, params) => {
      if (params && params[0] === 'danmaku_font_family') {
        return Promise.resolve({ rows: [{ value: 'WenQuanYi Micro Hei' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const jsonlPath = makeJsonlPath('font.jsonl');
    const assPath = makeJsonlPath('font.ass');

    writeMockJsonl(jsonlPath, [makeComment(0, '字体测试')]);

    await danmakuAssGenerator.generateFromJsonl({
      jsonlPath,
      assPath,
    });

    const assContent = fs.readFileSync(assPath, 'utf-8');
    expect(assContent).toContain('WenQuanYi Micro Hei');
  });

  test('时间偏移 offsetMs 将弹幕整体延迟', async () => {
    const jsonlPath = makeJsonlPath('offset.jsonl');
    const assPath = makeJsonlPath('offset.ass');

    writeMockJsonl(jsonlPath, [makeComment(0, '原始时间0'), makeComment(1000, '原始时间1000')]);

    // offsetMs=5000: 弹幕整体延迟 5 秒
    await danmakuAssGenerator.generateFromJsonl({
      jsonlPath,
      assPath,
      offsetMs: 5000,
    });

    const assContent = fs.readFileSync(assPath, 'utf-8');
    // 0ms → 5000ms → 0:00:05.00
    expect(assContent).toContain('0:00:05.00');
    expect(assContent).not.toContain('0:00:00.00'); // 原始 0 时间已偏移
  });

  test('负偏移 offsetMs 将弹幕提前，但不小于 0', async () => {
    const jsonlPath = makeJsonlPath('neg_offset.jsonl');
    const assPath = makeJsonlPath('neg_offset.ass');

    writeMockJsonl(jsonlPath, [makeComment(2000, '原始时间2000')]);

    // offsetMs=-3000: 2000-3000=-1000 → max(0, -1000) = 0
    await danmakuAssGenerator.generateFromJsonl({
      jsonlPath,
      assPath,
      offsetMs: -3000,
    });

    const assContent = fs.readFileSync(assPath, 'utf-8');
    expect(assContent).toContain('0:00:00.00');
  });
});

// ============================================================
// T2-11: 分段裁剪 generateSegmentAss
// ============================================================

describe('DanmakuAssGenerator.generateSegmentAss', () => {
  const videoWidth = 1920;
  const videoHeight = 1080;
  const jsonlPath = makeJsonlPath('segments.jsonl');
  const outputDir = path.join(TMP_DIR, 'danmaku_segments');

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [] });

    fs.mkdirSync(TMP_DIR, { recursive: true });

    // 创建跨 3 分钟时间轴的弹幕
    writeMockJsonl(jsonlPath, [
      makeComment(0, '分段0-弹幕1'),
      makeComment(30000, '分段0-弹幕2'),
      makeComment(59000, '分段0-弹幕3'),
      makeComment(61000, '分段1-弹幕1'),
      makeComment(90000, '分段1-弹幕2'),
      makeComment(119000, '分段1-弹幕3'),
      makeComment(121000, '分段2-弹幕1'),
      makeComment(150000, '分段2-弹幕2'),
    ]);
  });

  afterEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('为 3 个分段生成独立 ASS', async () => {
    const segments = [
      { id: 101, segment_start_ms: 0, segment_end_ms: 60000 },
      { id: 102, segment_start_ms: 60000, segment_end_ms: 120000 },
      { id: 103, segment_start_ms: 120000, segment_end_ms: 180000 },
    ];

    const results = await danmakuAssGenerator.generateSegmentAss({
      jsonlPath,
      outputDir,
      segments,
      videoWidth,
      videoHeight,
    });

    expect(results).toHaveLength(3);
    expect(results[0].id).toBe(101);
    expect(results[1].id).toBe(102);
    expect(results[2].id).toBe(103);

    // 每个分段 ASS 文件存在
    results.forEach((r) => {
      expect(fs.existsSync(r.assPath)).toBe(true);
    });
  });

  test('时间窗口精确筛选弹幕', async () => {
    const segments = [{ id: 101, segment_start_ms: 0, segment_end_ms: 60000 }];

    const results = await danmakuAssGenerator.generateSegmentAss({
      jsonlPath,
      outputDir,
      segments,
    });

    expect(results).toHaveLength(1);
    const assContent = fs.readFileSync(results[0].assPath, 'utf-8');
    expect(assContent).toContain('分段0-弹幕1');
    expect(assContent).toContain('分段0-弹幕2');
    expect(assContent).toContain('分段0-弹幕3');
    expect(assContent).not.toContain('分段1');
    expect(assContent).not.toContain('分段2');
  });

  test('时间归一化到分段 0 点', async () => {
    const segments = [{ id: 102, segment_start_ms: 60000, segment_end_ms: 120000 }];

    const results = await danmakuAssGenerator.generateSegmentAss({
      jsonlPath,
      outputDir,
      segments,
    });

    expect(results).toHaveLength(1);
    const assContent = fs.readFileSync(results[0].assPath, 'utf-8');

    // 61234ms 归一化后应为 1234ms → 0:00:01.23
    expect(assContent).toContain('分段1-弹幕1');
    // 原始 61000ms 归一化 → 1000ms = 0:00:01.00
    expect(assContent).toMatch(/0:00:0[01]\.\d{2}/);
  });

  test('segment_end_ms=0 时视为无限（取所有后续弹幕）', async () => {
    const segments = [{ id: 104, segment_start_ms: 120000, segment_end_ms: 0 }];

    const results = await danmakuAssGenerator.generateSegmentAss({
      jsonlPath,
      outputDir,
      segments,
    });

    expect(results).toHaveLength(1);
    const assContent = fs.readFileSync(results[0].assPath, 'utf-8');
    expect(assContent).toContain('分段2-弹幕1');
    expect(assContent).toContain('分段2-弹幕2');
  });

  test('空分段生成空 ASS', async () => {
    // 时间窗口内无弹幕
    const segments = [{ id: 999, segment_start_ms: 999999, segment_end_ms: 1000000 }];

    const results = await danmakuAssGenerator.generateSegmentAss({
      jsonlPath,
      outputDir,
      segments,
    });

    expect(results).toHaveLength(1);
    expect(results[0].eventCount).toBe(0);
  });

  test('自动创建输出目录', async () => {
    const nonExistentDir = path.join(TMP_DIR, 'auto_created');
    const segments = [{ id: 1, segment_start_ms: 0, segment_end_ms: 60000 }];

    await danmakuAssGenerator.generateSegmentAss({
      jsonlPath,
      outputDir: nonExistentDir,
      segments,
    });

    expect(fs.existsSync(nonExistentDir)).toBe(true);
  });
});
