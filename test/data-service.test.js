const fs = require('fs');
const pool = require('../server/db/index');
const DataService = require('../server/services/DataService');

jest.mock('../server/db/index', () => ({
  query: jest.fn(),
}));

describe('DataService.getSessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('列表查询不读取弹幕 JSONL 文件计数', async () => {
    const readFileSpy = jest.spyOn(fs.promises, 'readFile');
    const existsSpy = jest.spyOn(fs, 'existsSync');

    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 22,
            danmaku_event_count: 9565,
            danmaku_raw_path: '/tmp/session-22/danmaku/danmaku.jsonl',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ count: '1' }],
      })
      .mockResolvedValueOnce({
        rows: [],
      });

    const { rows, total } = await DataService.getSessions({ page: 1, limit: 50 });

    expect(rows[0].danmaku_event_count).toBe(9565);
    expect(total).toBe(1);
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(existsSpy).not.toHaveBeenCalled();
  });
});

describe('DataService.getRecordingFiles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('按 session_id 过滤录制文件', async () => {
    // 主查询返回录制文件记录
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 1, session_id: 18, file_path: '/tmp/a.ts' }],
      })
      // 计数查询返回总数
      .mockResolvedValueOnce({
        rows: [{ count: '1' }],
      });

    const { rows, total } = await DataService.getRecordingFiles({ session_id: 18 });

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('rf.session_id = $1'), [18]);
    expect(rows).toHaveLength(1);
    expect(rows[0].file_exists).toBe(true);
    expect(total).toBe(1);
  });

  test('兼容 sessionId 参数别名', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 2, session_id: 18, file_path: '/tmp/b.ts' }],
      })
      .mockResolvedValueOnce({
        rows: [{ count: '1' }],
      });

    await DataService.getRecordingFiles({ sessionId: '18' });

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('rf.session_id = $1'), [18]);
  });

  test('按录制文件 id 返回 file_exists 字段', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 42,
            session_id: 18,
            file_path: '/tmp/video.ts',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ count: '1' }],
      });

    const { rows } = await DataService.getRecordingFiles({ session_id: 18 });

    expect(rows[0].file_exists).toBe(true);
  });
});

describe('DataService.getSessionDetail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('会话已结束时修正遗留的 recording 弹幕状态', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 52, status: 'completed', ended_at: '2026-06-04T10:00:00.000Z', output_dir: '/tmp/s52' }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 7, session_id: 52, status: 'recording', event_count: 0, raw_path: '/tmp/s52/danmaku.jsonl' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [null] });

    const detail = await DataService.getSessionDetail(52);

    expect(detail.capture.status).toBe('completed');
    expect(pool.query).toHaveBeenLastCalledWith(expect.stringContaining("SET status = 'completed'"), [
      '2026-06-04T10:00:00.000Z',
      0,
      7,
    ]);
  });
});

