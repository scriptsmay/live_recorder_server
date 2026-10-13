jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({
  get: jest.fn(),
  set: jest.fn(),
  setEx: jest.fn(),
  del: jest.fn(),
}));
jest.mock('../server/lib/core/auth-service', () => ({ getSession: jest.fn() }));
jest.mock('../server/lib/utils/biliup-cookie', () => ({ loadBiliupCookie: jest.fn() }));
jest.mock('../server/lib/core/bilibili-season', () => ({ checkLogin: jest.fn() }));
jest.mock('../server/services/SeasonService', () => ({ listSeasonsByCookies: jest.fn() }));

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const pool = require('../server/db/index');
const { getSession } = require('../server/lib/core/auth-service');
const { loadBiliupCookie } = require('../server/lib/utils/biliup-cookie');
const { checkLogin } = require('../server/lib/core/bilibili-season');
const SeasonService = require('../server/services/SeasonService');
const { requireAuth } = require('../server/middleware/require-auth');

const VALID_TOKEN = 'valid-session-token';
const COOKIES_PATH = '/data/biliup/cookies_bengtiezi.json';
// 凭证哨兵：任何响应体或服务端日志里出现都算泄漏
const SECRET_VALUES = ['SESSDATA-SENTINEL-abcdef', 'BILI_JCT-SENTINEL-012345', 'DedeUserID-SENTINEL-9527'];

const ACCOUNT_ROW = {
  id: 3,
  name: '奔波儿灞的小号',
  cookies_path: COOKIES_PATH,
  uid: '9527',
  nickname: '奔波儿灞',
  login_status: 'unknown',
  last_checked_at: null,
  created_at: '2026-10-13T00:00:00.000Z',
};

let app;

function authed(method, url) {
  return request(app)[method](url).set('Cookie', `auth_token=${VALID_TOKEN}`);
}

function leakIn(payload) {
  const text = JSON.stringify(payload) + String(payload);
  return SECRET_VALUES.filter((secret) => text.includes(secret));
}

beforeAll(() => {
  const instance = express();
  instance.use(express.json());
  instance.use(cookieParser());
  instance.use('/api', requireAuth(), require('../server/router/biliup-accounts'));
  app = instance;
});

beforeEach(() => {
  jest.clearAllMocks();
  getSession.mockImplementation(async (token) => (token === VALID_TOKEN ? { username: 'admin', createdAt: 1 } : null));
  loadBiliupCookie.mockResolvedValue({
    cookies: { SESSDATA: SECRET_VALUES[0], bili_jct: SECRET_VALUES[1], DedeUserID: SECRET_VALUES[2] },
    csrf: SECRET_VALUES[1],
    uid: SECRET_VALUES[2],
  });
  checkLogin.mockResolvedValue({ isLogin: true, uid: '9527', nickname: '奔波儿灞' });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

describe('鉴权与登录态探测', () => {
  test('未登录 401 且不碰数据库', async () => {
    const response = await request(app).get('/api/biliup_accounts');

    expect(response.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('列表返回登记行，字段不含 cookie 内容', async () => {
    pool.query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] });
    const response = await authed('get', '/api/biliup_accounts');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.data).toHaveLength(1);
    expect(leakIn(response.body)).toEqual([]);
  });

  test('详情顺带刷新登录态并写回 uid/昵称', async () => {
    pool.query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] }).mockResolvedValueOnce({ rows: [] });
    const response = await authed('get', '/api/biliup_accounts/3');

    expect(response.status).toBe(200);
    expect(response.body.data.login_status).toBe('ok');
    expect(response.body.data.nickname).toBe('奔波儿灞');
    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toContain('login_status = $4');
    expect(params).toEqual([3, '9527', '奔波儿灞', 'ok']);
    expect(leakIn(response.body)).toEqual([]);
  });

  test('nav 失败降级 unknown 且不阻断详情，uid 回退 cookie 里的 DedeUserID', async () => {
    checkLogin.mockRejectedValueOnce(Object.assign(new Error('风控'), { code: 'RATE_LIMITED' }));
    pool.query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] }).mockResolvedValueOnce({ rows: [] });
    const response = await authed('get', '/api/biliup_accounts/3');

    expect(response.status).toBe(200);
    expect(response.body.data.login_status).toBe('unknown');
    expect(response.body.data.uid).toBe(SECRET_VALUES[2]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('RATE_LIMITED'));
    expect(leakIn(console.error.mock.calls)).toEqual([]);
    expect(leakIn(console.warn.mock.calls)).toEqual([]);
  });

  test('cookie 文件读不到时详情仍是 unknown，不回显原始异常', async () => {
    loadBiliupCookie.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'COOKIE_NOT_FOUND' }));
    pool.query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] }).mockResolvedValueOnce({ rows: [] });
    const response = await authed('get', '/api/biliup_accounts/3');

    expect(response.status).toBe(200);
    expect(response.body.data.login_status).toBe('unknown');
    expect(leakIn(response.body)).toEqual([]);
  });

  test.each([
    ['0', '账号 ID 非法'],
    ['abc', '账号 ID 非法'],
  ])('非法 ID %s 返回 400 且不查库', async (id, message) => {
    const response = await authed('get', `/api/biliup_accounts/${id}`);

    expect(response.status).toBe(400);
    expect(response.body.message).toBe(message);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('账号不存在返回 404', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const response = await authed('get', '/api/biliup_accounts/99');

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('账号不存在');
  });
});

