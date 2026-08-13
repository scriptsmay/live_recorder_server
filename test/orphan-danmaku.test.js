const path = require('path');

const {
  getOrphanDanmakuPath,
  getOrphanDanmakuDir,
  getDiscardedOrphanDanmakuDir,
  hashRoomUrl,
  ORPHAN_DIR_NAME,
  DISCARDED_DIR_NAME,
} = require('../server/lib/utils/tool');

// ADR-012：孤儿弹幕路径工具函数 + OrphanDanmakuReconciler 核心逻辑
describe('getOrphanDanmakuPath', () => {
  const ORIGINAL_DIR = process.env.VIDEO_DOWNLOAD_DIR;

  afterEach(() => {
    if (ORIGINAL_DIR === undefined) {
      delete process.env.VIDEO_DOWNLOAD_DIR;
    } else {
      process.env.VIDEO_DOWNLOAD_DIR = ORIGINAL_DIR;
    }
  });

  test('按 roomUrl 和日期生成分片路径', () => {
    process.env.VIDEO_DOWNLOAD_DIR = '/data/video_downloads';
    const result = getOrphanDanmakuPath('https://live.kuaishou.com/u/xxx', new Date('2026-08-13'));
    expect(result).toContain(path.join('danmaku', ORPHAN_DIR_NAME, '2026-08-13'));
    expect(result).toMatch(/\.jsonl$/);
  });

  test('同一 roomUrl 不同天生成不同路径', () => {
    process.env.VIDEO_DOWNLOAD_DIR = '/data/video_downloads';
    const url = 'https://live.kuaishou.com/u/yyy';
    const p1 = getOrphanDanmakuPath(url, new Date('2026-08-01'));
    const p2 = getOrphanDanmakuPath(url, new Date('2026-08-02'));
    expect(p1).not.toBe(p2);
  });

  test('不同 roomUrl 同一天生成不同文件名', () => {
    process.env.VIDEO_DOWNLOAD_DIR = '/data/video_downloads';
    const p1 = getOrphanDanmakuPath('https://live.kuaishou.com/u/aaa', new Date('2026-08-13'));
    const p2 = getOrphanDanmakuPath('https://live.kuaishou.com/u/bbb', new Date('2026-08-13'));
    expect(path.basename(p1)).not.toBe(path.basename(p2));
  });

  test('roomUrl 为空时抛错', () => {
    process.env.VIDEO_DOWNLOAD_DIR = '/data/video_downloads';
    expect(() => getOrphanDanmakuPath('')).toThrow(/roomUrl/);
  });

  test('VIDEO_DOWNLOAD_DIR 未配置时抛错', () => {
    delete process.env.VIDEO_DOWNLOAD_DIR;
    expect(() => getOrphanDanmakuPath('http://test')).toThrow(/VIDEO_DOWNLOAD_DIR/);
  });
});

