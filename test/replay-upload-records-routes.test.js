/**
 * v1.11.2 投稿记录按路径分表：回放投稿单表端点。
 *
 * 覆盖 `GET /api/replay_upload_records`、`DELETE /api/replay_upload_records/:id`、
 * `POST /api/replay_upload_records/:id/season/retry`，并断言这些端点不会误触常规投稿表。
 */
jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({
  get: jest.fn(),
  set: jest.fn(),
  setEx: jest.fn(),
  del: jest.fn(),
  lPush: jest.fn(),
  rPop: jest.fn(),
  lLen: jest.fn(),
  incr: jest.fn(),
  decr: jest.fn(),
}));
jest.mock('../server/lib/core/auth-service', () => ({ getSession: jest.fn() }));
jest.mock('../server/services/UploadService', () => ({}));
jest.mock('../server/services/ReplayService', () => ({
  listAllUploads: jest.fn(),
  getPrincipals: jest.fn(),
  listRecords: jest.fn(),
  listUploads: jest.fn(),
  getSettings: jest.fn(),
  updateSettings: jest.fn(),
}));
jest.mock('../server/services/SeasonService', () => ({
  retryAdd: jest.fn(),
  listSeasonsByCookies: jest.fn(),
  validateSelection: jest.fn(),
}));
jest.mock('../server/lib/core/replay/ReplayUploadService', () => ({ getUploadPreview: jest.fn() }));
jest.mock('../server/lib/core/ReplayProcessQueue', () => ({
  getStatus: jest.fn(),
  enqueuePrincipal: jest.fn(),
  cancel: jest.fn(),
}));

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const pool = require('../server/db/index');
const { getSession } = require('../server/lib/core/auth-service');
const ReplayService = require('../server/services/ReplayService');
const SeasonService = require('../server/services/SeasonService');
const { requireAuth } = require('../server/middleware/require-auth');

const VALID_TOKEN = 'valid-session-token';

let app;

function authed(method, url) {
  return request(app)[method](url).set('Cookie', `auth_token=${VALID_TOKEN}`);
}

beforeAll(() => {
  const instance = express();
  instance.use(express.json());
  instance.use(cookieParser());
  instance.use('/api', requireAuth(), require('../server/router/replay'));
  app = instance;
});

beforeEach(() => {
  jest.clearAllMocks();
  getSession.mockImplementation(async (token) => (token === VALID_TOKEN ? { username: 'admin', createdAt: 1 } : null));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('回放投稿记录列表', () => {
  test('筛选参数透传到服务层并返回分页字段', async () => {
    ReplayService.listAllUploads.mockResolvedValueOnce({
      rows: [{ id: 12 }],
      total: 4,
      page: 2,
      page_size: 10,
    });

    const response = await authed(
      'get',
      '/api/replay_upload_records?status=success&season_status=failed&title=%E5%9B%9E%E6%94%BE&page=2&limit=10'
    );

    expect(response.status).toBe(200);
    expect(ReplayService.listAllUploads).toHaveBeenCalledWith({
      status: 'success',
      season_status: 'failed',
      title: '回放',
      page: '2',
      limit: '10',
      page_size: undefined,
    });
    expect(response.body).toEqual({ status: 'ok', data: [{ id: 12 }], total: 4, page: 2, page_size: 10 });
  });

  test('无筛选条件时也能查询', async () => {
    ReplayService.listAllUploads.mockResolvedValueOnce({ rows: [], total: 0, page: 1, page_size: 20 });

    const response = await authed('get', '/api/replay_upload_records');

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(0);
  });

  test('服务层异常时返回 500', async () => {
    ReplayService.listAllUploads.mockRejectedValueOnce(new Error('boom'));

    const response = await authed('get', '/api/replay_upload_records');

    expect(response.status).toBe(500);
    expect(response.body.message).toBe('查询回放投稿记录失败');
  });
});

describe('删除回放投稿记录', () => {
  function deletedTable() {
    const [sql] = pool.query.mock.calls[0];
    return sql.match(/DELETE FROM (\w+)/)[1];
  }

  test('只删 replay_upload_records，不碰同号的常规投稿', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 12 }] });

    const response = await authed('delete', '/api/replay_upload_records/12');

    expect(response.status).toBe(200);
    expect(deletedTable()).toBe('replay_upload_records');
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM replay_upload_records'), ['12']);
    expect(response.body.data).toEqual({ id: 12 });
  });

  test('目标表无此行时返回 404', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const response = await authed('delete', '/api/replay_upload_records/999');

    expect(response.status).toBe(404);
    expect(deletedTable()).toBe('replay_upload_records');
  });
});

describe('回放投稿手动重试加入合集', () => {
  test('固定以 replay 来源调用服务层', async () => {
    SeasonService.retryAdd.mockResolvedValueOnce({ ok: true, http: 200, message: '已触发加入合集，稍后刷新查看结果' });

    const response = await authed('post', '/api/replay_upload_records/12/season/retry');

    expect(response.status).toBe(200);
    expect(SeasonService.retryAdd).toHaveBeenCalledWith('12', 'replay');
    expect(response.body.status).toBe('ok');
  });

  test.each([
    ['记录不存在', { ok: false, http: 404, message: '投稿记录不存在' }],
    ['进行中', { ok: false, http: 409, message: '该记录正在加入中或已完成，无需重试' }],
  ])('%s 按服务层语义返回状态码', async (_label, result) => {
    SeasonService.retryAdd.mockResolvedValueOnce(result);

    const response = await authed('post', '/api/replay_upload_records/12/season/retry');

    expect(response.status).toBe(result.http);
    expect(response.body).toEqual({ status: 'Error', message: result.message });
  });

  test('服务层抛异常时回 500，日志只记错误码', async () => {
    SeasonService.retryAdd.mockRejectedValueOnce(Object.assign(new Error('解析失败'), { code: 'SEASON_MALFORMED' }));

    const response = await authed('post', '/api/replay_upload_records/12/season/retry');

    expect(response.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith('[合集] 请求失败: SEASON_MALFORMED');
  });
});
