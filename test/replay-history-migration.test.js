jest.mock('../db/index', () => ({
  connect: jest.fn(),
  end: jest.fn(),
}));

const { parseArgs, asShanghaiTimestamp, mapRecord } = require('../scripts/migrate-wuyan-replay-history');

describe('migrate-wuyan-replay-history', () => {
  test('parseArgs 解析 dry-run、limit、principal', () => {
    expect(parseArgs(['--dry-run', '--limit', '5', '--principal', 'abc'])).toEqual({
      dryRun: true,
      limit: 5,
      principal: 'abc',
    });
  });

  test('asShanghaiTimestamp 为无时区时间附加 +08:00', () => {
    expect(asShanghaiTimestamp('2026-06-17 10:20:30')).toBe('2026-06-17 10:20:30+08:00');
  });

  test('asShanghaiTimestamp 保留已有时区', () => {
    expect(asShanghaiTimestamp('2026-06-17T10:20:30Z')).toBe('2026-06-17T10:20:30Z');
  });

  test('mapRecord 映射关键字段', () => {
    const row = mapRecord({
      principal_id: 'abc',
      replay_id: 'r1',
      file_path: '/tmp/a.mp4',
      status: 'uploaded',
      upload_time: '2026-06-17 10:00:00',
    });

    expect(row.principal_id).toBe('abc');
    expect(row.replay_id).toBe('r1');
    expect(row.final_file_paths).toBe(JSON.stringify(['/tmp/a.mp4']));
    expect(row.uploaded_at).toBe('2026-06-17 10:00:00+08:00');
  });
});
