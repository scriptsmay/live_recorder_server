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
const { execFileSync } = require('child_process');
const { Readable } = require('stream');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const pool = require('../server/db/index');
const { getSession } = require('../server/lib/core/auth-service');
const { requireAuth } = require('../server/middleware/require-auth');

const VALID_TOKEN = 'valid-session-token';
const ENV_KEYS = ['VIDEO_DOWNLOAD_DIR', 'AUTH_ENABLED', 'AUTH_COOKIE_NAME'];
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const emulateLinuxFdResolution = process.platform !== 'linux';
const mkfifoPath = ['/usr/bin/mkfifo', '/bin/mkfifo'].find((candidate) => fs.existsSync(candidate));
let mockedOpenedFileTarget;
let originalEnv;
let tmpRoot;
let outsideRoot;
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

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function setTestPlatform(platform) {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
}

function setMockedOpenedFileTarget(target) {
  mockedOpenedFileTarget = fs.realpathSync(target);
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function waitWithTimeout(promise, timeoutMs = 500) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('test operation timed out')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

beforeAll(() => {
  originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  if (emulateLinuxFdResolution) {
    setTestPlatform('linux');
  }
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cover-'));
  outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cover-outside-'));
  process.env.VIDEO_DOWNLOAD_DIR = tmpRoot;
  delete process.env.AUTH_ENABLED;
  delete process.env.AUTH_COOKIE_NAME;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedOpenedFileTarget = null;
  const realReadlink = fs.promises.readlink.bind(fs.promises);
  jest.spyOn(fs.promises, 'readlink').mockImplementation(async (linkPath) => {
    if (emulateLinuxFdResolution && linkPath.startsWith('/proc/self/fd/')) {
      if (!mockedOpenedFileTarget) {
        throw Object.assign(new Error('mocked fd target missing'), { code: 'ENOENT' });
      }
      return mockedOpenedFileTarget;
    }
    return realReadlink(linkPath);
  });
  getSession.mockImplementation(async (token) => (token === VALID_TOKEN ? { username: 'admin', createdAt: 1 } : null));
  const roomsRouter = require('../server/router/rooms');
  app = createApp(roomsRouter);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    restoreEnv(key, originalEnv[key]);
  }
  Object.defineProperty(process, 'platform', originalPlatform);
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

test('父目录符号链接指向 VIDEO_DOWNLOAD_DIR 外时返回 404', async () => {
  const outsideCover = path.join(outsideRoot, 'outside.jpg');
  const linkedParent = path.join(tmpRoot, 'linked-parent');
  const coverPath = path.join(linkedParent, 'cover.jpg');
  fs.writeFileSync(outsideCover, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.symlinkSync(outsideRoot, linkedParent, 'dir');
  pool.query.mockResolvedValueOnce({ rows: [{ cover_path: coverPath }] });

  const response = await authed('/api/sessions/61/cover');

  expect(response.status).toBe(404);
  expect(response.body.message).toBe('封面不可用');
  expect(JSON.stringify(response.body)).not.toContain(outsideRoot);
});

const platformSymlinkTest = process.platform === 'win32' ? test.skip : test;

platformSymlinkTest('校验后实际 open 前父目录替换为根外 symlink 时安全失败', async () => {
  const linkedParent = path.join(tmpRoot, 'race-parent');
  const parkedParent = path.join(tmpRoot, 'race-parent-original');
  const coverPath = path.join(linkedParent, 'cover.jpg');
  const outsideCover = path.join(outsideRoot, 'parent-race-outside.jpg');
  fs.mkdirSync(linkedParent);
  fs.writeFileSync(coverPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.writeFileSync(outsideCover, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  setMockedOpenedFileTarget(outsideCover);
  pool.query.mockResolvedValueOnce({ rows: [{ cover_path: coverPath }] });
  const realOpen = fs.promises.open.bind(fs.promises);
  let replaced = false;
  jest.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    if (!replaced) {
      fs.renameSync(linkedParent, parkedParent);
      fs.symlinkSync(outsideRoot, linkedParent, 'dir');
      replaced = true;
    }
    return realOpen(outsideCover, args[1]);
  });

  try {
    const response = await authed('/api/sessions/61/cover');

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('封面不可用');
    expect(JSON.stringify(response.body)).not.toContain(outsideRoot);
  } finally {
    if (fs.lstatSync(linkedParent).isSymbolicLink()) {
      fs.unlinkSync(linkedParent);
    }
    if (fs.existsSync(parkedParent)) {
      fs.renameSync(parkedParent, linkedParent);
    }
  }
});

platformSymlinkTest('最终路径是符号链接时返回 404', async () => {
  const outsideCover = path.join(outsideRoot, 'outside.jpg');
  const coverPath = path.join(tmpRoot, 'final-link.jpg');
  fs.writeFileSync(outsideCover, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.symlinkSync(outsideCover, coverPath);
  pool.query.mockResolvedValueOnce({ rows: [{ cover_path: coverPath }] });

  const response = await authed('/api/sessions/61/cover');

  expect(response.status).toBe(404);
  expect(response.body.message).toBe('封面不可用');
});

test.each([
  ['cover.jpg', 'image/jpeg'],
  ['cover.jpeg', 'image/jpeg'],
  ['cover.png', 'image/png'],
  ['cover.webp', 'image/webp'],
  ['cover.gif', 'image/gif'],
])('%s 返回正确 MIME', async (filename, contentType) => {
  const coverPath = path.join(tmpRoot, filename);
  fs.writeFileSync(coverPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  setMockedOpenedFileTarget(coverPath);
  pool.query.mockResolvedValueOnce({ rows: [{ cover_path: coverPath }] });

  const response = await authed('/api/sessions/61/cover');

  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toMatch(new RegExp(`^${contentType}`));
  expect(response.headers['cache-control']).toBe('private, max-age=3600');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(Number(response.headers['content-length'])).toBe(fs.statSync(coverPath).size);
});

test.each(['cover.txt', 'cover.svg'])('%s 返回 404', async (filename) => {
  const coverPath = path.join(tmpRoot, filename);
  fs.writeFileSync(coverPath, '<svg></svg>');
  pool.query.mockResolvedValueOnce({ rows: [{ cover_path: coverPath }] });

  const response = await authed('/api/sessions/61/cover');

  expect(response.status).toBe(404);
  expect(response.body.message).toBe('封面不可用');
});

test('cover_path 指向目录时返回 404', async () => {
  const coverPath = path.join(tmpRoot, 'directory-cover.jpg');
  fs.mkdirSync(coverPath);
  pool.query.mockResolvedValueOnce({ rows: [{ cover_path: coverPath }] });

  const response = await authed('/api/sessions/61/cover');

  expect(response.status).toBe(404);
  expect(response.body.message).toBe('封面不可用');
});

platformSymlinkTest('路径校验后打开前替换为符号链接时安全失败', async () => {
  const coverPath = path.join(tmpRoot, 'race-cover.jpg');
  const outsideCover = path.join(outsideRoot, 'race-outside.jpg');
  fs.writeFileSync(coverPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.writeFileSync(outsideCover, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  setMockedOpenedFileTarget(outsideCover);
  pool.query.mockResolvedValueOnce({ rows: [{ cover_path: coverPath }] });
  const realOpen = fs.promises.open.bind(fs.promises);
  jest.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
    fs.unlinkSync(coverPath);
    fs.symlinkSync(outsideCover, coverPath);
    return realOpen(...args);
  });

  try {
    const response = await authed('/api/sessions/61/cover');

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('封面不可用');
    expect(JSON.stringify(response.body)).not.toContain(outsideRoot);
  } finally {
    if (fs.lstatSync(coverPath).isSymbolicLink()) {
      fs.unlinkSync(coverPath);
    }
  }
});

test.each([
  ['read failed', new Error('read failed'), true],
  ['file disappeared', Object.assign(new Error('file disappeared'), { code: 'ENOENT' }), false],
])('响应头发送后的流错误 %s 终止连接', async (message, streamError, shouldLog) => {
  const coverPath = path.join(tmpRoot, `stream-error-${message.replace(/\s+/g, '-')}.jpg`);
  fs.writeFileSync(coverPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  setMockedOpenedFileTarget(coverPath);
  pool.query.mockResolvedValueOnce({ rows: [{ cover_path: coverPath }] });
  const realOpen = fs.promises.open.bind(fs.promises);
  jest.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
    const fileHandle = await realOpen(...args);
    fileHandle.createReadStream = () => {
      let pushed = false;
      return new Readable({
        read() {
          if (pushed) return;
          pushed = true;
          this.push(Buffer.from([0xff]));
          setImmediate(() => this.destroy(streamError));
        },
        destroy(error, callback) {
          fileHandle.close().then(
            () => callback(error),
            () => callback(error)
          );
        },
      });
    };
    return fileHandle;
  });

  await expect(authed('/api/sessions/61/cover')).rejects.toThrow();

  if (shouldLog) {
    expect(console.error).toHaveBeenCalledWith('[sessions] 读取封面失败:', message);
  } else {
    expect(console.error).not.toHaveBeenCalled();
  }
});

test('校验和打开期间客户端提前断开时关闭 handle 且不创建流', async () => {
  const coverPath = path.join(tmpRoot, 'client-abort.jpg');
  fs.writeFileSync(coverPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  setMockedOpenedFileTarget(coverPath);
  pool.query.mockResolvedValueOnce({ rows: [{ cover_path: coverPath }] });
  const openEntered = createDeferred();
  const releaseOpen = createDeferred();
  const handleClosed = createDeferred();
  const realOpen = fs.promises.open.bind(fs.promises);
  let closeCalls = 0;
  let streamCreated = false;
  jest.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
    openEntered.resolve();
    await releaseOpen.promise;
    const fileHandle = await realOpen(...args);
    const realClose = fileHandle.close.bind(fileHandle);
    fileHandle.close = jest.fn(async () => {
      closeCalls += 1;
      try {
        await realClose();
      } finally {
        handleClosed.resolve();
      }
    });
    fileHandle.createReadStream = jest.fn(() => {
      streamCreated = true;
      return new Readable({
        read() {},
        destroy(error, callback) {
          fileHandle.close().then(
            () => callback(error),
            () => callback(error)
          );
        },
      });
    });
    return fileHandle;
  });
  const unhandledErrors = [];
  const onUnhandledRejection = (reason) => unhandledErrors.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);
  const pendingRequest = authed('/api/sessions/61/cover');
  const requestOutcome = pendingRequest.then(
    (response) => ({ response }),
    (error) => ({ error })
  );

  try {
    await waitWithTimeout(openEntered.promise);
    pendingRequest.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseOpen.resolve();

    const requestResult = await waitWithTimeout(requestOutcome);
    await waitWithTimeout(handleClosed.promise);
    await new Promise((resolve) => setImmediate(resolve));

    expect(requestResult.error).toBeDefined();
    expect(closeCalls).toBe(1);
    expect(streamCreated).toBe(false);
    expect(unhandledErrors).toEqual([]);
  } finally {
    releaseOpen.resolve();
    try {
      pendingRequest.abort();
    } catch (_) {}
    if (pendingRequest._server?.listening) {
      await new Promise((resolve, reject) => {
        pendingRequest._server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
});

const posixFifoTest = process.platform !== 'win32' && mkfifoPath ? test : test.skip;

posixFifoTest('POSIX FIFO 使用 O_NONBLOCK 快速返回 404', async () => {
  const fifoPath = path.join(tmpRoot, 'cover-fifo.jpg');
  execFileSync(mkfifoPath, [fifoPath]);
  pool.query.mockResolvedValueOnce({ rows: [{ cover_path: fifoPath }] });
  const realOpen = fs.promises.open.bind(fs.promises);
  const openSpy = jest.spyOn(fs.promises, 'open').mockImplementationOnce((...args) => {
    if ((args[1] & fs.constants.O_NONBLOCK) === 0) {
      return Promise.reject(Object.assign(new Error('O_NONBLOCK required'), { code: 'EAGAIN' }));
    }
    return realOpen(...args);
  });

  const response = await waitWithTimeout(authed('/api/sessions/61/cover'));

  expect(response.status).toBe(404);
  expect(response.body.message).toBe('封面不可用');
  expect(openSpy.mock.calls[0][1] & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
});

test('平台无法安全解析已打开 fd 的实际目标时 fail closed 返回 404', async () => {
  const coverPath = path.join(tmpRoot, 'unsupported-fd-platform.jpg');
  fs.writeFileSync(coverPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  pool.query.mockResolvedValueOnce({ rows: [{ cover_path: coverPath }] });
  setTestPlatform('darwin');

  try {
    const response = await authed('/api/sessions/61/cover');

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('封面不可用');
  } finally {
    setTestPlatform('linux');
  }
});

test('canonicalize 的非 ENOENT I/O 异常返回 500 并记录服务端日志', async () => {
  const coverPath = path.join(tmpRoot, 'io-error.jpg');
  fs.writeFileSync(coverPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  pool.query.mockResolvedValueOnce({ rows: [{ cover_path: coverPath }] });
  const ioError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  jest.spyOn(fs.promises, 'realpath').mockRejectedValueOnce(ioError);

  const response = await authed('/api/sessions/61/cover');

  expect(response.status).toBe(500);
  expect(response.body).toEqual({ status: 'Error', message: '封面读取失败' });
  expect(JSON.stringify(response.body)).not.toContain('permission denied');
  expect(console.error).toHaveBeenCalledWith('[sessions] 读取封面失败:', 'permission denied');
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
