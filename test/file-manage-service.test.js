// Mock 依赖模块
jest.mock('../server/db/index', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../server/db/redis', () => ({
  get: jest.fn(),
  set: jest.fn(),
  setEx: jest.fn(),
  del: jest.fn(),
  lRange: jest.fn().mockResolvedValue([]),
  sIsMember: jest.fn().mockResolvedValue(false),
}));
jest.mock('../server/lib/utils/path-safety', () => ({
  resolveAndValidate: jest.fn(),
  ALLOWLIST_ROOTS: ['/data/video_downloads', '/data/replay'],
}));
jest.mock('../server/lib/utils/directory-stats', () => ({
  getDirectoryStats: jest.fn(),
}));
jest.mock('../server/services/HLSCleanupService', () => ({
  deleteForRecording: jest.fn(),
}));

const fs = require('fs');
const pool = require('../server/db/index');
const redis = require('../server/db/redis');
const { resolveAndValidate } = require('../server/lib/utils/path-safety');
const { getDirectoryStats } = require('../server/lib/utils/directory-stats');
const hlsCleanupService = require('../server/services/HLSCleanupService');
const FileManageService = require('../server/services/FileManageService');

// helper：构造 managed_files 行
function makeFile(overrides = {}) {
  return {
    id: 1,
    file_path: '/data/video_downloads/room1/session1/video.mp4',
    file_name: 'video.mp4',
    file_size: 1024,
    category: 'recording',
    file_type: 'recording_file',
    source_table: 'recording_files',
    source_id: 100,
    group_id: '1',
    exists_on_disk: true,
    status: 'active',
    safe_to_delete: true,
    delete_block_reason: null,
    extension: 'mp4',
    mtime: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
    ...overrides,
  };
}

// helper：mock validateFileSafety 所需的全部查询
// isFileInActiveTask: 3 queries (recording, transcode, upload)
// + validateFileSafety 内部的 session check (1 query, source_table=recording_files)
// + recording_files status check (1 query)
// 共 5 次 pool.query
function mockSafetyQueries(times = 1) {
  for (let i = 0; i < times; i++) {
    pool.query.mockResolvedValueOnce({ rows: [] }); // isFileInActiveTask: recording
    pool.query.mockResolvedValueOnce({ rows: [] }); // isFileInActiveTask: transcode
    pool.query.mockResolvedValueOnce({ rows: [] }); // isFileInActiveTask: upload
    pool.query.mockResolvedValueOnce({ rows: [] }); // validateFileSafety: session check
    pool.query.mockResolvedValueOnce({ rows: [{ status: 'completed' }] }); // validateFileSafety: recording_files status
  }
}

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [] }); // 默认空返回
  pool.connect.mockReset();
  redis.setEx.mockReset();
  redis.get.mockReset();
  redis.lRange.mockReset();
  redis.lRange.mockResolvedValue([]);
  redis.sIsMember.mockReset();
  redis.sIsMember.mockResolvedValue(false);
  resolveAndValidate.mockReset();
  resolveAndValidate.mockResolvedValue({ valid: true, resolvedPath: '/data/video_downloads/room1/session1/video.mp4' });
  getDirectoryStats.mockReset();
  hlsCleanupService.deleteForRecording.mockReset();
});

// ========== getFileList ==========

describe('getFileList', () => {
  test('默认参数查询', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ total: '5' }] })
      .mockResolvedValueOnce({ rows: [makeFile(), makeFile({ id: 2 })] });

    const result = await FileManageService.getFileList();
    expect(result.total).toBe(5);
    expect(result.data).toHaveLength(2);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(50);
  });

  test('older_than_days 不破坏参数化', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ total: '0' }] }).mockResolvedValueOnce({ rows: [] });

    await FileManageService.getFileList({ older_than_days: '30', category: 'recording' });
    const countCall = pool.query.mock.calls[0];
    expect(countCall[0]).toContain("INTERVAL '30 days'");
    expect(countCall[0]).toContain('$1');
    expect(countCall[1]).toEqual(['recording']);
  });
});

// ========== getFileSummary ==========

