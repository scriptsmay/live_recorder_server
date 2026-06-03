const fs = require('fs');
const pool = require('../db/index');
const DataService = require('../services/DataService');

jest.mock('../db/index', () => ({
  query: jest.fn(),
}));

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

  test('按录制文件 id 解析确定性分段 ASS 路径', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 42,
            session_id: 18,
            file_path: '/tmp/video.ts',
            session_output_dir: '/tmp/session-18',
            danmaku_ass_path: '',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ count: '1' }],
      });

    const { rows } = await DataService.getRecordingFiles({ session_id: 18 });

    expect(rows[0].danmaku_ass_exists).toBe(true);
    expect(rows[0].danmaku_ass_path).toBe('/tmp/session-18/danmaku/segments/42.ass');
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
      .mockResolvedValueOnce({ rows: [null] })
      .mockResolvedValueOnce({ rows: [] });

    const detail = await DataService.getSessionDetail(52);

    expect(detail.capture.status).toBe('completed');
    expect(pool.query).toHaveBeenLastCalledWith(expect.stringContaining("SET status = 'completed'"), [
      '2026-06-04T10:00:00.000Z',
      0,
      7,
    ]);
  });
});