describe('hashRoomUrl', () => {
  test('返回 12 位十六进制字符串', () => {
    const hash = hashRoomUrl('https://live.kuaishou.com/u/test123');
    expect(hash).toHaveLength(12);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  test('相同 URL 产生相同 hash', () => {
    const url = 'https://example.com/room';
    expect(hashRoomUrl(url)).toBe(hashRoomUrl(url));
  });

  test('不同 URL 产生不同 hash', () => {
    expect(hashRoomUrl('http://a')).not.toBe(hashRoomUrl('http://b'));
  });

  test('空 URL 抛错', () => {
    expect(() => hashRoomUrl('')).toThrow();
    expect(() => hashRoomUrl(null)).toThrow();
  });
});

describe('getOrphanDanmakuDir / getDiscardedOrphanDanmakuDir', () => {
  const ORIGINAL_DIR = process.env.VIDEO_DOWNLOAD_DIR;

  afterEach(() => {
    if (ORIGINAL_DIR === undefined) {
      delete process.env.VIDEO_DOWNLOAD_DIR;
    } else {
      process.env.VIDEO_DOWNLOAD_DIR = ORIGINAL_DIR;
    }
  });

  test('orphan 目录在 danmaku/ 下', () => {
    process.env.VIDEO_DOWNLOAD_DIR = '/data/video_downloads';
    expect(getOrphanDanmakuDir()).toBe(path.join('/data/video_downloads', 'danmaku', ORPHAN_DIR_NAME));
  });

  test('discarded 目录在 danmaku/ 下', () => {
    process.env.VIDEO_DOWNLOAD_DIR = '/data/video_downloads';
    expect(getDiscardedOrphanDanmakuDir()).toBe(path.join('/data/video_downloads', 'danmaku', DISCARDED_DIR_NAME));
  });
});

// ============================================================
// OrphanDanmakuReconciler — ts_ms 重算 + 去重键测试
// ============================================================
jest.mock('../server/db/index', () => ({ query: jest.fn() }));

const OrphanDanmakuReconciler = require('../server/services/OrphanDanmakuReconciler');

describe('OrphanDanmakuReconciler._dedupKey', () => {
  test('comment 类型去重键包含 ts_abs_ms + type + user_id + text', () => {
    const ev = { ts_abs_ms: 1000, type: 'comment', user_id: 'u1', text: 'hello' };
    const key = OrphanDanmakuReconciler._dedupKey(ev);
    expect(key).toBe('1000|comment|u1|hello');
  });

  test('like 类型降级到 ts_abs_ms + type + count', () => {
    const ev = { ts_abs_ms: 2000, type: 'like', count: 5 };
    const key = OrphanDanmakuReconciler._dedupKey(ev);
    expect(key).toBe('2000|like|5');
  });

  test('gift 类型不含 count 字段也能正确生成键', () => {
    const ev = { ts_abs_ms: 3000, type: 'gift', user_id: 'u2', text: '' };
    const key = OrphanDanmakuReconciler._dedupKey(ev);
    expect(key).toBe('3000|gift|u2|');
  });
});

describe('OrphanDanmakuReconciler._readJsonl', () => {
  const fs = require('fs');
  const os = require('os');

  test('跳过 _meta 行和畸形行', () => {
    const tmpFile = path.join(os.tmpdir(), `test-orphan-${Date.now()}.jsonl`);
    const lines = [
      JSON.stringify({ _meta: { room_url: 'http://test', received_at: 1000 } }),
      JSON.stringify({ ts_abs_ms: 1000, type: 'comment', text: 'hello' }),
      'not-valid-json',
      JSON.stringify({ ts_abs_ms: 2000, type: 'like', count: 1 }),
      '',
    ];
    fs.writeFileSync(tmpFile, lines.join('\n'));

    const events = OrphanDanmakuReconciler._readJsonl(tmpFile);
    expect(events).toHaveLength(2);
    expect(events[0].text).toBe('hello');
    expect(events[1].type).toBe('like');

    fs.unlinkSync(tmpFile);
  });
});

describe('ts_ms 重算正确性（ADR-012 决策第 4 条）', () => {
  const fs = require('fs');
  const os = require('os');
  const { getDanmakuJsonlPath } = require('../server/lib/utils/tool');

  const ORIGINAL_DIR = process.env.VIDEO_DOWNLOAD_DIR;

  beforeEach(() => {
    process.env.VIDEO_DOWNLOAD_DIR = path.join(os.tmpdir(), `test-danmaku-${Date.now()}`);
    fs.mkdirSync(path.join(process.env.VIDEO_DOWNLOAD_DIR, 'danmaku'), { recursive: true });
  });

  afterEach(() => {
    if (ORIGINAL_DIR === undefined) {
      delete process.env.VIDEO_DOWNLOAD_DIR;
    } else {
      process.env.VIDEO_DOWNLOAD_DIR = ORIGINAL_DIR;
    }
  });

  test('ts_ms 按目标会话 started_ms 重算为相对偏移', () => {
    const sessionId = 999;
    const sessionStartMs = 1700000000000;
    const events = [
      { ts_abs_ms: sessionStartMs + 5000, type: 'comment', user_id: 'u1', text: 'a' },
      { ts_abs_ms: sessionStartMs + 120000, type: 'comment', user_id: 'u2', text: 'b' },
    ];

    const result = OrphanDanmakuReconciler._mergeToSessionJsonl(sessionId, sessionStartMs, events, 200);
    expect(result.written).toBe(2);
    expect(result.skipped).toBe(0);

    const targetPath = getDanmakuJsonlPath(sessionId);
    const content = fs.readFileSync(targetPath, 'utf-8');
    const written = content
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(written[0].ts_ms).toBe(5000);
    expect(written[1].ts_ms).toBe(120000);
    // ts_abs_ms 保留原值
    expect(written[0].ts_abs_ms).toBe(sessionStartMs + 5000);
  });

  test('ts_abs_ms 早于会话开始时 ts_ms 截断到 0', () => {
    const sessionId = 998;
    const sessionStartMs = 1700000000000;
    const events = [{ ts_abs_ms: sessionStartMs - 3000, type: 'like', count: 1 }];

    OrphanDanmakuReconciler._mergeToSessionJsonl(sessionId, sessionStartMs, events, 200);

    const targetPath = getDanmakuJsonlPath(sessionId);
    const content = fs.readFileSync(targetPath, 'utf-8');
    const written = JSON.parse(content.trim());
    expect(written.ts_ms).toBe(0);
  });

  test('去重：已存在事件不会重复写入', () => {
    const sessionId = 997;
    const sessionStartMs = 1700000000000;
    const targetPath = getDanmakuJsonlPath(sessionId);

    // 预置一条
    const existing = { ts_ms: 5000, ts_abs_ms: sessionStartMs + 5000, type: 'comment', user_id: 'u1', text: 'dup' };
    fs.writeFileSync(targetPath, JSON.stringify(existing) + '\n');

    const events = [
      { ts_abs_ms: sessionStartMs + 5000, type: 'comment', user_id: 'u1', text: 'dup' }, // 重复
      { ts_abs_ms: sessionStartMs + 6000, type: 'comment', user_id: 'u1', text: 'new' }, // 新
    ];

    const result = OrphanDanmakuReconciler._mergeToSessionJsonl(sessionId, sessionStartMs, events, 200);
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(1);
  });
});