describe('getFileSummary', () => {
  test('返回各分类汇总', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          { category: 'recording', total_size: '5000', file_count: '10' },
          { category: 'replay', total_size: '3000', file_count: '5' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ safe_size: '2000' }] });

    const summary = await FileManageService.getFileSummary();
    expect(summary.total_size).toBe(8000);
    expect(summary.safe_to_delete_size).toBe(2000);
    expect(summary.groups).toHaveLength(2);
  });
});

describe('_scanHlsDirectories', () => {
  test('同一会话的多个 HLS 目录分别索引并记录真实大小', async () => {
    const results = { scanned: 0, created: 0, updated: 0, missing: 0, errors: [] };
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            source_id: 101,
            session_id: 20,
            hls_playlist_path: '/data/video_downloads/20/hls_a/playlist.m3u8',
            hls_generated_at: new Date('2026-07-01T00:00:00Z'),
          },
          {
            source_id: 102,
            session_id: 20,
            hls_playlist_path: '/data/video_downloads/20/hls_b/playlist.m3u8',
            hls_generated_at: new Date('2026-07-02T00:00:00Z'),
          },
        ],
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    getDirectoryStats
      .mockResolvedValueOnce({ size: 111, mtime: new Date('2026-07-01T01:00:00Z') })
      .mockResolvedValueOnce({ size: 222, mtime: new Date('2026-07-02T01:00:00Z') });

    await FileManageService._scanHlsDirectories(results);

    expect(results.scanned).toBe(2);
    expect(results.created).toBe(2);
    const upserts = pool.query.mock.calls.filter((call) => call[0].includes('INSERT INTO managed_files'));
    expect(upserts).toHaveLength(2);
    expect(upserts[0][1]).toEqual(expect.arrayContaining(['recording_files', 101, 111]));
    expect(upserts[1][1]).toEqual(expect.arrayContaining(['recording_files', 102, 222]));
  });
});

// ========== generateDeletePlan ==========

describe('generateDeletePlan', () => {
  test('file_ids 模式超过 200 个抛错', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => i);
    await expect(FileManageService.generateDeletePlan({ file_ids: ids })).rejects.toThrow(
      'file_ids 模式单次最多 200 个文件'
    );
  });

  test('file_ids 模式正常执行', async () => {
    const file = makeFile();
    // SELECT * FROM managed_files WHERE id IN (...)
    pool.query.mockResolvedValueOnce({ rows: [file] });
    // validateFileSafety: 5 queries
    mockSafetyQueries(1);
    // Redis setEx
    redis.setEx.mockResolvedValueOnce('OK');

    const origStat = fs.promises.stat;
    fs.promises.stat = jest.fn().mockResolvedValue({ size: 1024, isDirectory: () => false });

    const plan = await FileManageService.generateDeletePlan({ file_ids: [1] });
    expect(plan.deletable_count).toBe(1);
    expect(plan.plan_id).toBeDefined();
    expect(plan.total_size).toBe(1024);

    fs.promises.stat = origStat;
  });

  test('missing 记录也进入删除计划', async () => {
    const file = makeFile({ status: 'missing', exists_on_disk: false });
    pool.query.mockResolvedValueOnce({ rows: [file] });
    mockSafetyQueries(1);
    redis.setEx.mockResolvedValueOnce('OK');

    const origStat = fs.promises.stat;
    fs.promises.stat = jest.fn().mockRejectedValue({ code: 'ENOENT' });

    const plan = await FileManageService.generateDeletePlan({ file_ids: [1] });

    expect(plan.deletable_count).toBe(1);
    expect(plan.blocked_count).toBe(0);
    expect(plan.deletable[0].file_id).toBe(file.id);

    fs.promises.stat = origStat;
  });
});

// ========== validateFileSafety ==========

