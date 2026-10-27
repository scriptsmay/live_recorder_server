// v1.13.4：自动投稿资格校验与冷静期
// 覆盖：effectiveGraceSeconds 计算、扫描资格 SQL/过滤、executeUpload({ auto: true }) 防竞态二次确认。
jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({
  incr: jest.fn(),
  expire: jest.fn(),
  set: jest.fn(),
  get: jest.fn(),
}));
jest.mock('../server/lib/core/TranscodeQueue', () => ({
  hasSessionPending: jest.fn(),
  enqueue: jest.fn(),
}));
jest.mock('../server/lib/core/notify', () => ({
  uploadStart: jest.fn(),
  uploadComplete: jest.fn(),
  uploadFailed: jest.fn(),
}));
jest.mock('../server/lib/core/biliup', () => ({ upload: jest.fn() }));
jest.mock('../server/lib/core/backup', () => ({ afterUpload: jest.fn() }));
jest.mock('../server/services/DataService', () => ({
  getSetting: jest.fn(),
}));

const UploadService = require('../server/services/UploadService');
const pool = require('../server/db/index');
const redis = require('../server/db/redis');
const transcodeQueue = require('../server/lib/core/TranscodeQueue');
const DataService = require('../server/services/DataService');

beforeEach(() => {
  jest.clearAllMocks();
  redis.get.mockResolvedValue(null);
  redis.incr.mockResolvedValue(1);
  transcodeQueue.hasSessionPending.mockResolvedValue(false);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// 按 key 返回 settings 值；未列出的 key 返回默认值
function mockSettings(values = {}) {
  const defaults = { delay: '60', auto_upload_grace_seconds: '180' };
  DataService.getSetting.mockImplementation(async (key, fallback) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
    if (Object.prototype.hasOwnProperty.call(defaults, key)) return defaults[key];
    return fallback;
  });
}

describe('UploadService.getEffectiveGraceSeconds', () => {
  test('returns max(delay, grace) when delay is larger', async () => {
    mockSettings({ delay: '600', auto_upload_grace_seconds: '180' });
    await expect(UploadService.getEffectiveGraceSeconds()).resolves.toBe(600);
  });

  test('returns max(delay, grace) when grace is larger', async () => {
    mockSettings({ delay: '30', auto_upload_grace_seconds: '300' });
    await expect(UploadService.getEffectiveGraceSeconds()).resolves.toBe(300);
  });

  test('grace keeps 180s floor even when delay is 0', async () => {
    mockSettings({ delay: '0', auto_upload_grace_seconds: '180' });
    await expect(UploadService.getEffectiveGraceSeconds()).resolves.toBe(180);
  });

  test('boundary: equal values', async () => {
    mockSettings({ delay: '180', auto_upload_grace_seconds: '180' });
    await expect(UploadService.getEffectiveGraceSeconds()).resolves.toBe(180);
  });

  test('boundary: grace upper limit 3600', async () => {
    mockSettings({ delay: '60', auto_upload_grace_seconds: '3600' });
    await expect(UploadService.getEffectiveGraceSeconds()).resolves.toBe(3600);
  });

  test('invalid non-numeric grace falls back to 180', async () => {
    mockSettings({ delay: '60', auto_upload_grace_seconds: 'abc' });
    await expect(UploadService.getEffectiveGraceSeconds()).resolves.toBe(180);
  });

  test('empty grace falls back to 180', async () => {
    mockSettings({ delay: '60', auto_upload_grace_seconds: '' });
    await expect(UploadService.getEffectiveGraceSeconds()).resolves.toBe(180);
  });

  test('negative grace falls back to 180', async () => {
    mockSettings({ delay: '60', auto_upload_grace_seconds: '-5' });
    await expect(UploadService.getEffectiveGraceSeconds()).resolves.toBe(180);
  });

  test('null grace falls back to 180', async () => {
    mockSettings({ delay: '60', auto_upload_grace_seconds: null });
    await expect(UploadService.getEffectiveGraceSeconds()).resolves.toBe(180);
  });

  test('invalid delay falls back to 60 (its own default) before max()', async () => {
    mockSettings({ delay: 'not-a-number', auto_upload_grace_seconds: '240' });
    await expect(UploadService.getEffectiveGraceSeconds()).resolves.toBe(240);
  });

  test('parseDurationSeconds truncates decimals and rejects non-finite', () => {
    expect(UploadService.parseDurationSeconds('12.9', 180)).toBe(12);
    expect(UploadService.parseDurationSeconds('Infinity', 180)).toBe(180);
    expect(UploadService.parseDurationSeconds(undefined, 180)).toBe(180);
  });
});

describe('UploadService.scanPendingAutoUpload — eligibility query', () => {
  test('SQL uses SQL-side grace cutoff and NOT EXISTS guards', async () => {
    mockSettings({ delay: '600', auto_upload_grace_seconds: '180' });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await UploadService.scanPendingAutoUpload();

    const [sql, params] = pool.query.mock.calls[0];
    expect(params).toEqual([600]);
    expect(sql).toContain("rs.status = 'completed'");
    expect(sql).toMatch(/rs\.ended_at\s*<\s*NOW\(\)\s*-\s*INTERVAL\s*'1 second'\s*\*\s*\$1/);
    expect(sql).toContain("rs2.status IN ('recording', 'pending')");
    expect(sql).toContain('rs2.deleted_at IS NULL');
    expect(sql).toContain("r2.status = 'recording'");
    expect(sql).toContain('r2.deleted_at IS NULL');
    expect(sql).toContain("ur.status IN ('uploading', 'success')");
    expect(sql).toContain('ur.deleted_at IS NULL');
    expect(sql).not.toMatch(/new Date|Date\.now/);
  });

  test('uses effective grace (max) as $1', async () => {
    mockSettings({ delay: '60', auto_upload_grace_seconds: '900' });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await UploadService.scanPendingAutoUpload();

    expect(pool.query.mock.calls[0][1]).toEqual([900]);
  });

  test('session younger than grace window is excluded by the query (no candidates)', async () => {
    mockSettings({ delay: '600', auto_upload_grace_seconds: '180' });
    // 数据库按 ended_at < NOW() - grace 过滤，未过窗口的会话不会出现在结果中
    pool.query.mockResolvedValueOnce({ rows: [] });

    await UploadService.scanPendingAutoUpload();

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('INTERVAL');
  });

  test('same-room recording/pending session guard is present (excludes candidates)', async () => {
    mockSettings();
    pool.query.mockResolvedValueOnce({ rows: [] });

    await UploadService.scanPendingAutoUpload();

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM recording_sessions rs2/);
    expect(sql).toContain("rs2.status IN ('recording', 'pending')");
  });

  test("room status 'recording' guard is present (excludes candidates)", async () => {
    mockSettings();
    pool.query.mockResolvedValueOnce({ rows: [] });

    await UploadService.scanPendingAutoUpload();

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM rooms r2/);
    expect(sql).toContain("r2.status = 'recording'");
  });

  test('fully eligible session is processed and executeUpload is called with { auto: true }', async () => {
    mockSettings({ delay: '600', auto_upload_grace_seconds: '180' });
    const row = {
      id: 77,
      room_url: 'https://live.example/7',
      room_name: '房间7',
      started_at: new Date(2026, 0, 2, 3, 0, 0),
      ended_at: new Date(2026, 0, 2, 4, 0, 0),
      upload_template_id: 5,
    };
    // 按 SQL 内容分派，避免依赖调用顺序
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT rs.id FROM recording_sessions')) return { rows: [{ id: 77 }] }; // 资格复查
      if (sql.includes('SELECT rs.*, r.room_name')) return { rows: [row] }; // 资格扫描
      if (sql.includes('FROM upload_templates')) {
        return { rows: [{ id: 5, name: '模板', title_template: '{room_name}', cookies_path: '/tmp/c.json' }] };
      }
      if (sql.includes('SELECT deleted_at FROM recording_sessions')) return { rows: [{ deleted_at: null }] };
      if (sql.includes('INSERT INTO upload_records')) return { rows: [{ id: 1 }] };
      if (sql.includes('FROM recording_files')) return { rows: [{ file_path: '/tmp/a.mp4' }] };
      return { rows: [] };
    });
    DataService.getSetting.mockImplementation(async (key, fallback) => {
      if (key === 'delay') return '600';
      if (key === 'auto_upload_grace_seconds') return '180';
      if (key === 'filtering_threshold') return '10';
      if (key === 'auto_transcode') return 'true';
      return fallback;
    });
    jest.spyOn(UploadService, '_runUpload').mockResolvedValue(undefined);
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
    jest.spyOn(require('fs'), 'statSync').mockReturnValue({ isFile: () => true, size: 20 * 1024 * 1024 });

    await UploadService.scanPendingAutoUpload();

    const insertCall = pool.query.mock.calls.find((c) => c[0].includes('INSERT INTO upload_records'));
    expect(insertCall).toBeDefined();
    expect(insertCall[1][0]).toBe(77);
    // 自动投稿在 INSERT 前做了资格复查（$2 为本会话 id）
    const recheck = pool.query.mock.calls.find(
      (c) => c[0].includes('SELECT rs.id FROM recording_sessions') && c[1][1] === 77
    );
    expect(recheck).toBeDefined();
    expect(recheck[1][0]).toBe(600);
  });
});

