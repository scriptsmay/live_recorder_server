// 弹幕查询接口的鉴权 + 端到端测试（TODO 9：v1.8.0 验收 #5/#6 补验）
//
// 当时 curl 被 auth wall 拦截，只做了底层数据校验，没有接口级验证。
// 这里用 supertest + 真实 requireAuth 中间件补上：
//   - auth wall：无 cookie / 无效 token 被 401，带合法 cookie 或 Bearer 才放行
//   - GET /api/danmaku/search：入参校验、JSONL 缺失兜底、关键词筛选、分页、字段归一化
//   - GET /api/danmaku/sessions/:id/raw：记录缺失 / 文件缺失 / 正常下载
//
// JSONL 用真实临时目录（不 mock fs），确保 getDanmakuJsonlPath 推导的路径与读文件链路真实生效。
jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({ get: jest.fn(), set: jest.fn(), del: jest.fn() }));
jest.mock('../server/lib/core/auth-service', () => ({ getSession: jest.fn() }));
jest.mock('../server/lib/core/danmaku/DanmakuRecorder', () => ({
  getStatus: jest.fn(),
  appendBatch: jest.fn(),
}));
jest.mock('../server/services/OrphanDanmakuReconciler', () => ({
  listOrphanRecords: jest.fn(),
  reconcile: jest.fn(),
  reconcileAll: jest.fn(),
  discard: jest.fn(),
}));
jest.mock('../server/services/DataService', () => ({ getSessionDetail: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const pool = require('../server/db/index');
const { getSession } = require('../server/lib/core/auth-service');
const { requireAuth } = require('../server/middleware/require-auth');
const danmakuRouter = require('../server/router/danmaku');

const VALID_TOKEN = 'valid-session-token';
const SESSION_ID = 42;

let tmpRoot;
let danmakuDir;

/**
 * 挂载方式对齐 server/router/index.js：/api/* 统一过 requireAuth()，
 * 只有 /api/danmaku/batch 在白名单里（本文件不测 batch，故不做例外分支）。
 */
function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const authMiddleware = requireAuth();
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    return authMiddleware(req, res, next);
  });
  app.use('/api', danmakuRouter);
  return app;
}

let app;

// 带合法 cookie 的请求
function authed(method, url) {
  return request(app)[method](url).set('Cookie', `auth_token=${VALID_TOKEN}`);
}

