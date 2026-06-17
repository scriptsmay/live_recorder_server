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
});
