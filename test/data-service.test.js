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
});
