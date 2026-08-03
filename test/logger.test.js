const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRotatingStream, createModuleLogger } = require('../server/lib/core/logger');

describe('createRotatingStream', () => {
  let tmpDir;
  let fakeNow;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'logger-'));
    fakeNow = new Date('2026-01-15T10:00:00Z');
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  function createStream(options = {}) {
    return createRotatingStream('server', {
      logDir: tmpDir,
      maxFileSize: 10,
      maxBackupsPerDay: 2,
      retentionDays: 30,
      now: () => fakeNow,
      ...options,
    });
  }

  async function listLogs() {
    return (await fs.promises.readdir(tmpDir)).sort();
  }

  it('rotates the current log into date-indexed backups by size', async () => {
    const stream = createStream();

    stream.write('1234567890');
    stream.write('abcdefgh');
    stream.write('defghijk');

    await expect(listLogs()).resolves.toEqual(['server.2026-01-15.1.log', 'server.2026-01-15.2.log', 'server.log']);
    await expect(fs.promises.readFile(path.join(tmpDir, 'server.2026-01-15.1.log'), 'utf8')).resolves.toBe('abcdefgh');
    await expect(fs.promises.readFile(path.join(tmpDir, 'server.2026-01-15.2.log'), 'utf8')).resolves.toBe(
      '1234567890'
    );
    await expect(fs.promises.readFile(path.join(tmpDir, 'server.log'), 'utf8')).resolves.toBe('defghijk');
  });

  it('archives the current log with the previous date when the day changes', async () => {
    const stream = createStream();

    stream.write('before-midnight');
    fakeNow = new Date('2026-01-16T00:00:01Z');
    stream.write('after-midnight');

    await expect(listLogs()).resolves.toEqual(['server.2026-01-15.log', 'server.log']);
    await expect(fs.promises.readFile(path.join(tmpDir, 'server.2026-01-15.log'), 'utf8')).resolves.toBe(
      'before-midnight'
    );
    await expect(fs.promises.readFile(path.join(tmpDir, 'server.log'), 'utf8')).resolves.toBe('after-midnight');
  });

  it('deletes dated logs older than the retention window', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'server.2025-12-01.log'), 'old');
    await fs.promises.writeFile(path.join(tmpDir, 'server.2026-01-01.log'), 'keep');

    const stream = createStream();
    stream.write('today');

    await expect(listLogs()).resolves.toEqual(['server.2026-01-01.log', 'server.log']);
  });
});

