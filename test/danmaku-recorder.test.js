jest.mock('../db/index', () => ({
  query: jest.fn(),
}));

const DanmakuRecorder = require('../lib/core/danmaku/DanmakuRecorder');

// ============================================================
// _normalizeEvent 时间戳处理测试
// ============================================================

describe('DanmakuRecorder._normalizeEvent — 时间戳优先级', () => {
  const SESSION_START = 1700000000000; // 固定基准时间

  test('ts_abs_ms 优先于 ts_ms', () => {
    const event = {
      ts_abs_ms: SESSION_START + 5000,
      ts_ms: 99999, // 应该被忽略
      type: 'comment',
      user: 'Alice',
      text: 'hello',
    };

    const result = DanmakuRecorder._normalizeEvent(event, SESSION_START);
    expect(result.ts_ms).toBe(5000);
  });

  test('ts_ms > 0 时作为合法时间戳使用', () => {
    const event = {
      ts_ms: SESSION_START + 3000,
      type: 'comment',
      user: 'Bob',
      text: 'test',
    };

    const result = DanmakuRecorder._normalizeEvent(event, SESSION_START);
    expect(result.ts_ms).toBe(3000);
  });

  test('ts_ms = 0 不被当作合法值（falsy bug 修复）', () => {
    const event = {
      ts_ms: 0,
      type: 'comment',
      user: 'Charlie',
      text: 'zero-ts',
    };

    // 不提供 _receivedAt，会 fallback 到 Date.now()
    const nowBefore = Date.now();
    const result = DanmakuRecorder._normalizeEvent(event, SESSION_START);
    const nowAfter = Date.now();

    // tsRelative 应该基于 Date.now() - SESSION_START，是一个很大的正数
    expect(result.ts_ms).toBeGreaterThanOrEqual(nowBefore - SESSION_START);
    expect(result.ts_ms).toBeLessThanOrEqual(nowAfter - SESSION_START);
  });

  test('ts_ms = 0 时使用 _receivedAt 兜底', () => {
    const receivedAt = SESSION_START + 8000;
    const event = {
      ts_ms: 0,
      _receivedAt: receivedAt,
      type: 'comment',
      user: 'Dave',
      text: 'with-receivedAt',
    };

    const result = DanmakuRecorder._normalizeEvent(event, SESSION_START);
    expect(result.ts_ms).toBe(8000);
  });

  test('ts_ms 和 ts_abs_ms 都为 0 时回退到 _receivedAt', () => {
    const receivedAt = SESSION_START + 12000;
    const event = {
      ts_ms: 0,
      ts_abs_ms: 0,
      _receivedAt: receivedAt,
      type: 'comment',
      user: 'Eve',
      text: 'all-zero',
    };

    const result = DanmakuRecorder._normalizeEvent(event, SESSION_START);
    expect(result.ts_ms).toBe(12000);
  });

  test('ts_ms 和 ts_abs_ms 都为 undefined 时回退到 _receivedAt', () => {
    const receivedAt = SESSION_START + 15000;
    const event = {
      _receivedAt: receivedAt,
      type: 'comment',
      user: 'Frank',
      text: 'no-ts',
    };

    const result = DanmakuRecorder._normalizeEvent(event, SESSION_START);
    expect(result.ts_ms).toBe(15000);
  });

  test('时间戳不会被截断为负数', () => {
    // 事件时间早于会话开始
    const event = {
      ts_abs_ms: SESSION_START - 5000,
      type: 'comment',
      user: 'Grace',
      text: 'early-event',
    };

    const result = DanmakuRecorder._normalizeEvent(event, SESSION_START);
    expect(result.ts_ms).toBe(0); // Math.max(0, ...) 保护
  });

  test('sessionStartMs = 0 时直接使用绝对时间戳', () => {
    const event = {
      ts_abs_ms: 1700000005000,
      type: 'comment',
      user: 'Hank',
      text: 'no-session',
    };

    const result = DanmakuRecorder._normalizeEvent(event, 0);
    expect(result.ts_ms).toBe(1700000005000);
  });
});

// ============================================================
// _normalizeEvent 事件类型测试
// ============================================================