describe('新增登记', () => {
  test('cookie 可读时入库并返回 201', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...ACCOUNT_ROW, login_status: 'ok' }] });
    const response = await authed('post', '/api/biliup_accounts').send({
      name: '奔波儿灞的小号',
      cookies_path: COOKIES_PATH,
    });

    expect(response.status).toBe(201);
    expect(loadBiliupCookie).toHaveBeenCalledWith(COOKIES_PATH);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO biliup_accounts');
    expect(params).toEqual(['奔波儿灞的小号', COOKIES_PATH, '9527', '奔波儿灞', 'ok']);
    expect(leakIn(response.body)).toEqual([]);
  });

  test.each([
    ['', '账号名称需为 1-64 个字符'],
    ['a'.repeat(65), '账号名称需为 1-64 个字符'],
  ])('名称 %s 非法返回 400', async (name, message) => {
    const response = await authed('post', '/api/biliup_accounts').send({ name, cookies_path: COOKIES_PATH });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe(message);
    expect(loadBiliupCookie).not.toHaveBeenCalled();
  });

  test.each(['../etc/cookies.json', 'cookies.json'])('非绝对路径 %s 返回 400', async (path) => {
    const response = await authed('post', '/api/biliup_accounts').send({ name: '测试', cookies_path: path });

    expect(response.status).toBe(400);
    expect(loadBiliupCookie).not.toHaveBeenCalled();
  });

  test('cookie 校验失败返回 400，只带错误类别', async () => {
    loadBiliupCookie.mockRejectedValueOnce(
      Object.assign(new Error('cookie 缺少 bili_jct，无法执行合集写操作'), { code: 'NO_CSRF' })
    );
    const response = await authed('post', '/api/biliup_accounts').send({
      name: '测试',
      cookies_path: COOKIES_PATH,
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('bili_jct');
    expect(leakIn(response.body)).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('NO_CSRF'));
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('唯一约束冲突返回 409', async () => {
    const conflict = Object.assign(new Error('duplicate key'), { code: '23505' });
    pool.query.mockRejectedValueOnce(conflict);
    const response = await authed('post', '/api/biliup_accounts').send({
      name: '奔波儿灞的小号',
      cookies_path: COOKIES_PATH,
    });

    expect(response.status).toBe(409);
    expect(response.body.message).toBe('账号名称或 cookie 路径已登记');
  });

  test('数据库其他异常上抛后统一 500，不回显异常文本', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection refused'));
    const response = await authed('post', '/api/biliup_accounts').send({ name: '测试', cookies_path: COOKIES_PATH });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ status: 'Error', message: '新增失败' });
    expect(leakIn(response.body)).toEqual([]);
  });
});

describe('删除登记', () => {
  test('未被模板引用时删除并保留 cookie 文件', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ cookies_path: COOKIES_PATH }] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: 3 }] });
    const response = await authed('delete', '/api/biliup_accounts/3');

    expect(response.status).toBe(200);
    expect(response.body.message).toBe('账号登记已删除，cookie 文件保留');
    expect(pool.query.mock.calls[2][0]).toContain('DELETE FROM biliup_accounts');
  });

  test('被投稿模板引用时 409 并回引用数', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ cookies_path: COOKIES_PATH }] })
      .mockResolvedValueOnce({ rows: [{ count: 2 }] });
    const response = await authed('delete', '/api/biliup_accounts/3');

    expect(response.status).toBe(409);
    expect(response.body.referenced_by).toBe(2);
    expect(response.body.message).toContain('2 个投稿模板');
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('DELETE'))).toBe(false);
  });

  test('账号不存在返回 404', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const response = await authed('delete', '/api/biliup_accounts/404');

    expect(response.status).toBe(404);
  });
});

describe('合集列表端点', () => {
  test('按账号 cookie 拉取合集，force=1 透传', async () => {
    SeasonService.listSeasonsByCookies.mockResolvedValueOnce({ seasons: [], cached: false, fetched_at: 1 });
    pool.query.mockResolvedValueOnce({ rows: [{ cookies_path: COOKIES_PATH }] });
    const response = await authed('get', '/api/biliup_accounts/3/seasons?force=1');

    expect(response.status).toBe(200);
    expect(SeasonService.listSeasonsByCookies).toHaveBeenCalledWith(COOKIES_PATH, { force: true });
    expect(response.body.data.cached).toBe(false);
  });

  test('默认不强制刷新缓存', async () => {
    SeasonService.listSeasonsByCookies.mockResolvedValueOnce({ seasons: [], cached: true, fetched_at: 1 });
    pool.query.mockResolvedValueOnce({ rows: [{ cookies_path: COOKIES_PATH }] });
    await authed('get', '/api/biliup_accounts/3/seasons');

    expect(SeasonService.listSeasonsByCookies).toHaveBeenCalledWith(COOKIES_PATH, { force: false });
  });

  test('cookie 失效时只回登录态提示，日志只记错误码', async () => {
    SeasonService.listSeasonsByCookies.mockRejectedValueOnce(
      Object.assign(new Error(`网关拒绝: ${SECRET_VALUES[0]}`), { code: 'AUTH_EXPIRED' })
    );
    pool.query.mockResolvedValueOnce({ rows: [{ cookies_path: COOKIES_PATH }] });
    const response = await authed('get', '/api/biliup_accounts/3/seasons');

    expect(response.status).toBe(500);
    expect(response.body.message).toBe('cookie 已失效，请重新登录该账号');
    expect(console.error).toHaveBeenCalledWith('[biliup_accounts] 合集列表获取失败: AUTH_EXPIRED');
    expect(leakIn(response.body)).toEqual([]);
    expect(leakIn(console.error.mock.calls)).toEqual([]);
  });

  test('账号不存在时不发合集请求', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const response = await authed('get', '/api/biliup_accounts/9/seasons');

    expect(response.status).toBe(404);
    expect(SeasonService.listSeasonsByCookies).not.toHaveBeenCalled();
  });
});