describe('createModuleLogger', () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;
  const ORIGINAL_DEBUG = process.env.LOG_MODULE_DEBUG;
  let tmpDir;
  let spies = [];

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'modlog-'));
    // 抑制全局覆写对 server.log 的写入（避免污染项目日志），同时仍可断言镜像链路是否触发
    spies.push(jest.spyOn(console, 'error').mockImplementation(() => {}));
    spies.push(jest.spyOn(console, 'warn').mockImplementation(() => {}));
    spies.push(jest.spyOn(console, 'log').mockImplementation(() => {}));
  });

  afterEach(async () => {
    if (ORIGINAL_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_ENV;
    if (ORIGINAL_DEBUG === undefined) delete process.env.LOG_MODULE_DEBUG;
    else process.env.LOG_MODULE_DEBUG = ORIGINAL_DEBUG;
    spies.forEach((s) => s.mockRestore());
    spies = [];
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes info to the module file only and JSON-serializes objects', async () => {
    process.env.NODE_ENV = 'production';
    const log = createModuleLogger('polling', { logDir: tmpDir });
    log.info('hello', { a: 1 });

    const content = await fs.promises.readFile(path.join(tmpDir, 'polling.log'), 'utf8');
    expect(content).toContain('hello');
    expect(content).toContain('"a": 1');
    expect(content).toContain('[INFO]');
    // info 不应镜像到 server.log（不触发全局 console）
    expect(console.error).not.toHaveBeenCalledWith('hello');
    expect(console.log).not.toHaveBeenCalledWith('hello');
  });

  it('mirrors error/important to server.log via the global console link', async () => {
    process.env.NODE_ENV = 'production';
    const log = createModuleLogger('polling', { logDir: tmpDir });
    log.error('ERR-MIRROR');
    log.important('IMP-MIRROR');

    const content = await fs.promises.readFile(path.join(tmpDir, 'polling.log'), 'utf8');
    expect(content).toContain('ERR-MIRROR');
    expect(content).toContain('IMP-MIRROR');
    // 经全局覆写链路（production 下写入 server.log）
    expect(console.error).toHaveBeenCalledWith('ERR-MIRROR');
    expect(console.log).toHaveBeenCalledWith('IMP-MIRROR');
  });

  it('does not output debug by default', async () => {
    process.env.NODE_ENV = 'production';
    const log = createModuleLogger('polling', { logDir: tmpDir });
    log.info('INFO-SHOW');
    log.debug('DBG-HIDE');

    const content = await fs.promises.readFile(path.join(tmpDir, 'polling.log'), 'utf8');
    expect(content).toContain('INFO-SHOW');
    expect(content).not.toContain('DBG-HIDE');
  });

  it('outputs debug when options.debug is true (module file only)', async () => {
    process.env.NODE_ENV = 'production';
    const log = createModuleLogger('polling', { logDir: tmpDir, debug: true });
    log.debug('DBG-ON');

    const content = await fs.promises.readFile(path.join(tmpDir, 'polling.log'), 'utf8');
    expect(content).toContain('DBG-ON');
    expect(content).toContain('[DEBUG]');
  });

  it('enables debug via LOG_MODULE_DEBUG comma list', async () => {
    process.env.NODE_ENV = 'production';
    process.env.LOG_MODULE_DEBUG = 'polling,watchdog';
    const log = createModuleLogger('polling', { logDir: tmpDir });
    log.debug('DBG-ENV');

    const content = await fs.promises.readFile(path.join(tmpDir, 'polling.log'), 'utf8');
    expect(content).toContain('DBG-ENV');
  });

  it('enables debug via LOG_MODULE_DEBUG wildcard', async () => {
    process.env.NODE_ENV = 'production';
    process.env.LOG_MODULE_DEBUG = '*';
    const log = createModuleLogger('polling', { logDir: tmpDir });
    log.debug('DBG-STAR');

    const content = await fs.promises.readFile(path.join(tmpDir, 'polling.log'), 'utf8');
    expect(content).toContain('DBG-STAR');
  });

  it('does not enable debug for non-listed modules', async () => {
    process.env.NODE_ENV = 'production';
    process.env.LOG_MODULE_DEBUG = 'watchdog';
    const log = createModuleLogger('polling', { logDir: tmpDir });
    log.info('INFO2');
    log.debug('DBG-HIDE2');

    const content = await fs.promises.readFile(path.join(tmpDir, 'polling.log'), 'utf8');
    expect(content).toContain('INFO2');
    expect(content).not.toContain('DBG-HIDE2');
  });

  it('falls back to terminal-only logger when stream creation fails', async () => {
    process.env.NODE_ENV = 'production';
    const log = createModuleLogger('polling', {
      logDir: tmpDir,
      now: () => {
        throw new Error('boom');
      },
    });
    expect(() => {
      log.info('FB-INFO');
      log.important('FB-IMPORTANT');
      log.warn('FB-WARN');
      log.error('FB-ERROR');
      log.debug('FB-DEBUG');
    }).not.toThrow();
    expect(fs.existsSync(path.join(tmpDir, 'polling.log'))).toBe(false);
  });

  it('does not mirror to server.log when mirrorToServer is false, but still prints terminal', async () => {
    process.env.NODE_ENV = 'production';
    const appendSpy = jest.spyOn(fs, 'appendFileSync'); // 保留真实写入，仅记录调用
    const log = createModuleLogger('polling', { logDir: tmpDir, mirrorToServer: false });
    log.important('NO-MIRROR-IMP');
    log.warn('NO-MIRROR-WARN');
    log.error('NO-MIRROR-ERR');

    const content = await fs.promises.readFile(path.join(tmpDir, 'polling.log'), 'utf8');
    expect(content).toContain('NO-MIRROR-IMP');
    expect(content).toContain('NO-MIRROR-WARN');
    expect(content).toContain('NO-MIRROR-ERR');
    // 终端始终打印（important→console.log，warn/error→console.warn/error）
    expect(console.log).toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
    // 但不镜像 server.log：所有 server.log 的 append 都不含这些消息
    const serverLogWrites = appendSpy.mock.calls.filter((c) => String(c[0]).endsWith('server.log'));
    expect(serverLogWrites.some((c) => String(c[1]).includes('NO-MIRROR-IMP'))).toBe(false);
    expect(serverLogWrites.some((c) => String(c[1]).includes('NO-MIRROR-WARN'))).toBe(false);
    expect(serverLogWrites.some((c) => String(c[1]).includes('NO-MIRROR-ERR'))).toBe(false);
    appendSpy.mockRestore();
  });

  it('reuses a single rotating stream for the same fileName (P1-2)', () => {
    const cache = require('../server/lib/core/logger').__moduleStreamCache;
    cache.clear();
    const a = createModuleLogger('sharedmod', { logDir: tmpDir });
    const b = createModuleLogger('sharedmod', { logDir: tmpDir });
    // 同一 fileName + logDir 应复用同一轮转流（缓存命中），而非各自创建独立流
    expect(cache.size).toBe(1);
    expect(typeof a.info).toBe('function');
    expect(typeof b.info).toBe('function');
  });

  it('archives previous content across a day boundary', async () => {
    process.env.NODE_ENV = 'production';
    const fakeNow = new Date('2026-03-01T10:00:00Z');
    const log = createModuleLogger('polling', { logDir: tmpDir, now: () => fakeNow });
    log.info('BEFORE-MIDNIGHT');
    fakeNow.setDate(fakeNow.getDate() + 1);
    log.info('AFTER-MIDNIGHT');

    const files = (await fs.promises.readdir(tmpDir)).sort();
    expect(files).toContain('polling.2026-03-01.log');
    expect(files).toContain('polling.log');
    const archived = await fs.promises.readFile(path.join(tmpDir, 'polling.2026-03-01.log'), 'utf8');
    expect(archived).toContain('BEFORE-MIDNIGHT');
    const current = await fs.promises.readFile(path.join(tmpDir, 'polling.log'), 'utf8');
    expect(current).toContain('AFTER-MIDNIGHT');
  });

  it('does not write the module file when not in production', () => {
    delete process.env.NODE_ENV;
    const log = createModuleLogger('polling', { logDir: tmpDir });
    log.info('DEV-INFO');
    log.important('DEV-IMPORTANT');
    log.warn('DEV-WARN');
    log.error('DEV-ERROR');
    expect(fs.existsSync(path.join(tmpDir, 'polling.log'))).toBe(false);
  });

  it('rejects reserved file names (server/access) without throwing', () => {
    expect(() => createModuleLogger('server')).not.toThrow();
    expect(() => createModuleLogger('access')).not.toThrow();
  });
});
