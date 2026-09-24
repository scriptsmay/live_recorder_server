jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({
  get: jest.fn(),
  set: jest.fn(),
  setEx: jest.fn(),
  del: jest.fn(),
}));
jest.mock('../server/lib/core/auth-service', () => ({ getSession: jest.fn() }));
jest.mock('../server/lib/core/polling', () => ({ pollingManager: { reloadRoom: jest.fn() } }));
jest.mock('../server/services/RoomService', () => ({}));
jest.mock('../server/services/DataService', () => ({ getSessions: jest.fn() }));
jest.mock('../server/services/RecorderService', () => ({}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const pool = require('../server/db/index');
const { getSession } = require('../server/lib/core/auth-service');
const { requireAuth } = require('../server/middleware/require-auth');

const VALID_TOKEN = 'valid-session-token';
let tmpRoot;
let app;

function createApp(roomsRouter) {
  const instance = express();
  instance.use(express.json());
  instance.use(cookieParser());
  instance.use('/api', requireAuth(), roomsRouter);
  return instance;
}

function authed(url) {
  return request(app).get(url).set('Cookie', `auth_token=${VALID_TOKEN}`);
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cover-'));
  process.env.VIDEO_DOWNLOAD_DIR = tmpRoot;
  delete process.env.AUTH_ENABLED;
  delete process.env.AUTH_COOKIE_NAME;
});

beforeEach(() => {
  jest.clearAllMocks();
  getSession.mockImplementation(async (token) => (token === VALID_TOKEN ? { username: 'admin', createdAt: 1 } : null));
  const roomsRouter = require('../server/router/rooms');
  app = createApp(roomsRouter);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.VIDEO_DOWNLOAD_DIR;
});

test('无 Cookie 返回 401，数据库不访问', async () => {
  const response = await request(app).get('/api/sessions/61/cover');
  expect(response.status).toBe(401);
  expect(pool.query).not.toHaveBeenCalled();
});

test.each(['0', '-1', '1.5', 'abc'])('非法会话 ID %s 返回 400', async (id) => {
  const response = await authed(`/api/sessions/${id}/cover`);
  expect(response.status).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
});

test.each([
  [[], '会话不存在'],
  [[{ cover_path: null }], 'cover_path 为空'],
])('无封面记录返回 404', async (rows) => {
  pool.query.mockResolvedValueOnce({ rows });
  const response = await authed('/api/sessions/61/cover');
  expect(response.status).toBe(404);
  expect(response.body.message).toBe('封面不可用');
});

test('允许目录外的 cover_path 返回 404', async () => {
  pool.query.mockResolvedValueOnce({ rows: [{ cover_path: '/tmp/not-in-video-dir/cover.jpg' }] });
  const response = await authed('/api/sessions/61/cover');
  expect(response.status).toBe(404);
  expect(response.body.message).toBe('封面不可用');
  expect(JSON.stringify(response.body)).not.toContain('/tmp/not-in-video-dir');
});

test.each([
  ['cover.jpg', 'image/jpeg'],
  ['cover.png', 'image/png'],
  ['cover.webp', 'image/webp'],
  ['cover.gif', 'image/gif'],
])('%s 返回正确 MIME', async (filename, contentType) => {
  const coverPath = path.join(tmpRoot, filename);
  fs.writeFileSync(coverPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  pool.query.mockResolvedValueOnce({ rows: [{ cover_path: coverPath }] });

  const response = await authed('/api/sessions/61/cover');

  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toMatch(new RegExp(`^${contentType}`));
  expect(response.headers['cache-control']).toBe('private, max-age=3600');
  expect(Number(response.headers['content-length'])).toBe(fs.statSync(coverPath).size);
});

test('数据库异常返回 500 且不泄漏异常信息', async () => {
  pool.query.mockRejectedValueOnce(new Error('database connection failed'));

  const response = await authed('/api/sessions/61/cover');

  expect(response.status).toBe(500);
  expect(response.body).toEqual({ status: 'Error', message: '封面读取失败' });
  expect(JSON.stringify(response.body)).not.toContain('database connection failed');
});

test('允许目录内已删除的 cover_path 返回 404', async () => {
  const coverPath = path.join(tmpRoot, 'deleted-cover.jpg');
  pool.query.mockResolvedValueOnce({ rows: [{ cover_path: coverPath }] });

  const response = await authed('/api/sessions/61/cover');

  expect(response.status).toBe(404);
  expect(response.body.message).toBe('封面不可用');
});