describe('validateFileSafety', () => {
  test('allowlist 外路径被拒绝', async () => {
    resolveAndValidate.mockResolvedValueOnce({ valid: false, reason: 'outside_allowlist' });
    const result = await FileManageService.validateFileSafety(makeFile({ file_path: '/etc/passwd' }));
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('outside_allowlist');
  });

  test('目录类型被拒绝（非 hls_directory）', async () => {
    const origStat = fs.promises.stat;
    fs.promises.stat = jest.fn().mockResolvedValue({ isDirectory: () => true });

    const result = await FileManageService.validateFileSafety(makeFile({ file_type: 'recording_file' }));
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('is_directory');

    fs.promises.stat = origStat;
  });

  test('hls_directory 类型允许目录', async () => {
    const origStat = fs.promises.stat;
    fs.promises.stat = jest.fn().mockResolvedValue({ isDirectory: () => true });
    // isFileInActiveTask: 4 queries all empty (default mock)

    const result = await FileManageService.validateFileSafety(makeFile({ file_type: 'hls_directory' }));
    expect(result.safe).toBe(true);

    fs.promises.stat = origStat;
  });

  test('文件不存在被拒绝', async () => {
    const origStat = fs.promises.stat;
    fs.promises.stat = jest.fn().mockRejectedValue({ code: 'ENOENT' });

    const result = await FileManageService.validateFileSafety(makeFile());
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('file_not_found');

    fs.promises.stat = origStat;
  });

  test('删除语义允许 missing 文件继续做业务安全校验', async () => {
    const origStat = fs.promises.stat;
    fs.promises.stat = jest.fn().mockRejectedValue({ code: 'ENOENT' });
    mockSafetyQueries(1);

    const result = await FileManageService.validateFileSafety(makeFile({ status: 'missing' }), {
      allowMissing: true,
    });

    expect(result.safe).toBe(true);

    fs.promises.stat = origStat;
  });

  test('属于活跃录制会话被拒绝', async () => {
    const origStat = fs.promises.stat;
    fs.promises.stat = jest.fn().mockResolvedValue({ size: 1024, isDirectory: () => false });
    // isFileInActiveTask: 第一个查询（recording）返回有结果
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    const result = await FileManageService.validateFileSafety(makeFile());
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('active_task_recording');

    fs.promises.stat = origStat;
  });

  test('非 completed 状态的录制文件被拒绝', async () => {
    const origStat = fs.promises.stat;
    fs.promises.stat = jest.fn().mockResolvedValue({ size: 1024, isDirectory: () => false });
    // mockSafetyQueries 默认返回 [{status:'completed'}]，但这里需要 recording 状态
    // 先用 mockSafetyQueries 的结构，再覆盖最后一个 query 的返回值
    // 实际上 mockSafetyQueries 用的是 mockResolvedValueOnce 链，无法覆盖
    // 所以手动设置，但保持与 mockSafetyQueries 相同的查询顺序
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // isFileInActiveTask: recording
      .mockResolvedValueOnce({ rows: [] }) // isFileInActiveTask: transcode
      .mockResolvedValueOnce({ rows: [] }) // isFileInActiveTask: upload
      .mockResolvedValueOnce({ rows: [] }) // session check
      .mockResolvedValueOnce({ rows: [{ status: 'recording' }] }); // recording_files status → 非 completed

    const result = await FileManageService.validateFileSafety(makeFile());
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('recording_status_recording');

    fs.promises.stat = origStat;
  });
});

// ========== _parseJsonPaths ==========

describe('_parseJsonPaths', () => {
  test('解析 JSON 数组', () => {
    const result = FileManageService._parseJsonPaths('["/path/a.mp4", "/path/b.mp4"]');
    expect(result).toEqual(['/path/a.mp4', '/path/b.mp4']);
  });

  test('_parseJsonPaths 降级处理', () => {
    // 非数组 JSON 字符串 → 包装为数组
    const result = FileManageService._parseJsonPaths('"hello"');
    expect(result).toEqual(['"hello"']);
  });

  test('JSON 解析失败降级为原始文本', () => {
    const result = FileManageService._parseJsonPaths('/path/file.mp4');
    expect(result).toEqual(['/path/file.mp4']);
  });

  test('空值返回空数组', () => {
    expect(FileManageService._parseJsonPaths(null)).toEqual([]);
    expect(FileManageService._parseJsonPaths('')).toEqual([]);
  });
});