describe('DataService dashboard helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('聚合 Dashboard 今日摘要', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            sessions_today: '3',
            sessions_today_total_size: '2048',
            interrupted_today: '1',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ uploads_today: '2', uploads_failed_today: '1' }],
      })
      .mockResolvedValueOnce({
        rows: [{ orphaned_files: '4' }],
      })
      .mockResolvedValueOnce({
        rows: [{ replay_pending: '5', replay_completed_today: '2', replay_completed_today_size: '1024000' }],
      });

    const summary = await DataService.getDashboardSummary('2026-06-10T00:00:00.000Z');

    expect(summary).toEqual({
      sessions_today: 3,
      sessions_today_total_size: 2048,
      interrupted_today: 1,
      uploads_today: 2,
      uploads_failed_today: 1,
      orphaned_files: 4,
      replay_pending: 5,
      replay_completed_today: 2,
      replay_completed_today_size: 1024000,
    });
    expect(pool.query).toHaveBeenCalledTimes(4);
    expect(pool.query.mock.calls[0][1]).toEqual(['2026-06-10T00:00:00.000Z']);
    expect(pool.query.mock.calls[1][1]).toEqual(['2026-06-10T00:00:00.000Z']);
    expect(pool.query.mock.calls[3][1]).toEqual(['2026-06-10T00:00:00.000Z']);
  });

  test('查询 Dashboard 近期活动并限制条数', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          type: 'session_completed',
          title: '测试房间 录制完成',
          detail: '2 个分段, 1 MB',
          timestamp: '2026-06-10T12:00:00.000Z',
          link: '/sessions',
        },
      ],
    });

    const activities = await DataService.getRecentActivity(5);

    expect(activities).toHaveLength(1);
    expect(activities[0].type).toBe('session_completed');
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('UNION ALL'), [5]);
    expect(pool.query.mock.calls[0][0]).toContain('LEFT JOIN rooms rm ON rs.room_url = rm.room_url');
    expect(pool.query.mock.calls[0][0]).toContain('LEFT JOIN recording_files rf ON rf.file_path = tr.original_path');
    expect(pool.query.mock.calls[0][0]).toContain("'replay_completed'");
    expect(pool.query.mock.calls[0][0]).toContain("'replay_failed'");
    expect(pool.query.mock.calls[0][0]).toContain('FROM replay_records rr');
    expect(pool.query.mock.calls[0][0]).toContain("'/replay-toolbox'");
  });

  test('统计直播间总数', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ count: '8' }] });

    await expect(DataService.getRoomTotal()).resolves.toBe(8);
    // v1.12.0：软删房间不计入总数
    expect(pool.query).toHaveBeenCalledWith('SELECT COUNT(*) FROM rooms WHERE deleted_at IS NULL');
  });
});

describe('DataService.getUploadRecords', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('按 season_status 过滤且计数查询共用同一条件', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 101, season_status: 'failed' }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const { total } = await DataService.getUploadRecords({ season_status: 'failed', limit: 50 });

    expect(total).toBe(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('ur.season_status = $1');
    expect(params).toEqual(['failed', 50]);
    expect(pool.query.mock.calls[1][0]).toContain('ur.season_status = $1');
    expect(pool.query.mock.calls[1][1]).toEqual(['failed']);
  });

  test('未传 season_status 时不生成该条件', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await DataService.getUploadRecords({ status: 'success', limit: 50 });

    expect(pool.query.mock.calls[0][0]).not.toContain('season_status');
    expect(pool.query.mock.calls[0][1]).toEqual(['success', 50]);
  });

  test('title 生成 ILIKE 子串条件且计数共用同一参数', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValueOnce({ rows: [{ count: '1' }] });

    await DataService.getUploadRecords({ title: '回放', limit: 10 });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('ur.title ILIKE $1');
    // 通配符由服务端包裹，用户输入仍走占位符
    expect(params).toEqual(['%回放%', 10]);
    expect(pool.query.mock.calls[1][0]).toContain('ur.title ILIKE $1');
    expect(pool.query.mock.calls[1][1]).toEqual(['%回放%']);
  });

  test('分页时返回 page/limit 且计数参数不含分页两项', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: '3' }] });

    const result = await DataService.getUploadRecords({ page: '2', limit: 10 });

    expect(result).toEqual({ rows: [], total: 3, page: 2, limit: 10 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('LIMIT $1 OFFSET $2');
    expect(params).toEqual([10, 10]);
    expect(pool.query.mock.calls[1][1]).toEqual([]);
  });

  test('联出模板的 season_title/section_id 供前端展示合集名（计数查询不联表）', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValueOnce({ rows: [{ count: '1' }] });

    await DataService.getUploadRecords({ limit: 10 });

    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('ut.season_title');
    expect(sql).toContain('ut.section_id');
    // 计数只需要主表，联表会白搭一次 JOIN
    expect(pool.query.mock.calls[1][0]).not.toContain('season_title');
  });
});
