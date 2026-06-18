const KuaishouChecker = require('../server/lib/core/polling/KuaishouChecker');

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

function buildPageHtml(state, title = 'KPL王者荣耀职业联赛-快手直播') {
  const stateJson = JSON.stringify(state).replace(/null/g, 'undefined');
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body><script>window.__INITIAL_STATE__=${stateJson};</script></body></html>`;
}

function createLiveState(overrides = {}) {
  return {
    liveroom: {
      activeIndex: 0,
      playList: [
        {
          isLiving: true,
          caption: 'KPL直播',
          author: { userName: 'KPL王者荣耀职业联赛' },
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
      ],
    },
  };
}

function createFetchPageMock(html) {
  return jest.fn().mockResolvedValue({ html, statusCode: 200 });
}

describe('KuaishouChecker', () => {
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

  it('returns live status with best h264 FLV URL', async () => {
    const html = buildPageHtml(createLiveState());
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock(),
      fetchPage: createFetchPageMock(html),
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
  });

  it('returns offline status when room is not living', async () => {
    const state = {
      liveroom: {
        activeIndex: 0,
        playList: [
          {
            isLiving: false,
            liveStream: {},
            author: { name: 'KSG句号' },
          },
        ],
      },
    };
    const html = buildPageHtml(state, 'KSG句号-快手直播');
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KSGJuHao', {
      redis: createRedisMock(),
      fetchPage: createFetchPageMock(html),
      now: () => 100000,
    });

    const result = await checker.checkStatus();

    expect(result.isLive).toBe(false);
    expect(result.roomName).toBe('KSG句号');
    expect(result.streamUrl).toBeNull();
  });

  it('throws KUAISHOU_ANTICRAWL for request-too-fast state', async () => {
    const state = createLiveState({ errorType: { title: '请求过快，请稍后重试' } });
    const html = buildPageHtml(state);
    const redis = createRedisMock();
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KSGJuHao', {
      redis,
      fetchPage: createFetchPageMock(html),
      now: () => 100000,
    });

    await expect(checker.checkStatus()).rejects.toThrow('KUAISHOU_ANTICRAWL');
    expect(redis.setEx).toHaveBeenCalledWith('kuaishou:checker:backoff:KSGJuHao', 120, '1');
    expect(redis.setEx).toHaveBeenCalledWith('kuaishou:checker:platform_backoff', 120, '1');
  });

  it('throws KUAISHOU_ANTICRAWL for page-level anti-crawl', async () => {
    const html = '<html><body>请求过快，请稍后重试</body></html>';
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KSGJuHao', {
      redis: createRedisMock(),
      fetchPage: createFetchPageMock(html),
      now: () => 100000,
    });

    await expect(checker.checkStatus()).rejects.toThrow('KUAISHOU_ANTICRAWL');
  });

  it('throws when __INITIAL_STATE__ is missing', async () => {
    const html = '<html><body>No state here</body></html>';
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KSGJuHao', {
      redis: createRedisMock(),
      fetchPage: createFetchPageMock(html),
      now: () => 100000,
    });

    await expect(checker.checkStatus()).rejects.toThrow('KUAISHOU_NO_LIVEROOM_STATE');
  });

  it('throws when state JSON is unparseable', async () => {
    const html = '<html><script>window.__INITIAL_STATE__={bad-json};</script></html>';
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KSGJuHao', {
      redis: createRedisMock(),
      fetchPage: createFetchPageMock(html),
      now: () => 100000,
    });

    await expect(checker.checkStatus()).rejects.toThrow('KUAISHOU_STATE_PARSE_ERROR');
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

  it('parses kuaishou cookie header', () => {
    expect(KuaishouChecker.parseCookieHeader('did=web_x; client_key=abc; Path=/; HttpOnly')).toEqual([
      { name: 'did', value: 'web_x' },
      { name: 'client_key', value: 'abc' },
    ]);
  });

  it('does not fetch when platform lock is busy', async () => {
    const fetchPage = createFetchPageMock(buildPageHtml(createLiveState()));
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock({ lockBusyKey: 'kuaishou:checker:platform_lock' }),
      fetchPage,
      now: () => 100000,
    });

    await expect(checker.checkStatus()).rejects.toThrow('KUAISHOU_PLATFORM_LOCK_BUSY');
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('does not fetch when platform interval is active', async () => {
    const fetchPage = createFetchPageMock(buildPageHtml(createLiveState()));
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock({
        initial: { 'kuaishou:checker:platform_last_poll': '95000' },
      }),
      fetchPage,
      now: () => 100000,
    });

    await expect(checker.checkStatus()).rejects.toThrow('KUAISHOU_PLATFORM_RATE_LIMITED');
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('uses fixed internal constants', () => {
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock(),
      fetchPage: createFetchPageMock(''),
    });

    expect(checker.getTimeoutMs()).toBe(15000);
    expect(checker.getRoomIntervalSeconds()).toBe(60);
    expect(checker.getGlobalIntervalSeconds()).toBe(20);
    expect(checker.getBackoffSeconds()).toBe(120);
    expect(checker.getSessionTtlSeconds()).toBe(604800);
    expect(checker.getSessionKey()).toBe('kuaishou:checker:session:platform');
  });
});