function writeJsonl(sessionId, lines) {
  const filePath = path.join(danmakuDir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');
  return filePath;
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-routes-'));
  danmakuDir = path.join(tmpRoot, 'danmaku');
  fs.mkdirSync(danmakuDir, { recursive: true });
  process.env.VIDEO_DOWNLOAD_DIR = tmpRoot;
  delete process.env.AUTH_ENABLED; // 非 'false' 即为开启鉴权
  delete process.env.AUTH_COOKIE_NAME; // 用默认 auth_token
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  // 默认：VALID_TOKEN 有效，其他 token 无 session
  getSession.mockImplementation(async (token) => (token === VALID_TOKEN ? { username: 'admin', createdAt: 1 } : null));
  app = createApp();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

// ========== auth wall ==========

describe('弹幕查询接口的 auth wall', () => {
  test.each([
    ['/api/danmaku/search?session_id=42', 'search'],
    ['/api/danmaku/sessions/42/raw', 'raw'],
  ])('无 cookie 时 %s 返回 401', async (url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
    // 被拦在鉴权层，业务查询不应发生
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('无效 token 返回 401', async () => {
    const res = await request(app).get('/api/danmaku/search?session_id=42').set('Cookie', 'auth_token=stale');
    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('getSession 抛错也按未授权处理', async () => {
    getSession.mockRejectedValueOnce(new Error('redis down'));
    const res = await request(app).get('/api/danmaku/search?session_id=42').set('Cookie', `auth_token=${VALID_TOKEN}`);
    expect(res.status).toBe(401);
  });

  test('Authorization: Bearer 也能通过', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: SESSION_ID }] });
    const res = await request(app)
      .get(`/api/danmaku/search?session_id=${SESSION_ID}`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
  });

  test('AUTH_ENABLED=false 时放行', async () => {
    process.env.AUTH_ENABLED = 'false';
    try {
      pool.query.mockResolvedValueOnce({ rows: [{ id: SESSION_ID }] });
      const res = await request(app).get(`/api/danmaku/search?session_id=${SESSION_ID}`);
      expect(res.status).toBe(200);
      expect(getSession).not.toHaveBeenCalled();
    } finally {
      delete process.env.AUTH_ENABLED;
    }
  });
});

// ========== GET /api/danmaku/search ==========

describe('GET /api/danmaku/search', () => {
  test('缺少 session_id 返回 400', async () => {
    const res = await authed('get', '/api/danmaku/search');
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('session_id');
  });

  test('会话不存在返回 404', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await authed('get', '/api/danmaku/search?session_id=999');
    expect(res.status).toBe(404);
  });

  test('JSONL 文件不存在时返回空结果而非报错', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 777 }] });
    const res = await authed('get', '/api/danmaku/search?session_id=777');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', data: [], total: 0 });
  });

  test('正常返回 — 只取 comment 事件，ts_str 格式化，username/user_id 归一化', async () => {
    writeJsonl(SESSION_ID, [
      { type: 'meta', room_url: 'https://live.kuaishou.com/u/x' },
      { type: 'comment', text: '开播啦', ts_ms: 3723000, user: '老王', userId: 'u-1' },
      { type: 'comment', text: '有弹幕', ts_ms: 1000, username: '小李', user_id: 'u-2' },
      { type: 'gift', text: '送了礼物', ts_ms: 2000 },
      { type: 'comment', ts_ms: 3000 }, // 无 text，应被过滤
    ]);
    pool.query.mockResolvedValueOnce({ rows: [{ id: SESSION_ID }] });

    const res = await authed('get', `/api/danmaku/search?session_id=${SESSION_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({
      text: '开播啦',
      ts_str: '01:02:03',
      username: '老王',
      user_id: 'u-1',
    });
    expect(res.body.data[1]).toMatchObject({ text: '有弹幕', ts_str: '00:00:01', username: '小李', user_id: 'u-2' });
  });

  test('keyword 同时匹配文本 / 用户名 / user_id，且大小写不敏感', async () => {
    writeJsonl(SESSION_ID, [
      { type: 'comment', text: 'Hello World', ts_ms: 0, username: 'aaa', user_id: 'u-1' },
      { type: 'comment', text: '无关内容', ts_ms: 0, username: 'HELLO_fan', user_id: 'u-2' },
      { type: 'comment', text: '也无关', ts_ms: 0, username: 'bbb', user_id: 'hello-3' },
      { type: 'comment', text: '完全不相关', ts_ms: 0, username: 'ccc', user_id: 'u-4' },
    ]);
    pool.query.mockResolvedValueOnce({ rows: [{ id: SESSION_ID }] });

    const res = await authed('get', `/api/danmaku/search?session_id=${SESSION_ID}&keyword=hello`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
  });

  test('分页 — offset/limit 生效且 total 为筛选后总数', async () => {
    writeJsonl(
      SESSION_ID,
      Array.from({ length: 10 }, (_, i) => ({ type: 'comment', text: `msg-${i}`, ts_ms: i * 1000 }))
    );
    pool.query.mockResolvedValueOnce({ rows: [{ id: SESSION_ID }] });

    const res = await authed('get', `/api/danmaku/search?session_id=${SESSION_ID}&offset=8&limit=5`);

    expect(res.body.total).toBe(10);
    expect(res.body.offset).toBe(8);
    expect(res.body.limit).toBe(5);
    expect(res.body.data.map((d) => d.text)).toEqual(['msg-8', 'msg-9']);
  });

  test('limit 超过 200 被收敛到 200', async () => {
    writeJsonl(SESSION_ID, [{ type: 'comment', text: 'x', ts_ms: 0 }]);
    pool.query.mockResolvedValueOnce({ rows: [{ id: SESSION_ID }] });

    const res = await authed('get', `/api/danmaku/search?session_id=${SESSION_ID}&limit=9999`);

    expect(res.body.limit).toBe(200);
  });

  test('DB 异常返回 500', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection refused'));
    const res = await authed('get', `/api/danmaku/search?session_id=${SESSION_ID}`);
    expect(res.status).toBe(500);
  });
});

// ========== GET /api/danmaku/sessions/:id/raw ==========

describe('GET /api/danmaku/sessions/:id/raw', () => {
  test('无采集记录返回 404', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await authed('get', '/api/danmaku/sessions/42/raw');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('弹幕记录不存在');
  });

  test('raw_path 为空返回 404', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ raw_path: null }] });
    const res = await authed('get', '/api/danmaku/sessions/42/raw');
    expect(res.status).toBe(404);
  });

  test('raw_path 指向的文件已丢失返回 404', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ raw_path: path.join(danmakuDir, 'not-exist.jsonl') }] });
    const res = await authed('get', '/api/danmaku/sessions/42/raw');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('JSONL 文件不存在');
  });

  test('正常下载 — 返回 attachment 且内容与磁盘一致', async () => {
    const filePath = writeJsonl(1001, [{ type: 'comment', text: '下载我', ts_ms: 0 }]);
    pool.query.mockResolvedValueOnce({ rows: [{ raw_path: filePath }] });

    const res = await authed('get', '/api/danmaku/sessions/1001/raw');

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('1001.jsonl');
    // .jsonl 走 octet-stream，supertest 把响应体给成 Buffer
    const downloaded = Buffer.isBuffer(res.body) ? res.body.toString('utf-8') : res.text;
    expect(downloaded).toBe(fs.readFileSync(filePath, 'utf-8'));
  });

  test('按 session_id 取最新一条记录（ORDER BY id DESC LIMIT 1）', async () => {
    const filePath = writeJsonl(1002, [{ type: 'comment', text: 'latest', ts_ms: 0 }]);
    pool.query.mockResolvedValueOnce({ rows: [{ raw_path: filePath }] });

    await authed('get', '/api/danmaku/sessions/1002/raw');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('ORDER BY id DESC LIMIT 1');
    expect(params).toEqual([1002]);
  });

  test('DB 异常返回 500 且不泄漏内部错误信息', async () => {
    pool.query.mockRejectedValueOnce(new Error('relation does not exist'));
    const res = await authed('get', '/api/danmaku/sessions/42/raw');
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('下载失败');
  });
});
