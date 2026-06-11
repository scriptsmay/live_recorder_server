const KuaishouAPIChecker = require('../lib/core/polling/KuaishouAPIChecker');

function createRedisMock(options = {}) {
  const store = new Map(Object.entries(options.initial || {}));
  const locks = new Map();

  return {
    get: jest.fn(async (key) => store.get(key) || locks.get(key) || null),
    set: jest.fn(async (key, value, setOptions = {}) => {
      if (options.lockBusyKey && key === options.lockBusyKey) {
        return null;
      }

      if (setOptions.NX && locks.has(key)) {
        return null;
      }

      if (setOptions.NX) {
        locks.set(key, value);
      } else {
        store.set(key, value);
      }

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

function createJsonResponse(data, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status || 200,
    json: jest.fn().mockResolvedValue(data),
    text: jest.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

function createTextResponse(text, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status || 200,
    json: jest.fn().mockResolvedValue({}),
    text: jest.fn().mockResolvedValue(text),
  };
}

function createLiveDetailPayload(overrides = {}) {
  return {
    data: {
      result: 1,
      author: {
        living: true,
        userName: 'KPL王者荣耀职业联赛',
      },
      liveStream: {
        caption: 'KPL直播',
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
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.KUAISHOU_CHECKER_ENABLED = 'true';
    global.fetch = jest.fn();
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it('returns correct platform id and handles kuaishou URLs', () => {
    expect(KuaishouAPIChecker.getPlatformId()).toBe('kuaishou');
    expect(KuaishouAPIChecker.canHandleUrl('https://live.kuaishou.com/u/KPL704668133')).toBe(true);
    expect(KuaishouAPIChecker.canHandleUrl('https://www.kuaishou.com/profile/abc')).toBe(true);
    expect(KuaishouAPIChecker.canHandleUrl('https://www.huya.com/123')).toBe(false);
  });

  it('extracts principal id from live URLs', () => {
    expect(KuaishouAPIChecker.extractPrincipalId('https://live.kuaishou.com/u/KSGJuHao')).toBe('KSGJuHao');
    expect(KuaishouAPIChecker.extractPrincipalId('https://live.kuaishou.com/u/KPL704668133?foo=bar')).toBe(
      'KPL704668133'
    );
  });

  it('returns live status with best h264 FLV URL from livedetail API', async () => {
    global.fetch.mockResolvedValueOnce(createJsonResponse(createLiveDetailPayload()));
    const checker = new KuaishouAPIChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock(),
      now: () => 100000,
    });

    const result = await checker.checkStatus();

    expect(result.isLive).toBe(true);
    expect(result.roomName).toBe('KPL王者荣耀职业联赛');
    expect(result.streamUrl).toBe('https://example.com/high.flv?txSecret=abc');
    expect(result.streamInfo).toEqual({
      format: 'flv',
      codec: 'h264',
      bitrate: 2000,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('/live_api/liveroom/livedetail?principalId=KPL704668133');
  });

  it('returns offline status and fills missing room name from HTML title', async () => {
    const payload = createLiveDetailPayload({
      result: 2,
      author: { living: false },
      liveStream: {},
    });
    const redis = createRedisMock();
    global.fetch
      .mockResolvedValueOnce(createJsonResponse(payload))
      .mockResolvedValueOnce(createTextResponse('<title data-vm-ssr="true">KSG句号-快手直播</title>'));
    const checker = new KuaishouAPIChecker('https://live.kuaishou.com/u/KSGJuHao', {
      redis,
      now: () => 100000,
    });

    const result = await checker.checkStatus();

    expect(result.isLive).toBe(false);
    expect(result.roomName).toBe('KSG句号');
    expect(result.streamUrl).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][0]).toBe('https://live.kuaishou.com/u/KSGJuHao');
    expect(redis.setEx).toHaveBeenCalledWith('kuaishou:checker:room_name:KSGJuHao', 86400, 'KSG句号');
  });

  it('falls back to profile/public when livedetail request fails', async () => {
    global.fetch.mockResolvedValueOnce(createJsonResponse({}, { ok: false, status: 500 })).mockResolvedValueOnce(
      createJsonResponse({
        data: {
          result: 1,
          live: {
            living: true,
            author: { userName: 'KSG无言' },
            playUrls: [{ url: 'https://example.com/profile.flv?txSecret=abc', bitrate: 1200 }],
          },
        },
      })
    );
    const checker = new KuaishouAPIChecker('https://live.kuaishou.com/u/3xhpa8nk4a7xdg6', {
      redis: createRedisMock(),
      now: () => 100000,
    });

    const result = await checker.checkStatus();

    expect(result.isLive).toBe(true);
    expect(result.roomName).toBe('KSG无言');
    expect(result.streamUrl).toBe('https://example.com/profile.flv?txSecret=abc');
    expect(global.fetch.mock.calls[1][0]).toContain('/live_api/profile/public?principalId=3xhpa8nk4a7xdg6');
  });

  it('throws KUAISHOU_ANTICRAWL and sets backoff for captcha result', async () => {
    const redis = createRedisMock();
    global.fetch.mockResolvedValueOnce(
      createJsonResponse({
        data: {
          result: 400002,
          message: '验证码',
        },
      })
    );
    const checker = new KuaishouAPIChecker('https://live.kuaishou.com/u/KSGJuHao', {
      redis,
      now: () => 100000,
    });

    await expect(checker.checkStatus()).rejects.toThrow('KUAISHOU_ANTICRAWL');
    expect(redis.setEx).toHaveBeenCalledWith('kuaishou:checker:backoff:KSGJuHao', 120, '1');
    expect(redis.setEx).toHaveBeenCalledWith('kuaishou:checker:platform_backoff', 120, '1');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to hevc when h264 is missing', () => {
    const stream = KuaishouAPIChecker.pickBestStreamUrl({
      playUrls: {
        hevc: {
          adaptationSet: {
            representation: [
              { url: 'https://example.com/hevc-low.flv', bitrate: 500 },
              { url: 'https://example.com/hevc-high.flv', bitrate: 1500 },
            ],
          },
        },
      },
    });

    expect(stream).toEqual({
      url: 'https://example.com/hevc-high.flv',
      codec: 'hevc',
      bitrate: 1500,
    });
  });

  it('redacts signed FLV URL parameters', () => {
    expect(KuaishouAPIChecker.redactUrl('https://example.com/live.flv?txSecret=abc&token=def&cdn=tx')).toBe(
      'https://example.com/live.flv?txSecret=<redacted>&token=<redacted>&cdn=tx'
    );
  });

  it('does not fetch API when platform lock is busy', async () => {
    const checker = new KuaishouAPIChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock({ lockBusyKey: 'kuaishou:checker:platform_lock' }),
      now: () => 100000,
    });

    await expect(checker.checkStatus()).rejects.toThrow('KUAISHOU_PLATFORM_LOCK_BUSY');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not fetch API when platform interval is active', async () => {
    const checker = new KuaishouAPIChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock({
        initial: {
          'kuaishou:checker:platform_last_poll': '95000',
        },
      }),
      now: () => 100000,
    });

    await expect(checker.checkStatus()).rejects.toThrow('KUAISHOU_PLATFORM_RATE_LIMITED');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('uses cached room name instead of fetching HTML when API name is missing', async () => {
    global.fetch.mockResolvedValueOnce(
      createJsonResponse(
        createLiveDetailPayload({
          result: 2,
          author: { living: false },
          liveStream: {},
        })
      )
    );
    const checker = new KuaishouAPIChecker('https://live.kuaishou.com/u/KSGJuHao', {
      redis: createRedisMock({
        initial: {
          'kuaishou:checker:room_name:KSGJuHao': 'KSG句号',
        },
      }),
      now: () => 100000,
    });

    const result = await checker.checkStatus();

    expect(result.roomName).toBe('KSG句号');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('uses API mode timing constants and timeout env override', () => {
    process.env.KUAISHOU_API_TIMEOUT_MS = '9000';
    const checker = new KuaishouAPIChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock(),
    });

    expect(checker.getTimeoutMs()).toBe(9000);
    expect(checker.getRoomIntervalSeconds()).toBe(60);
    expect(checker.getGlobalIntervalSeconds()).toBe(10);
    expect(checker.getBackoffSeconds()).toBe(120);
    expect(checker.getSessionKey()).toBe('kuaishou:checker:session:deprecated');
  });
});
