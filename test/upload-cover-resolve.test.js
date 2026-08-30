const fs = require('fs');
const os = require('os');
const path = require('path');

// resolveUploadCover 是纯静态方法，重依赖 mock 掉即可安全 require UploadService
jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({ get: jest.fn(), set: jest.fn() }));
jest.mock('../server/lib/core/TranscodeQueue', () => ({ hasSessionPending: jest.fn() }));
jest.mock('../server/lib/core/notify', () => ({
  uploadStart: jest.fn(),
  uploadComplete: jest.fn(),
  uploadFailed: jest.fn(),
}));
jest.mock('../server/lib/core/biliup', () => ({ upload: jest.fn() }));
jest.mock('../server/lib/core/backup', () => ({ afterUpload: jest.fn() }));
jest.mock('../server/services/DataService', () => ({ getSetting: jest.fn() }));

const UploadService = require('../server/services/UploadService');
const biliup = require('../server/lib/core/biliup');
const pool = require('../server/db/index');

describe('UploadService.resolveUploadCover', () => {
  let tmpDir;
  let sourceCover;
  let templateCover;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-cover-resolve-'));
    sourceCover = path.join(tmpDir, 'cover.jpg');
    templateCover = path.join(tmpDir, 'template.jpg');
    fs.writeFileSync(sourceCover, 'room-cover');
    fs.writeFileSync(templateCover, 'template-cover');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should prefer room cover when use_room_cover is on and file exists', () => {
    const result = UploadService.resolveUploadCover({ use_room_cover: true, cover: templateCover }, sourceCover);

    expect(result).toEqual({ cover: sourceCover, source: 'room' });
  });

  test('should fall back to template cover when source cover file is missing', () => {
    const missingSource = path.join(tmpDir, 'missing.jpg');
    const result = UploadService.resolveUploadCover({ use_room_cover: true, cover: templateCover }, missingSource);

    expect(result).toEqual({ cover: templateCover, source: 'template' });
  });

  test('should use template cover when use_room_cover is off', () => {
    const result = UploadService.resolveUploadCover({ use_room_cover: false, cover: templateCover }, sourceCover);

    expect(result).toEqual({ cover: templateCover, source: 'template' });
  });

  test('should skip invalid template cover path and return none (D6 行为变化点)', () => {
    const invalidCover = path.join(tmpDir, 'missing.jpg');
    const result = UploadService.resolveUploadCover({ use_room_cover: true, cover: invalidCover }, null);

    expect(result).toEqual({ cover: null, source: 'none' });
  });

  test('should return none when neither source is available', () => {
    const result = UploadService.resolveUploadCover({ use_room_cover: false, cover: '' }, null);

    expect(result).toEqual({ cover: null, source: 'none' });
  });
});

// _runUpload 走 failed 分支断言命令记录（success 分支固定等 10s，没必要进测试）
describe('UploadService._runUpload cover wiring', () => {
  let tmpDir;
  let sourceCover;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-cover-wiring-'));
    sourceCover = path.join(tmpDir, 'cover.jpg');
    fs.writeFileSync(sourceCover, 'room-cover');
    pool.query.mockResolvedValue({});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should pass resolved session cover to biliup and record --cover in command', async () => {
    biliup.upload.mockResolvedValueOnce({ success: false, output: 'out', error: 'boom' });

    const session = { id: 1, room_url: 'https://live.example/1', room_name: 'R', cover_path: sourceCover };
    const tmpl = { use_room_cover: true, cookies_path: '/tmp/cookies.json', title_template: 't' };

    await UploadService._runUpload(99, session, tmpl, ['/tmp/a.mp4'], 'title', '', '', '');

    expect(biliup.upload).toHaveBeenCalledWith(expect.objectContaining({ cover: sourceCover }));
    const updateCall = pool.query.mock.calls.find((c) => c[0].includes("UPDATE upload_records SET status='failed'"));
    expect(updateCall[1][0]).toContain(`--cover ${sourceCover}`);
  });

  test('should not record --cover when use_room_cover is off and no template cover', async () => {
    biliup.upload.mockResolvedValueOnce({ success: false, output: 'out', error: 'boom' });

    const session = { id: 1, room_url: 'https://live.example/1', room_name: 'R', cover_path: sourceCover };
    const tmpl = { use_room_cover: false, cookies_path: '/tmp/cookies.json', title_template: 't' };

    await UploadService._runUpload(99, session, tmpl, ['/tmp/a.mp4'], 'title', '', '', '');

    expect(biliup.upload).toHaveBeenCalledWith(expect.objectContaining({ cover: null }));
    const updateCall = pool.query.mock.calls.find((c) => c[0].includes("UPDATE upload_records SET status='failed'"));
    expect(updateCall[1][0]).not.toContain('--cover');
  });
});
