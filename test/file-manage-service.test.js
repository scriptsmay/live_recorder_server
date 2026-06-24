// Mock 依赖模块
jest.mock('../server/db/index', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../server/db/redis', () => ({
  get: jest.fn(),
  set: jest.fn(),
  setEx: jest.fn(),
  del: jest.fn(),
  lRange: jest.fn().mockResolvedValue([]),
}));
jest.mock('../server/lib/utils/path-safety', () => ({
  resolveAndValidate: jest.fn(),
  ALLOWLIST_ROOTS: ['/data/video_downloads', '/data/replay'],
}));

const fs = require('fs');
const pool = require('../server/db/index');
const redis = require('../server/db/redis');
const { resolveAndValidate } = require('../server/lib/utils/path-safety');
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
// isFileInActiveTask: 4 queries (recording, transcode, burn, upload)
// + validateFileSafety 内部的 session check (1 query, source_table=recording_files)
// + recording_files status check (1 query)
// 共 6 次 pool.query
function mockSafetyQueries(times = 1) {
  for (let i = 0; i < times; i++) {
    pool.query.mockResolvedValueOnce({ rows: [] }); // isFileInActiveTask: recording
    pool.query.mockResolvedValueOnce({ rows: [] }); // isFileInActiveTask: transcode
    pool.query.mockResolvedValueOnce({ rows: [] }); // isFileInActiveTask: burn
    pool.query.mockResolvedValueOnce({ rows: [] }); // isFileInActiveTask: upload
    pool.query.mockResolvedValueOnce({ rows: [] }); // validateFileSafety: session check
    pool.query.mockResolvedValueOnce({ rows: [{ status: 'completed' }] }); // validateFileSafety: recording_files status
  }
}

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [] }); // 默认空返回
  redis.setEx.mockReset();
  redis.get.mockReset();
  redis.lRange.mockReset();
  redis.lRange.mockResolvedValue([]);
  resolveAndValidate.mockReset();
  resolveAndValidate.mockResolvedValue({ valid: true, resolvedPath: '/data/video_downloads/room1/session1/video.mp4' });
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
      .mockResolvedValueOnce({ rows: [] }) // isFileInActiveTask: burn
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
