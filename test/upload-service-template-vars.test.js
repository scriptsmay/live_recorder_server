jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({
  incr: jest.fn(),
  expire: jest.fn(),
  set: jest.fn(),
  get: jest.fn(),
}));
jest.mock('../server/lib/core/TranscodeQueue', () => ({
  hasSessionPending: jest.fn(),
}));
jest.mock('../server/lib/core/notify', () => ({
  uploadStart: jest.fn(),
  uploadComplete: jest.fn(),
  uploadFailed: jest.fn(),
}));
jest.mock('../server/lib/core/biliup', () => ({ upload: jest.fn() }));
jest.mock('../server/lib/core/backup', () => ({ afterUpload: jest.fn() }));
jest.mock('../server/services/DataService', () => ({
  getSetting: jest.fn(),
}));

const UploadService = require('../server/services/UploadService');
const pool = require('../server/db/index');
const redis = require('../server/db/redis');
const transcodeQueue = require('../server/lib/core/TranscodeQueue');
const DataService = require('../server/services/DataService');

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('UploadService template variables', () => {
  test('getTemplateVars exposes padded and unpadded date variables', () => {
    const vars = UploadService.getTemplateVars(
      { room_name: 'KSG无言', room_url: 'https://live.example/1' },
      {
        started_at: new Date(2026, 0, 2, 3, 4, 5),
        caption: '直播标题',
        duration_seconds: 3670,
      }
    );

    expect(vars).toMatchObject({
      room_name: 'KSG无言',
      room_url: 'https://live.example/1',
      caption: '直播标题',
      date: '2026-01-02',
      datetime: '20260102_030405',
      YYYY: '2026',
      MM: '01',
      DD: '02',
      HH: '03',
      mm: '04',
      ss: '05',
      H: '3',
      M: '4',
      D: '2',
      duration_mins: '61',
    });
  });

  test('getTemplateVars calculates duration_mins from ended_at when duration_seconds is absent', () => {
    const vars = UploadService.getTemplateVars(
      { room_name: 'KSG无言' },
      {
        started_at: new Date(2026, 0, 2, 3, 0, 0),
        ended_at: new Date(2026, 0, 2, 4, 31, 0),
      }
    );

    expect(vars.duration_mins).toBe('91');
  });

  test('renderTemplate leaves unknown variables unchanged', () => {
    const rendered = UploadService.renderTemplate('{room_name}-{unknown}', {
      room_name: 'KSG无言',
    });

    expect(rendered).toBe('KSG无言-{unknown}');
  });

  test('scanPendingAutoUpload does not query duration_seconds from recording_sessions', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await UploadService.scanPendingAutoUpload();

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).not.toContain('rs.duration_seconds');
  });

  test('scanPendingAutoUpload selects rs.* so new session columns flow into template vars', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await UploadService.scanPendingAutoUpload();

    expect(pool.query.mock.calls[0][0]).toContain('SELECT rs.*');
  });

  test('scanPendingAutoUpload passes ended_at so duration_mins can be calculated', async () => {
    const startedAt = new Date(2026, 0, 2, 3, 0, 0);
    const endedAt = new Date(2026, 0, 2, 4, 30, 0);
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            room_url: 'https://live.example/1',
            room_name: 'KSG无言',
            started_at: startedAt,
            ended_at: endedAt,
            upload_template_id: 10,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            name: '模板',
            title_template: '{duration_mins}',
            cookies_path: '/tmp/cookies.json',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ deleted_at: null }] })
      .mockResolvedValueOnce({
        rows: [{ file_path: '/tmp/a.mp4', status: 'completed' }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 99 }] });
    redis.get.mockResolvedValue(null);
    redis.incr.mockResolvedValue(1);
    DataService.getSetting.mockResolvedValueOnce('true').mockResolvedValueOnce('10');
    transcodeQueue.hasSessionPending.mockResolvedValue(false);
    jest.spyOn(UploadService, '_runUpload').mockResolvedValue(undefined);
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
    jest.spyOn(require('fs'), 'statSync').mockReturnValue({
      isFile: () => true,
      size: 20 * 1024 * 1024,
    });

    await UploadService.scanPendingAutoUpload();

    const insertCall = pool.query.mock.calls.find((call) => call[0].includes('INSERT INTO upload_records'));
    expect(insertCall[1][3]).toBe('90');
  });

  test('scanPendingAutoUpload renders {caption} from recording_sessions into upload metadata', async () => {
    const startedAt = new Date(2026, 0, 2, 3, 0, 0);
    const endedAt = new Date(2026, 0, 2, 4, 30, 0);
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 51,
            room_url: 'https://live.example/1',
            room_name: 'KSG子旗',
            started_at: startedAt,
            ended_at: endedAt,
            caption: '解说狼队veTES',
            upload_template_id: 1,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            name: '崩铁子-private',
            title_template: '{room_name} 直播回放 {YYYY}-{MM}-{DD} {HH}:{mm}',
            desc_template: '{YYYY}-{MM}-{DD} {HH}:{mm}:{ss}\n{caption}\n-\n存档',
            cookies_path: '/tmp/cookies.json',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ deleted_at: null }] })
      .mockResolvedValueOnce({
        rows: [{ file_path: '/tmp/a.mp4', status: 'completed' }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 99 }] });
    redis.get.mockResolvedValue(null);
    redis.incr.mockResolvedValue(1);
    DataService.getSetting.mockResolvedValueOnce('true').mockResolvedValueOnce('10');
    transcodeQueue.hasSessionPending.mockResolvedValue(false);
    jest.spyOn(UploadService, '_runUpload').mockResolvedValue(undefined);
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
    jest.spyOn(require('fs'), 'statSync').mockReturnValue({
      isFile: () => true,
      size: 20 * 1024 * 1024,
    });

    await UploadService.scanPendingAutoUpload();

    const insertCall = pool.query.mock.calls.find((call) => call[0].includes('INSERT INTO upload_records'));
    expect(insertCall[1][3]).toBe('KSG子旗 直播回放 2026-01-02 03:00');

    const runUploadCall = UploadService._runUpload.mock.calls[0];
    expect(runUploadCall[5]).toBe('2026-01-02 03:00:00\n解说狼队veTES\n-\n存档');
  });
});
