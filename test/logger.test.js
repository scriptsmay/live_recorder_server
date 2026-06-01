const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRotatingStream } = require('../lib/core/logger');

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
