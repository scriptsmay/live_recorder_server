jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({ keys: jest.fn(), get: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const pool = require('../server/db/index');
const redis = require('../server/db/redis');
const { EmptyDirectoryCleanupService } = require('../server/services/EmptyDirectoryCleanupService');

let tempRoot;
let recordingRoot;
let replayRoot;
let originalVideoDir;
let originalReplayDir;

function mockProtectionQueries({ recordings = [], hls = [], replays = [] } = {}) {
  pool.query.mockImplementation(async (sql) => {
    if (sql.includes('FROM recording_sessions')) return { rows: recordings };
    if (sql.includes('FROM recording_files')) return { rows: hls };
    if (sql.includes('FROM replay_records')) return { rows: replays };
    return { rows: [] };
  });
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-directory-cleanup-'));
  recordingRoot = path.join(tempRoot, 'recording');
  replayRoot = path.join(tempRoot, 'replay');
  fs.mkdirSync(recordingRoot);
  fs.mkdirSync(replayRoot);
  originalVideoDir = process.env.VIDEO_DOWNLOAD_DIR;
  originalReplayDir = process.env.REPLAY_WORK_DIR;
  process.env.VIDEO_DOWNLOAD_DIR = recordingRoot;
  process.env.REPLAY_WORK_DIR = replayRoot;
  pool.query.mockReset();
  redis.keys.mockReset();
  redis.keys.mockResolvedValue([]);
  redis.get.mockReset();
  redis.get.mockResolvedValue(null);
  mockProtectionQueries();
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  if (originalVideoDir === undefined) delete process.env.VIDEO_DOWNLOAD_DIR;
  else process.env.VIDEO_DOWNLOAD_DIR = originalVideoDir;
  if (originalReplayDir === undefined) delete process.env.REPLAY_WORK_DIR;
  else process.env.REPLAY_WORK_DIR = originalReplayDir;
  jest.restoreAllMocks();
});

test('自底向上删除空目录并保留根目录和非空目录', async () => {
  const nestedEmpty = path.join(replayRoot, 'principal', 'record', 'output');
  const nonEmpty = path.join(recordingRoot, 'session');
  fs.mkdirSync(nestedEmpty, { recursive: true });
  fs.mkdirSync(nonEmpty, { recursive: true });
  fs.writeFileSync(path.join(nonEmpty, 'video.mp4'), 'video');

  const result = await new EmptyDirectoryCleanupService().cleanup();

  expect(result.deleted).toBe(3);
  expect(fs.existsSync(path.join(replayRoot, 'principal'))).toBe(false);
  expect(fs.existsSync(replayRoot)).toBe(true);
  expect(fs.existsSync(nonEmpty)).toBe(true);
});

test('dry-run 计算级联候选但不删除目录', async () => {
  const nestedEmpty = path.join(replayRoot, 'principal', 'record', 'output');
  fs.mkdirSync(nestedEmpty, { recursive: true });

  const result = await new EmptyDirectoryCleanupService().cleanup({ dryRun: true });

  expect(result.candidates).toBe(3);
  expect(result.deleted).toBe(0);
  expect(result.candidate_paths).toHaveLength(3);
  expect(fs.existsSync(nestedEmpty)).toBe(true);
});

test('保护活跃目录及其子目录', async () => {
  const activeSession = path.join(recordingRoot, 'active-session');
  const emptyChild = path.join(activeSession, 'segments');
  fs.mkdirSync(emptyChild, { recursive: true });
  mockProtectionQueries({ recordings: [{ output_dir: activeSession }] });

  const result = await new EmptyDirectoryCleanupService().cleanup();

  expect(result.deleted).toBe(0);
  expect(result.skipped).toBe(1);
  expect(fs.existsSync(emptyChild)).toBe(true);
});

test('符号链接不遍历且阻止父目录被删除', async () => {
  const outside = path.join(tempRoot, 'outside');
  const parent = path.join(replayRoot, 'principal');
  fs.mkdirSync(outside);
  fs.mkdirSync(parent);
  fs.symlinkSync(outside, path.join(parent, 'link'));

  const result = await new EmptyDirectoryCleanupService().cleanup();

  expect(result.deleted).toBe(0);
  expect(fs.existsSync(parent)).toBe(true);
  expect(fs.existsSync(outside)).toBe(true);
});

test('目录出现竞争写入时 ENOTEMPTY 降级为跳过', async () => {
  const parent = path.join(replayRoot, 'principal');
  fs.mkdirSync(parent);
  jest.spyOn(fs.promises, 'rmdir').mockRejectedValueOnce(Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' }));

  const result = await new EmptyDirectoryCleanupService().pruneParents(path.join(parent, 'video.mp4'), {
    category: 'replay',
  });

  expect(result).toMatchObject({ deleted: 0, skipped: 1, failed: 0 });
  expect(fs.existsSync(parent)).toBe(true);
});

test('目录已不存在时按幂等成功处理', async () => {
  const missingParent = path.join(replayRoot, 'principal');
  jest.spyOn(fs.promises, 'rmdir').mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));

  const result = await new EmptyDirectoryCleanupService().pruneParents(path.join(missingParent, 'video.mp4'), {
    category: 'replay',
  });

  expect(result.deleted).toBe(1);
});

test('拒绝根目录之外的候选路径', async () => {
  const service = new EmptyDirectoryCleanupService();
  const result = await service._removeCandidate(
    path.join(tempRoot, 'outside'),
    replayRoot,
    'replay',
    [],
    { operator: 'test', dryRun: false }
  );

  expect(result).toEqual({ result: 'skipped', error: 'outside_allowlist' });
});
