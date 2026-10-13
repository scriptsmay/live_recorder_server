jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({
  get: jest.fn(),
  set: jest.fn(),
  setEx: jest.fn(),
  del: jest.fn(),
}));
jest.mock('../server/lib/core/auth-service', () => ({ getSession: jest.fn() }));
jest.mock('../server/services/UploadService', () => ({}));
jest.mock('../server/services/DataService', () => ({
  getUploadRecords: jest.fn(),
  getTemplates: jest.fn(),
}));
jest.mock('../server/services/SeasonService', () => ({
  listSeasonsByCookies: jest.fn(),
  retryAdd: jest.fn(),
}));

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const pool = require('../server/db/index');
const { getSession } = require('../server/lib/core/auth-service');
const DataService = require('../server/services/DataService');
const SeasonService = require('../server/services/SeasonService');
const { requireAuth } = require('../server/middleware/require-auth');

const VALID_TOKEN = 'valid-session-token';
const COOKIES_PATH = '/data/biliup/cookies_bengtiezi.json';
const SECRETS = ['SESSDATA-SENTINEL-abcdef', 'BILI_JCT-SENTINEL-012345'];

let app;

function authed(method, url) {
  return request(app)[method](url).set('Cookie', `auth_token=${VALID_TOKEN}`);
}

function leakIn(payload) {
  const text = JSON.stringify(payload) + String(payload);
  return SECRETS.filter((secret) => text.includes(secret));
}

beforeAll(() => {
  const instance = express();
  instance.use(express.json());
  instance.use(cookieParser());
  instance.use('/api', requireAuth(), require('../server/router/upload'));
  app = instance;
});

beforeEach(() => {
  jest.clearAllMocks();
  getSession.mockImplementation(async (token) => (token === VALID_TOKEN ? { username: 'admin', createdAt: 1 } : null));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('模板维度合集列表', () => {
  test('模板存在时返回合集数据', async () => {
    SeasonService.listSeasonsByCookies.mockResolvedValueOnce({ seasons: [{ season_id: 1 }], cached: true });
    pool.query.mockResolvedValueOnce({ rows: [{ cookies_path: COOKIES_PATH }] });

    const response = await authed('get', '/api/upload_templates/7/seasons');

    expect(response.status).toBe(200);
    expect(response.body.data.cached).toBe(true);
    expect(SeasonService.listSeasonsByCookies).toHaveBeenCalledWith(COOKIES_PATH, { force: false });
  });

  test('force=1 跳过缓存', async () => {
    SeasonService.listSeasonsByCookies.mockResolvedValueOnce({ seasons: [], cached: false });
    pool.query.mockResolvedValueOnce({ rows: [{ cookies_path: COOKIES_PATH }] });

    await authed('get', '/api/upload_templates/7/seasons?force=1');

    expect(SeasonService.listSeasonsByCookies).toHaveBeenCalledWith(COOKIES_PATH, { force: true });
  });

  test('模板不存在返回 404 且不请求 B 站', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const response = await authed('get', '/api/upload_templates/999/seasons');

    expect(response.status).toBe(404);
    expect(SeasonService.listSeasonsByCookies).not.toHaveBeenCalled();
  });

  test.each(['COOKIE_NOT_FOUND', 'AUTH_EXPIRED', 'CREDENTIAL_INVALID'])(
    'cookie 类错误 %s 返回 400 且文案不含凭证',
    async (code) => {
      pool.query.mockResolvedValueOnce({ rows: [{ cookies_path: COOKIES_PATH }] });
      SeasonService.listSeasonsByCookies.mockRejectedValueOnce(
        Object.assign(new Error(`上游拒绝: ${SECRETS[0]}`), { code })
      );

      const response = await authed('get', '/api/upload_templates/7/seasons');

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('cookie 不可用，请检查模板的 cookie 配置与登录态');
      expect(leakIn(response.body)).toEqual([]);
      expect(console.error).toHaveBeenCalledWith(`[合集] 请求失败: ${code}`);
      expect(leakIn(console.error.mock.calls)).toEqual([]);
    }
  );

  test('网络类错误返回 500 通用文案', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ cookies_path: COOKIES_PATH }] });
    SeasonService.listSeasonsByCookies.mockRejectedValueOnce(
      Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'HTTP_TIMEOUT' })
    );

    const response = await authed('get', '/api/upload_templates/7/seasons');

    expect(response.status).toBe(500);
    expect(response.body.message).toBe('合集信息获取失败，请稍后重试');
  });
});

describe('手动重试加入合集', () => {
  test('触发成功返回 200', async () => {
    SeasonService.retryAdd.mockResolvedValueOnce({ ok: true, http: 200, message: '已触发加入合集，稍后刷新查看结果' });

    const response = await authed('post', '/api/upload_records/101/season/retry');

    expect(response.status).toBe(200);
    expect(SeasonService.retryAdd).toHaveBeenCalledWith('101');
    expect(response.body.status).toBe('ok');
  });

  test.each([
    ['记录不存在', { ok: false, http: 404, message: '投稿记录不存在' }],
    ['进行中', { ok: false, http: 409, message: '该记录正在加入中或已完成，无需重试' }],
    ['缺少 BV 号', { ok: false, http: 400, message: '投稿未成功或尚未取得 BV 号，无法加入合集' }],
  ])('%s 按服务层语义返回状态码', async (_label, result) => {
    SeasonService.retryAdd.mockResolvedValueOnce(result);

    const response = await authed('post', '/api/upload_records/101/season/retry');

    expect(response.status).toBe(result.http);
    expect(response.body).toEqual({ status: 'Error', message: result.message });
  });

  test('服务层抛异常时回 500，日志只记错误码', async () => {
    SeasonService.retryAdd.mockRejectedValueOnce(Object.assign(new Error('解析失败'), { code: 'SEASON_MALFORMED' }));

    const response = await authed('post', '/api/upload_records/101/season/retry');

    expect(response.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith('[合集] 请求失败: SEASON_MALFORMED');
  });
});

describe('模板合集字段落库', () => {
  test('创建模板时写入合集四列并归一类型', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 7 }] });

    const response = await authed('post', '/api/upload_templates').send({
      name: '日常投稿',
      cookies_path: COOKIES_PATH,
      season_id: '427651',
      season_title: '直播录像合集',
      section_id: '5857201',
      season_auto_add: true,
    });

    expect(response.status).toBe(200);
    const [, params] = pool.query.mock.calls[0];
    expect(params.slice(13)).toEqual([427651, '直播录像合集', 5857201, true]);
  });

  test('未选择小节时合集字段落 null/false', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 7 }] });

    await authed('post', '/api/upload_templates').send({ name: '日常投稿', cookies_path: COOKIES_PATH });

    const [, params] = pool.query.mock.calls[0];
    expect(params.slice(13)).toEqual([null, null, null, false]);
  });

  test('更新模板只接受白名单列并归一布尔', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 7 }] });

    await authed('put', '/api/upload_templates/7').send({
      season_id: '427651',
      section_id: '',
      season_auto_add: 'true',
      season_status: 'added',
    });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('season_id = $1');
    expect(sql).toContain('season_auto_add = $3');
    expect(sql).not.toContain('season_status');
    expect(params).toEqual([427651, null, false, '7']);
  });
});

describe('投稿记录合集状态筛选', () => {
  test('season_status 透传给查询服务', async () => {
    DataService.getUploadRecords.mockResolvedValueOnce([]);

    await authed('get', '/api/upload_records?season_status=failed');

    expect(DataService.getUploadRecords).toHaveBeenCalledWith(expect.objectContaining({ season_status: 'failed' }));
  });
});
