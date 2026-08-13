// ADR-012 Phase 3：DataService.getSessionsOverlappingWindow SQL 契约测试
// 重点验证：
// 1. 返回字段为 epoch ms（数值），业务代码不做二次转换
// 2. ended_at IS NULL 时通过 SQL 兜底（LEFT JOIN recording_files + started_at+maxSessionMs）
// 3. 时间窗重叠判定：started_ms <= windowEnd AND ended_ms >= windowStart

jest.mock('../server/db/index', () => ({
  query: jest.fn(),
}));

const pool = require('../server/db/index');
const DataService = require('../server/services/DataService');

describe('DataService.getSessionsOverlappingWindow', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  test('SQL 使用 EXTRACT(EPOCH ...) 显式取 epoch ms，避免时区歧义', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await DataService.getSessionsOverlappingWindow('http://test-room', 1000000, 2000000, 28800000);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const sql = pool.query.mock.calls[0][0];
    // 必须使用 EXTRACT(EPOCH ...) * 1000 而非 Node 侧 Date.getTime()
    expect(sql).toMatch(/EXTRACT\(EPOCH FROM/);
    expect(sql).toMatch(/AT TIME ZONE current_setting\('TimeZone'\)/);
    // SQL 应该 JOIN recording_files 拿最后分片时间作为 ended_at 兜底
    expect(sql).toMatch(/recording_files/);
    // 参数顺序：roomUrl, windowStart, windowEnd, maxSessionMs
    expect(pool.query.mock.calls[0][1]).toEqual(['http://test-room', 1000000, 2000000, 28800000]);
  });

  test('返回字段转换为 Number，业务代码不做二次 parse', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 118, started_ms: '1700000000000', ended_ms: '1700003600000', ended_at_inferred: false },
        { id: 119, started_ms: '1700004000000', ended_ms: '1700007600000', ended_at_inferred: true },
      ],
    });

    const result = await DataService.getSessionsOverlappingWindow('http://test', 0, Date.now());
    expect(result).toHaveLength(2);
    expect(typeof result[0].started_ms).toBe('number');
    expect(typeof result[0].ended_ms).toBe('number');
    expect(result[0].started_ms).toBe(1700000000000);
    expect(result[0].ended_at_inferred).toBe(false);
    expect(result[1].ended_at_inferred).toBe(true);
  });

  test('默认 maxSessionMs 为 28800000（8 小时）', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await DataService.getSessionsOverlappingWindow('http://test', 0, 1000);

    expect(pool.query.mock.calls[0][1][3]).toBe(28800000);
  });
});

describe('DataService.listOrphanDanmakuRecords', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  test('缺省筛选所有 orphan_* 状态', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await DataService.listOrphanDanmakuRecords();
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toMatch(/orphan/);
    expect(sql).toMatch(/LIKE/);
  });

  test('指定 status 时只筛选该状态', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await DataService.listOrphanDanmakuRecords({ status: 'orphan_pending' });
    expect(pool.query.mock.calls[0][1]).toContain('orphan_pending');
  });

  test('返回每条记录附带 file_exists 字段', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, raw_path: '/nonexistent/path.jsonl', status: 'orphan_pending' }],
    });
    const result = await DataService.listOrphanDanmakuRecords();
    expect(result[0]).toHaveProperty('file_exists');
    expect(result[0].file_exists).toBe(false);
  });
});
