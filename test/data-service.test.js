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
    pool.query.mockResolvedValue({
      rows: [{ id: 1, session_id: 18, file_path: '/tmp/a.ts' }],
    });

    const rows = await DataService.getRecordingFiles({ session_id: 18 });

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE session_id = $1'), [18]);
    expect(rows).toHaveLength(1);
    expect(rows[0].file_exists).toBe(true);
  });

  test('兼容 sessionId 参数别名', async () => {
    pool.query.mockResolvedValue({
      rows: [{ id: 2, session_id: 18, file_path: '/tmp/b.ts' }],
    });

    await DataService.getRecordingFiles({ sessionId: '18' });

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE session_id = $1'), [18]);
  });
});
