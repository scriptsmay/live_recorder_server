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
});
