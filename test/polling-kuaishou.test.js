const KuaishouChecker = require('../server/lib/core/polling/KuaishouAPIChecker');

function createRedisMock(options = {}) {
  const store = new Map(Object.entries(options.initial || {}));
  const locks = new Map();

  return {
    get: jest.fn(async (key) => store.get(key) || locks.get(key) || null),
    set: jest.fn(async (key, value, setOptions = {}) => {
      if (options.lockBusyKey && key === options.lockBusyKey) return null;
      if (setOptions.NX && locks.has(key)) return null;
      if (setOptions.NX) locks.set(key, value);
      else store.set(key, value);
      return 'OK';
    }),
    setEx: jest.fn(async (key, _seconds, value) => {
      store.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key) => {
      store.delete(key);
      locks.delete(key);
      return 1;
    }),
  };
}

function createLivedetailPayload(overrides = {}) {
  return {
    data: {
      result: 1,
      author: { userName: 'KPL王者荣耀职业联赛', living: true },
      caption: 'KPL直播',
      liveStream: {
        playUrls: {
          h264: {
            adaptationSet: {
              representation: [
                { url: 'https://example.com/low.flv?txSecret=abc', bitrate: 800 },
                { url: 'https://example.com/high.flv?txSecret=abc', bitrate: 2000 },
              ],
            },
          },
        },
      },
      ...overrides,
    },
  };
}

describe('KuaishouAPIChecker', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.KUAISHOU_CHECKER_ENABLED = 'true';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns correct platform id and handles kuaishou URLs', () => {
    expect(KuaishouChecker.getPlatformId()).toBe('kuaishou');
    expect(KuaishouChecker.canHandleUrl('https://live.kuaishou.com/u/KPL704668133')).toBe(true);
    expect(KuaishouChecker.canHandleUrl('https://www.kuaishou.com/profile/abc')).toBe(true);
    expect(KuaishouChecker.canHandleUrl('https://www.huya.com/123')).toBe(false);
  });

  it('extracts principal id from live URLs', () => {
    expect(KuaishouChecker.extractPrincipalId('https://live.kuaishou.com/u/KSGJuHao')).toBe('KSGJuHao');
    expect(KuaishouChecker.extractPrincipalId('https://live.kuaishou.com/u/KPL704668133?foo=bar')).toBe('KPL704668133');
  });

  it('extracts live status with best h264 FLV URL from livedetail', () => {
    const result = KuaishouChecker.extractStatusFromLivedetail(createLivedetailPayload());

    expect(result.isLive).toBe(true);
    expect(result.roomName).toBe('KPL王者荣耀职业联赛');
    expect(result.streamUrl).toBe('https://example.com/high.flv?txSecret=abc');
    expect(result.streamInfo).toEqual({
      format: 'flv',
      codec: 'h264',
      bitrate: 2000,
    });
  });

  it('extracts offline status when room is not living', () => {
    const payload = {
      data: {
        result: 2,
        author: { name: 'KSG句号', living: false },
        liveStream: {},
      },
    };

    const result = KuaishouChecker.extractStatusFromLivedetail(payload);

    expect(result.isLive).toBe(false);
    expect(result.roomName).toBe('KSG句号');
    expect(result.streamUrl).toBeNull();
  });

  it('throws KUAISHOU_ANTICRAWL for request-too-fast payload', () => {
    const payload = { data: { errorType: { title: '请求过快，请稍后重试' } } };
    expect(() => KuaishouChecker.extractStatusFromLivedetail(payload)).toThrow('KUAISHOU_ANTICRAWL');
  });

  it('throws KUAISHOU_ANTICRAWL for result code 400002', () => {
    const payload = { data: { result: 400002 } };
    expect(() => KuaishouChecker.extractStatusFromLivedetail(payload)).toThrow('KUAISHOU_ANTICRAWL');
  });

  it('falls back to h265 when h264 is missing', () => {
    const stream = KuaishouChecker.pickBestStreamUrl({
      playUrls: {
        h265: {
          adaptationSet: {
            representation: [
              { url: 'https://example.com/h265-low.flv', bitrate: 500 },
              { url: 'https://example.com/h265-high.flv', bitrate: 1500 },
            ],
          },
        },
      },
    });

    expect(stream).toEqual({
      url: 'https://example.com/h265-high.flv',
      codec: 'h265',
      bitrate: 1500,
    });
  });

  it('redacts signed FLV URL parameters', () => {
    expect(KuaishouChecker.redactUrl('https://example.com/live.flv?txSecret=abc&token=def&cdn=tx')).toBe(
      'https://example.com/live.flv?txSecret=<redacted>&token=<redacted>&cdn=tx'
    );
  });

  it('extracts room name from HTML title', () => {
    const html = '<html><head><title>KSG句号-快手直播</title></head></html>';
    expect(KuaishouChecker.extractRoomNameFromHtml(html)).toBe('KSG句号');
  });

  it('throws KUAISHOU_CHECKER_DISABLED when disabled', async () => {
    process.env.KUAISHOU_CHECKER_ENABLED = 'false';
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock(),
    });

    await expect(checker.checkStatus()).rejects.toThrow('KUAISHOU_CHECKER_DISABLED');
  });

  it('does not proceed when platform lock is busy', async () => {
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock({ lockBusyKey: 'kuaishou:checker:lock:KPL704668133' }),
      now: () => 100000,
    });

    await expect(checker.checkStatus()).rejects.toThrow('KUAISHOU_ROOM_LOCK_BUSY');
  });
});
