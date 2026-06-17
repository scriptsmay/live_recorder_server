jest.mock('../db/index', () => ({
  query: jest.fn(),
}));

const pool = require('../db/index');
const ReplayService = require('../services/ReplayService');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ReplayService', () => {
  test('extractPrincipalId 支持快手 u 路径', () => {
    expect(ReplayService.extractPrincipalId('https://live.kuaishou.com/u/3xhpa8nk4a7xdg6')).toBe('3xhpa8nk4a7xdg6');
  });

  test('extractPrincipalId 支持短路径', () => {
    expect(ReplayService.extractPrincipalId('https://live.kuaishou.com/3xhpa8nk4a7xdg6')).toBe('3xhpa8nk4a7xdg6');
  });

  test('getPrincipals 从 rooms 聚合回放统计', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            room_url: 'https://live.kuaishou.com/u/abc',
            room_name: '主播A',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            principal_id: 'abc',
            replay_count: 2,
            latest_replay_time: '2026-06-17T10:00:00.000Z',
            latest_status: 'fixed',
          },
        ],
      });

    const data = await ReplayService.getPrincipals();

    expect(data).toEqual([
      {
        principal_id: 'abc',
        room_id: 1,
        room_url: 'https://live.kuaishou.com/u/abc',
        room_name: '主播A',
        replay_count: 2,
        latest_replay_time: '2026-06-17T10:00:00.000Z',
        latest_status: 'fixed',
      },
    ]);
  });

  test('listRecords 返回分页结构', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, principal_id: 'abc' }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const data = await ReplayService.listRecords('abc', { page: '2', page_size: '10', status: 'fixed' });

    expect(data.rows).toHaveLength(1);
    expect(data.total).toBe(1);
    expect(data.page).toBe(2);
    expect(data.page_size).toBe(10);
    expect(pool.query.mock.calls[0][1]).toEqual(['abc', 'fixed', 10, 10]);
  });

  test('extractPrincipalId 返回 null 处理非快手 URL', () => {
    expect(ReplayService.extractPrincipalId('https://www.bilibili.com/video/BV123')).toBeNull();
    expect(ReplayService.extractPrincipalId('')).toBeNull();
    expect(ReplayService.extractPrincipalId(null)).toBeNull();
  });

  test('extractPrincipalId 处理畸形 URL', () => {
    expect(ReplayService.extractPrincipalId('not a url')).toBeNull();
    expect(ReplayService.extractPrincipalId('https://live.kuaishou.com/')).toBeNull();
  });

  test('getPrincipals 限定 live.kuaishou.com 子域(避免非 live 房间产生空 principal_id)', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await ReplayService.getPrincipals();

    const sql = pool.query.mock.calls[0][0];
    expect(sql).toMatch(/live\.kuaishou\.com/);
    expect(sql).not.toMatch(/%kuaishou\.com%/);
  });

  test('getRecord 返回单条记录', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, principal_id: 'abc', status: 'pending' }] });

    const record = await ReplayService.getRecord(5);

    expect(record).toEqual({ id: 5, principal_id: 'abc', status: 'pending' });
    expect(pool.query).toHaveBeenCalledWith('SELECT * FROM replay_records WHERE id = $1', [5]);
  });

  test('getRecord 不存在时返回 null', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const record = await ReplayService.getRecord(999);

    expect(record).toBeNull();
  });

  test('getRecordByReplayId 按 principal + replay_id 查询', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, principal_id: 'abc', replay_id: 'r1' }] });

    const record = await ReplayService.getRecordByReplayId('abc', 'r1');

    expect(record).toEqual({ id: 5, principal_id: 'abc', replay_id: 'r1' });
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT * FROM replay_records WHERE principal_id = $1 AND replay_id = $2 LIMIT 1',
      ['abc', 'r1']
    );
  });

  test('updateRecordStatus 构建动态 SQL', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, status: 'downloaded', raw_file_path: '/tmp/a.mp4' }] });

    const result = await ReplayService.updateRecordStatus(5, 'downloaded', {
      raw_file_path: '/tmp/a.mp4',
      file_size: 1024,
    });

    expect(result.status).toBe('downloaded');
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('status = $1');
    expect(sql).toContain('raw_file_path');
    expect(sql).toContain('file_size');
  });

  test('listRecords 支持 date_from 和 date_to 筛选', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await ReplayService.listRecords('abc', { date_from: '2026-01-01', date_to: '2026-06-30' });

    const params = pool.query.mock.calls[0][1];
    expect(params).toContain('abc');
    expect(params).toContain('2026-01-01');
    expect(params).toContain('2026-06-30');
  });

  test('syncRecords dry_run 返回验证结果', async () => {
    const result = await ReplayService.syncRecords({ principal_id: 'abc', count: 3, dry_run: true });

    expect(result.dry_run).toBe(true);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
  });

  test('syncRecords 缺少 principal_id 抛出错误', async () => {
    await expect(ReplayService.syncRecords({ count: 1 })).rejects.toThrow('缺少 principal_id');
  });

  test('getSettings 合并默认值和主播覆盖', async () => {
    // Mock DataService.getSetting
    const DataService = require('../services/DataService');
    DataService.getSetting = jest.fn(async (key, def) => def);

    pool.query.mockResolvedValueOnce({ rows: [{ key: 'auto_upload', value: 'true' }] });

    const settings = await ReplayService.getSettings('abc');

    expect(settings.auto_upload).toBe('true');
    expect(settings.auto_backup).toBe('true'); // default
  });

  test('updateSettings 过滤非法字段', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ key: 'auto_upload', principal_id: 'abc', value: 'true' }] });
    await ReplayService.updateSettings('abc', { illegal_key: 'hack', auto_upload: 'true' });

    // 只应插入 auto_upload
    expect(pool.query).toHaveBeenCalledTimes(1);
    const params = pool.query.mock.calls[0][1];
    expect(params[0]).toBe('auto_upload');
  });
});