// ========== _deleteSingleFile ==========
// mock transaction client
function mockClient(overrides = {}) {
  const client = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
    ...overrides,
  };
  // 默认 BEGIN / COMMIT 成功
  client.query.mockImplementation(async (sql) => {
    if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
    return { rows: [], rowCount: 0 };
  });
  return client;
}

describe('_deleteSingleFile', () => {
  let origStat;
  let origUnlink;
  let origRm;

  beforeEach(() => {
    origStat = fs.promises.stat;
    origUnlink = fs.promises.unlink;
    origRm = fs.promises.rm;
  });

  afterEach(() => {
    fs.promises.stat = origStat;
    fs.promises.unlink = origUnlink;
    fs.promises.rm = origRm;
  });

  test('happy path — 文件删除成功 + 事务提交', async () => {
    const file = makeFile();
    const client = mockClient();

    // advisory lock
    pool.query.mockResolvedValueOnce({ rows: [{}] });
    // SELECT * FROM managed_files WHERE id = $1
    pool.query.mockResolvedValueOnce({ rows: [file] });
    // validateFileSafety 内部查询（通过 spy 绕过）
    jest.spyOn(FileManageService, 'validateFileSafety').mockResolvedValueOnce({ safe: true });
    // UPDATE status='deleting'
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // fs.unlink 成功
    fs.promises.stat = jest.fn().mockResolvedValue({ isDirectory: () => false });
    fs.promises.unlink = jest.fn().mockResolvedValue(undefined);
    // pool.connect
    pool.connect.mockResolvedValueOnce(client);
    // advisory unlock
    pool.query.mockResolvedValueOnce({ rows: [{}] });

    const result = await FileManageService._deleteSingleFile(
      {
        file_id: file.id,
        file_path: file.file_path,
        file_size: file.file_size,
        category: file.category,
        file_type: file.file_type,
        source_table: file.source_table,
        source_id: file.source_id,
      },
      'user'
    );

    expect(result.result).toBe('success');
    expect(result.actual_release_size).toBe(1024);
    expect(fs.promises.unlink).toHaveBeenCalledWith(file.file_path);
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
    // advisory unlock
    const unlockCall = pool.query.mock.calls.find((c) => c[0] === 'SELECT pg_advisory_unlock($1)');
    expect(unlockCall).toBeDefined();

    FileManageService.validateFileSafety.mockRestore();
  });

  test('ENOENT — 文件已不存在，返回 success_noop', async () => {
    const file = makeFile();
    const client = mockClient();

    pool.query.mockResolvedValueOnce({ rows: [{}] }); // advisory lock
    pool.query.mockResolvedValueOnce({ rows: [file] }); // SELECT managed_files
    jest.spyOn(FileManageService, 'validateFileSafety').mockResolvedValueOnce({ safe: true });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE deleting

    fs.promises.stat = jest.fn().mockResolvedValue({ isDirectory: () => false });
    fs.promises.unlink = jest.fn().mockRejectedValue({ code: 'ENOENT', message: 'no such file' });

    pool.connect.mockResolvedValueOnce(client);
    pool.query.mockResolvedValueOnce({ rows: [{}] }); // advisory unlock

    const result = await FileManageService._deleteSingleFile(
      {
        file_id: file.id,
        file_path: file.file_path,
        file_size: file.file_size,
        category: file.category,
        file_type: file.file_type,
        source_table: file.source_table,
        source_id: file.source_id,
      },
      'user'
    );

    expect(result.result).toBe('success_noop');
    expect(result.actual_release_size).toBe(0);
    expect(client.query).toHaveBeenCalledWith('COMMIT');

    FileManageService.validateFileSafety.mockRestore();
  });

  test('missing 记录 — 磁盘文件不存在时删除记录并返回 success_noop', async () => {
    const file = makeFile({ status: 'missing', exists_on_disk: false });
    const client = mockClient();

    pool.query.mockResolvedValueOnce({ rows: [{}] }); // advisory lock
    pool.query.mockResolvedValueOnce({ rows: [file] }); // SELECT managed_files
    mockSafetyQueries(1);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE deleting

    fs.promises.stat = jest.fn().mockRejectedValue({ code: 'ENOENT', message: 'no such file' });
    fs.promises.unlink = jest.fn();

    pool.connect.mockResolvedValueOnce(client);
    pool.query.mockResolvedValueOnce({ rows: [{}] }); // advisory unlock

    const result = await FileManageService._deleteSingleFile(
      {
        file_id: file.id,
        file_path: file.file_path,
        file_size: file.file_size,
        category: file.category,
        file_type: file.file_type,
        source_table: file.source_table,
        source_id: file.source_id,
      },
      'user'
    );

    expect(result.result).toBe('success_noop');
    expect(result.actual_release_size).toBe(0);
    expect(fs.promises.unlink).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  test('EBUSY — 文件被锁定，返回 blocked 并回滚状态', async () => {
    const file = makeFile();

    pool.query.mockResolvedValueOnce({ rows: [{}] }); // advisory lock
    pool.query.mockResolvedValueOnce({ rows: [file] }); // SELECT managed_files
    jest.spyOn(FileManageService, 'validateFileSafety').mockResolvedValueOnce({ safe: true });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE deleting

    fs.promises.stat = jest.fn().mockResolvedValue({ isDirectory: () => false });
    fs.promises.unlink = jest.fn().mockRejectedValue({ code: 'EBUSY', message: 'resource busy' });

    // UPDATE status='active' 回滚
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // _writeAuditLog INSERT
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // advisory unlock
    pool.query.mockResolvedValueOnce({ rows: [{}] });

    const result = await FileManageService._deleteSingleFile(
      {
        file_id: file.id,
        file_path: file.file_path,
        file_size: file.file_size,
        category: file.category,
        file_type: file.file_type,
        source_table: file.source_table,
        source_id: file.source_id,
      },
      'user'
    );

    expect(result.result).toBe('blocked');
    expect(result.error).toBe('file_locked');
    // 状态回滚为 active
    const rollbackCall = pool.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes("status = 'active'")
    );
    expect(rollbackCall).toBeDefined();
    // 不应进入事务
    expect(pool.connect).not.toHaveBeenCalled();

    FileManageService.validateFileSafety.mockRestore();
  });

  test('事务回滚 — unlink 成功但 DB 事务失败，补偿标记 missing', async () => {
    const file = makeFile();
    const client = mockClient();
    // COMMIT 抛异常触发 ROLLBACK
    client.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN') return { rows: [] };
      if (sql === 'COMMIT') throw new Error('connection lost');
      if (sql === 'ROLLBACK') return { rows: [] };
      return { rows: [], rowCount: 0 };
    });

    pool.query.mockResolvedValueOnce({ rows: [{}] }); // advisory lock
    pool.query.mockResolvedValueOnce({ rows: [file] }); // SELECT managed_files
    jest.spyOn(FileManageService, 'validateFileSafety').mockResolvedValueOnce({ safe: true });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE deleting

    fs.promises.stat = jest.fn().mockResolvedValue({ isDirectory: () => false });
    fs.promises.unlink = jest.fn().mockResolvedValue(undefined); // unlink 成功

    pool.connect.mockResolvedValueOnce(client);

    // 补偿 UPDATE managed_files SET exists_on_disk=false, status='missing'
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // advisory unlock
    pool.query.mockResolvedValueOnce({ rows: [{}] });

    const result = await FileManageService._deleteSingleFile(
      {
        file_id: file.id,
        file_path: file.file_path,
        file_size: file.file_size,
        category: file.category,
        file_type: file.file_type,
        source_table: file.source_table,
        source_id: file.source_id,
      },
      'user'
    );

    expect(result.result).toBe('failed');
    expect(result.error).toBe('connection lost');
    expect(client.release).toHaveBeenCalled();
    // 验证补偿逻辑被执行
    const compCall = pool.query.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes("status = 'missing'"));
    expect(compCall).toBeDefined();
    expect(compCall[1]).toEqual([file.id]);

    FileManageService.validateFileSafety.mockRestore();
  });

  test('记录已删除 — status 为 deleted 时返回 blocked', async () => {
    const file = makeFile({ status: 'deleted' });

    pool.query.mockResolvedValueOnce({ rows: [{}] }); // advisory lock
    pool.query.mockResolvedValueOnce({ rows: [file] }); // SELECT managed_files
    pool.query.mockResolvedValueOnce({ rows: [{}] }); // advisory unlock

    const result = await FileManageService._deleteSingleFile(
      {
        file_id: file.id,
        file_path: file.file_path,
        file_size: file.file_size,
        category: file.category,
        file_type: file.file_type,
        source_table: file.source_table,
        source_id: file.source_id,
      },
      'user'
    );

    expect(result.result).toBe('blocked');
    expect(result.error).toBe('already_deleted_or_deleting');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('记录不存在 — managed_files 行缺失返回 blocked', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{}] }); // advisory lock
    pool.query.mockResolvedValueOnce({ rows: [] }); // SELECT managed_files → 无记录
    pool.query.mockResolvedValueOnce({ rows: [{}] }); // advisory unlock

    const result = await FileManageService._deleteSingleFile(
      {
        file_id: 999,
        file_path: '/data/video_downloads/ghost.mp4',
        file_size: 100,
        category: 'recording',
        file_type: 'recording_file',
        source_table: 'recording_files',
        source_id: 999,
      },
      'user'
    );

    expect(result.result).toBe('blocked');
    expect(result.error).toBe('file_record_not_found');
  });

  test('安全规则不通过 — validateFileSafety 返回 blocked', async () => {
    const file = makeFile();

    pool.query.mockResolvedValueOnce({ rows: [{}] }); // advisory lock
    pool.query.mockResolvedValueOnce({ rows: [file] }); // SELECT managed_files
    jest
      .spyOn(FileManageService, 'validateFileSafety')
      .mockResolvedValueOnce({ safe: false, reason: 'active_task_recording' });
    pool.query.mockResolvedValueOnce({ rows: [{}] }); // advisory unlock

    const result = await FileManageService._deleteSingleFile(
      {
        file_id: file.id,
        file_path: file.file_path,
        file_size: file.file_size,
        category: file.category,
        file_type: file.file_type,
        source_table: file.source_table,
        source_id: file.source_id,
      },
      'user'
    );

    expect(result.result).toBe('blocked');
    expect(result.error).toBe('active_task_recording');
    expect(pool.connect).not.toHaveBeenCalled();

    FileManageService.validateFileSafety.mockRestore();
  });

  test('advisory unlock 失败不抛异常', async () => {
    const file = makeFile();
    const client = mockClient();

    pool.query.mockResolvedValueOnce({ rows: [{}] }); // advisory lock
    pool.query.mockResolvedValueOnce({ rows: [file] }); // SELECT managed_files
    jest.spyOn(FileManageService, 'validateFileSafety').mockResolvedValueOnce({ safe: true });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE deleting

    fs.promises.stat = jest.fn().mockResolvedValue({ isDirectory: () => false });
    fs.promises.unlink = jest.fn().mockResolvedValue(undefined);

    pool.connect.mockResolvedValueOnce(client);
    // advisory unlock 抛异常
    pool.query.mockRejectedValueOnce(new Error('connection closed'));

    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await FileManageService._deleteSingleFile(
      {
        file_id: file.id,
        file_path: file.file_path,
        file_size: file.file_size,
        category: file.category,
        file_type: file.file_type,
        source_table: file.source_table,
        source_id: file.source_id,
      },
      'user'
    );

    expect(result.result).toBe('success');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('advisory_unlock 失败'));

    consoleSpy.mockRestore();
    FileManageService.validateFileSafety.mockRestore();
  });

  test('EPERM — 权限拒绝，返回 blocked', async () => {
    const file = makeFile();

    pool.query.mockResolvedValueOnce({ rows: [{}] }); // advisory lock
    pool.query.mockResolvedValueOnce({ rows: [file] }); // SELECT managed_files
    jest.spyOn(FileManageService, 'validateFileSafety').mockResolvedValueOnce({ safe: true });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE deleting

    fs.promises.stat = jest.fn().mockResolvedValue({ isDirectory: () => false });
    fs.promises.unlink = jest.fn().mockRejectedValue({ code: 'EPERM', message: 'operation not permitted' });

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // rollback active
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // audit log
    pool.query.mockResolvedValueOnce({ rows: [{}] }); // advisory unlock

    const result = await FileManageService._deleteSingleFile(
      {
        file_id: file.id,
        file_path: file.file_path,
        file_size: file.file_size,
        category: file.category,
        file_type: file.file_type,
        source_table: file.source_table,
        source_id: file.source_id,
      },
      'user'
    );

    expect(result.result).toBe('blocked');
    expect(result.error).toBe('file_locked');

    FileManageService.validateFileSafety.mockRestore();
  });

  test('HLS 目录 — 委托统一 HLS 删除服务', async () => {
    const file = makeFile({
      file_type: 'hls_directory',
      file_path: '/data/video_downloads/room1/session1/hls',
    });
    hlsCleanupService.deleteForRecording.mockResolvedValue({
      result: 'success',
      actual_release_size: 1024,
      hls_status: 'deleted',
    });

    const result = await FileManageService._deleteSingleFile(
      {
        file_id: file.id,
        file_path: file.file_path,
        file_size: file.file_size,
        category: file.category,
        file_type: file.file_type,
        source_table: file.source_table,
        source_id: file.source_id,
      },
      'user'
    );

    expect(result.result).toBe('success');
    expect(hlsCleanupService.deleteForRecording).toHaveBeenCalledWith(100, 'user', 'user');
  });

  test('recording_files 源表同步更新为 deleted', async () => {
    const file = makeFile({ source_table: 'recording_files', source_id: 100, file_type: 'recording_file' });
    const client = mockClient();
    const clientQueries = [];
    client.query.mockImplementation(async (sql, params) => {
      clientQueries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      return { rows: [], rowCount: 0 };
    });

    pool.query.mockResolvedValueOnce({ rows: [{}] }); // advisory lock
    pool.query.mockResolvedValueOnce({ rows: [file] }); // SELECT managed_files
    jest.spyOn(FileManageService, 'validateFileSafety').mockResolvedValueOnce({ safe: true });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE deleting

    fs.promises.stat = jest.fn().mockResolvedValue({ isDirectory: () => false });
    fs.promises.unlink = jest.fn().mockResolvedValue(undefined);

    pool.connect.mockResolvedValueOnce(client);
    pool.query.mockResolvedValueOnce({ rows: [{}] }); // advisory unlock

    const result = await FileManageService._deleteSingleFile(
      {
        file_id: file.id,
        file_path: file.file_path,
        file_size: file.file_size,
        category: file.category,
        file_type: file.file_type,
        source_table: file.source_table,
        source_id: file.source_id,
      },
      'user'
    );

    expect(result.result).toBe('success');
    // 验证事务中更新了 recording_files
    const rfUpdate = clientQueries.find(
      (q) => typeof q.sql === 'string' && q.sql.includes('UPDATE recording_files SET status')
    );
    expect(rfUpdate).toBeDefined();
    expect(rfUpdate.params).toEqual([100]);

    FileManageService.validateFileSafety.mockRestore();
  });
});

// ========== executeDelete ==========
describe('executeDelete', () => {
  test('plan 不存在抛异常', async () => {
    redis.get.mockResolvedValueOnce(null);
    await expect(FileManageService.executeDelete('nonexistent-plan')).rejects.toThrow('删除计划不存在或已过期');
  });

  test('返回 task_id 和 processing 状态', async () => {
    const plan = {
      plan_id: 'test-plan',
      deletable: [makeFile()],
      blocked: [],
      total_size: 1024,
    };
    redis.get.mockResolvedValueOnce(JSON.stringify(plan));
    redis.setEx.mockResolvedValueOnce('OK');
    // _processDeleteTask 会后台执行，mock 它避免副作用
    jest.spyOn(FileManageService, '_processDeleteTask').mockResolvedValueOnce(undefined);

    const result = await FileManageService.executeDelete('test-plan', 'user');
    expect(result.task_id).toBeDefined();
    expect(result.status).toBe('processing');
    expect(redis.setEx).toHaveBeenCalledWith(
      `file_delete_task:${result.task_id}`,
      expect.any(Number),
      expect.stringContaining('"status":"processing"')
    );

    FileManageService._processDeleteTask.mockRestore();
  });
});