describe('DanmakuRecorder._normalizeEvent — 事件类型', () => {
  const SESSION_START = 1700000000000;

  test('comment 类型正确提取 username、user_id 和 text', () => {
    const event = {
      ts_abs_ms: SESSION_START + 1000,
      type: 'comment',
      user: 'TestUser',
      userId: 'uid_123',
      text: 'Hello World',
    };

    const result = DanmakuRecorder._normalizeEvent(event, SESSION_START);
    expect(result.type).toBe('comment');
    expect(result.username).toBe('TestUser');
    expect(result.user_id).toBe('uid_123');
    expect(result.text).toBe('Hello World');
  });

  test('comment 兼容 username 字段名', () => {
    const event = {
      ts_abs_ms: SESSION_START + 1500,
      type: 'comment',
      username: 'CompatUser',
      user_id: 'uid_compat',
      text: 'test compat',
    };

    const result = DanmakuRecorder._normalizeEvent(event, SESSION_START);
    expect(result.username).toBe('CompatUser');
    expect(result.user_id).toBe('uid_compat');
  });

  test('gift 类型正确提取 username、gift_name 和 count', () => {
    const event = {
      ts_abs_ms: SESSION_START + 2000,
      type: 'gift',
      user: 'Gifter',
      userId: 'uid_gift',
      giftName: 'rocket',
      count: 5,
    };

    const result = DanmakuRecorder._normalizeEvent(event, SESSION_START);
    expect(result.type).toBe('gift');
    expect(result.username).toBe('Gifter');
    expect(result.user_id).toBe('uid_gift');
    expect(result.gift_name).toBe('rocket');
    expect(result.count).toBe(5);
  });

  test('like 类型正确提取 count', () => {
    const event = {
      ts_abs_ms: SESSION_START + 3000,
      type: 'like',
      count: 42,
    };

    const result = DanmakuRecorder._normalizeEvent(event, SESSION_START);
    expect(result.type).toBe('like');
    expect(result.count).toBe(42);
  });

  test('username 字段超长被截断到 64 字符', () => {
    const event = {
      ts_abs_ms: SESSION_START + 4000,
      type: 'comment',
      user: 'A'.repeat(100),
      text: 'test',
    };

    const result = DanmakuRecorder._normalizeEvent(event, SESSION_START);
    expect(result.username.length).toBe(64);
  });

  test('text 字段超长被截断到 512 字符', () => {
    const event = {
      ts_abs_ms: SESSION_START + 5000,
      type: 'comment',
      user: 'test',
      text: 'B'.repeat(600),
    };

    const result = DanmakuRecorder._normalizeEvent(event, SESSION_START);
    expect(result.text.length).toBe(512);
  });
});

// ============================================================
// writeBatch 批次时间戳分配测试
// ============================================================

describe('DanmakuRecorder.writeBatch — 批次时间戳分配', () => {
  const fs = require('fs');

  beforeEach(() => {
    // 模拟一个活跃的 session
    DanmakuRecorder.activeSessions.set('http://test-room', {
      sessionId: 1,
      captureId: 1,
      fd: null, // 不需要真实文件描述符
      startedAt: 1700000000000,
      eventCount: 0,
      outputDir: '/tmp/test',
      rawPath: '/tmp/test/danmaku.jsonl',
    });

    // mock fs.writeSync 以捕获写入内容
    jest.spyOn(fs, 'writeSync').mockImplementation(() => {});
  });

  afterEach(() => {
    DanmakuRecorder.activeSessions.clear();
    jest.restoreAllMocks();
  });

  test('ts_ms=0 的批量事件获得不同的 _receivedAt', () => {
    const events = [
      { ts_ms: 0, type: 'comment', user: 'A', text: 'msg1' },
      { ts_ms: 0, type: 'comment', user: 'B', text: 'msg2' },
      { ts_ms: 0, type: 'comment', user: 'C', text: 'msg3' },
    ];

    // 捕获 _normalizeEvent 的输入
    const normalizeSpy = jest.spyOn(DanmakuRecorder, '_normalizeEvent');

    DanmakuRecorder.writeBatch('http://test-room', events);

    // 每条事件都应该被处理
    expect(normalizeSpy).toHaveBeenCalledTimes(3);

    // 检查分配给每条事件的 _receivedAt 是递增的
    const receivedAts = normalizeSpy.mock.calls.map((call) => call[0]._receivedAt);
    expect(receivedAts[0]).toBeDefined();
    expect(receivedAts[1]).toBeDefined();
    expect(receivedAts[2]).toBeDefined();
    expect(receivedAts[1]).toBeGreaterThan(receivedAts[0]);
    expect(receivedAts[2]).toBeGreaterThan(receivedAts[1]);

    normalizeSpy.mockRestore();
  });

  test('已有合法 ts_ms 的事件不会被分配 _receivedAt', () => {
    const events = [
      { ts_ms: 1700000005000, type: 'comment', user: 'A', text: 'has-ts' },
      { ts_ms: 0, type: 'comment', user: 'B', text: 'no-ts' },
    ];

    const normalizeSpy = jest.spyOn(DanmakuRecorder, '_normalizeEvent');

    DanmakuRecorder.writeBatch('http://test-room', events);

    // 第一条有合法 ts_ms，不应被分配 _receivedAt
    expect(normalizeSpy.mock.calls[0][0]._receivedAt).toBeUndefined();
    // 第二条 ts_ms=0，应该被分配 _receivedAt
    expect(normalizeSpy.mock.calls[1][0]._receivedAt).toBeDefined();

    normalizeSpy.mockRestore();
  });

  test('有合法 ts_abs_ms 的事件不会被分配 _receivedAt', () => {
    const events = [
      { ts_abs_ms: 1700000010000, type: 'comment', user: 'A', text: 'has-abs-ts' },
    ];

    const normalizeSpy = jest.spyOn(DanmakuRecorder, '_normalizeEvent');

    DanmakuRecorder.writeBatch('http://test-room', events);

    expect(normalizeSpy.mock.calls[0][0]._receivedAt).toBeUndefined();

    normalizeSpy.mockRestore();
  });
});