describe('UploadService.executeUpload({ auto: true })', () => {
  const baseSession = {
    id: 42,
    room_url: 'https://live.example/42',
    room_name: '房间42',
    started_at: new Date(2026, 0, 2, 3, 0, 0),
    ended_at: new Date(2026, 0, 2, 4, 0, 0),
  };
  const tmpl = {
    id: 3,
    name: '模板',
    title_template: '{room_name}',
    cookies_path: '/tmp/c.json',
  };

  function stubFs() {
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
    jest.spyOn(require('fs'), 'statSync').mockReturnValue({ isFile: () => true, size: 20 * 1024 * 1024 });
  }

  test('skips without creating upload_records when a concurrent active session exists', async () => {
    mockSettings({ delay: '60', auto_upload_grace_seconds: '180' });
    pool.query
      .mockResolvedValueOnce({ rows: [{ deleted_at: null }] }) // isSessionDeleted
      .mockResolvedValueOnce({ rows: [{ file_path: '/tmp/a.mp4' }] }) // recording_files
      .mockResolvedValueOnce({ rows: [] }); // eligibility re-check → no row (active same-room session)
    DataService.getSetting.mockImplementation(async (key, fallback) => {
      if (key === 'filtering_threshold') return '10';
      if (key === 'delay') return '60';
      if (key === 'auto_upload_grace_seconds') return '180';
      return fallback;
    });
    stubFs();

    const result = await UploadService.executeUpload(baseSession, tmpl, { auto: true });

    expect(result).toEqual({ skipped: true, reason: 'active_session_running' });
    expect(pool.query.mock.calls.some((c) => c[0].includes('INSERT INTO upload_records'))).toBe(false);
    // 资格复查发生在文件收集之后、创建记录之前
    const sqls = pool.query.mock.calls.map((c) => c[0]);
    expect(sqls.findIndex((s) => s.includes('FROM recording_files'))).toBeLessThan(
      sqls.findIndex((s) => s.includes('SELECT rs.id FROM recording_sessions'))
    );
  });

  test('proceeds normally when eligibility re-check passes', async () => {
    mockSettings({ delay: '60', auto_upload_grace_seconds: '180' });
    pool.query
      .mockResolvedValueOnce({ rows: [{ deleted_at: null }] }) // isSessionDeleted
      .mockResolvedValueOnce({ rows: [{ file_path: '/tmp/a.mp4' }] }) // recording_files
      .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // eligibility re-check hits
      .mockResolvedValueOnce({ rows: [{ id: 9 }] }); // INSERT upload_records
    DataService.getSetting.mockImplementation(async (key, fallback) => {
      if (key === 'delay') return '60';
      if (key === 'auto_upload_grace_seconds') return '180';
      if (key === 'filtering_threshold') return '10';
      return fallback;
    });
    stubFs();
    jest.spyOn(UploadService, '_runUpload').mockResolvedValue(undefined);

    const result = await UploadService.executeUpload(baseSession, tmpl, { auto: true });

    expect(result.error).toBe(false);
    const insertCall = pool.query.mock.calls.find((c) => c[0].includes('INSERT INTO upload_records'));
    expect(insertCall).toBeDefined();
    expect(insertCall[1][0]).toBe(42);
    // 复查使用有效冷静期
    const recheck = pool.query.mock.calls.find((c) => c[0].includes('SELECT rs.id FROM recording_sessions'));
    expect(recheck[1]).toEqual([180, 42]);
  });

  test('manual upload (no auto flag) skips the eligibility re-check', async () => {
    mockSettings({ delay: '600', auto_upload_grace_seconds: '180' });
    pool.query
      .mockResolvedValueOnce({ rows: [{ deleted_at: null }] }) // isSessionDeleted
      .mockResolvedValueOnce({ rows: [{ file_path: '/tmp/a.mp4' }] }) // recording_files
      .mockResolvedValueOnce({ rows: [{ id: 10 }] }); // INSERT
    DataService.getSetting.mockImplementation(async (key, fallback) => {
      if (key === 'filtering_threshold') return '10';
      return fallback;
    });
    stubFs();
    jest.spyOn(UploadService, '_runUpload').mockResolvedValue(undefined);

    const result = await UploadService.executeUpload(baseSession, tmpl);

    expect(result.error).toBe(false);
    expect(pool.query.mock.calls.some((c) => c[0].includes('SELECT rs.id FROM recording_sessions'))).toBe(false);
    expect(pool.query.mock.calls.some((c) => c[0].includes('INSERT INTO upload_records'))).toBe(true);
  });

  test('manual upload ignores grace window even when session just ended', async () => {
    mockSettings({ delay: '3600', auto_upload_grace_seconds: '3600' });
    pool.query
      .mockResolvedValueOnce({ rows: [{ deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ file_path: '/tmp/a.mp4' }] })
      .mockResolvedValueOnce({ rows: [{ id: 11 }] });
    DataService.getSetting.mockImplementation(async (key, fallback) => {
      if (key === 'filtering_threshold') return '10';
      return fallback;
    });
    stubFs();
    jest.spyOn(UploadService, '_runUpload').mockResolvedValue(undefined);

    const result = await UploadService.executeUpload(baseSession, tmpl);

    expect(result.error).toBe(false);
    expect(pool.query.mock.calls.some((c) => c[0].includes('INTERVAL'))).toBe(false);
  });
});
