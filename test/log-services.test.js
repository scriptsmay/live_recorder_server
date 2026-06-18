const fs = require('fs');
const os = require('os');
const path = require('path');
const LogFileService = require('../server/services/LogFileService');
const LogCleanupService = require('../server/services/LogCleanupService');

describe('LogFileService', () => {
  let tmpDir;
  let service;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'log-service-'));
    service = new LogFileService(tmpDir);
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('lists only log files', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'access.log'), 'ok\n');
    await fs.promises.writeFile(path.join(tmpDir, 'notes.txt'), 'skip\n');

    await expect(service.listFiles()).resolves.toEqual(['access.log']);
  });

  it('rejects path traversal filenames', async () => {
    await expect(service.resolveLogPath('../access.log')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('returns tail lines and marks truncated content', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'access.log'), 'one\ntwo\nthree\n');

    await expect(service.tailLines('access.log', 2)).resolves.toMatchObject({
      file: 'access.log',
      lines: ['two', 'three'],
      truncated: true,
    });
  });
});

describe('LogCleanupService', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'log-cleanup-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeLog(name, content, mtime) {
    const filePath = path.join(tmpDir, name);
    await fs.promises.writeFile(filePath, content);
    await fs.promises.utimes(filePath, mtime, mtime);
  }

  it('keeps protected and recently active files while deleting expired logs', async () => {
    const now = Date.now();
    const oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000);
    const recentDate = new Date(now - 60 * 1000);
    const service = new LogCleanupService({
      logsDir: tmpDir,
      retentionDays: 30,
      maxTotalSize: 1024 * 1024,
      activeWindowMs: 5 * 60 * 1000,
    });

    await writeLog('access.log', 'protected', oldDate);
    await writeLog('ffmpeg_1.log', 'old', oldDate);
    await writeLog('ffmpeg_2.log', 'active', recentDate);

    const result = await service.cleanup(now);

    expect(result.deleted).toEqual([{ file: 'ffmpeg_1.log', size: 3 }]);
    await expect(fs.promises.access(path.join(tmpDir, 'access.log'))).resolves.toBeUndefined();
    await expect(fs.promises.access(path.join(tmpDir, 'ffmpeg_2.log'))).resolves.toBeUndefined();
    await expect(fs.promises.access(path.join(tmpDir, 'ffmpeg_1.log'))).rejects.toThrow();
  });
});
