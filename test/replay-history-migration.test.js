jest.mock('../db/index', () => ({
  connect: jest.fn(),
  end: jest.fn(),
}));

const {
  parseArgs,
  asShanghaiTimestamp,
  mapRecord,
  fetchSourceRecords,
} = require('../scripts/migrate-wuyan-replay-history');

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

  test('mapRecord 兼容 wuyan-replay records 旧字段', () => {
    const row = mapRecord({
      principal_id: 'abc',
      external_id: 'ks-replay-1',
      video_file_name: '直播回放.mp4',
      replay_time: 1716364800000,
      status: 'downloaded',
    });

    expect(row.replay_id).toBe('ks-replay-1');
    expect(row.video_file_name).toBe('直播回放.mp4');
    expect(row.start_time).toBe('2024-05-22 16:00:00+08:00');
    expect(row.status).toBe('backed_up');
  });

  test('fetchSourceRecords 排序时兼容 bigint epoch 和 timestamp 混合字段', async () => {
    const sourcePool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({
          rows: [
            { column_name: 'replay_time', data_type: 'bigint' },
            { column_name: 'created_at', data_type: 'timestamp without time zone' },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }),
    };

    await fetchSourceRecords(sourcePool, { dryRun: true, limit: 5, principal: null });

    expect(sourcePool.query.mock.calls[1][0]).toContain(
      'COALESCE(to_timestamp(CASE WHEN replay_time > 10000000000 THEN replay_time / 1000.0 ELSE replay_time END), created_at)'
    );
  });
});
