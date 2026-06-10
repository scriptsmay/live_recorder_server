const KuaishouChecker = require('../lib/core/polling/KuaishouChecker');
const { RemoteBrowserClient } = require('../lib/core/browser/RemoteBrowserClient');

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

function createPageMock(snapshot) {
  return {
    goto: jest.fn().mockResolvedValue(undefined),
    waitForFunction: jest.fn().mockResolvedValue(undefined),
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
    evaluate: jest.fn().mockResolvedValue(snapshot),
  };
}

function createBrowserClientMock(snapshot, options = {}) {
  const page = createPageMock(snapshot);
  return {
    endpoint: 'ws://test',
    page,
    withPage: jest.fn(async (task, withPageOptions = {}) => {
      const result = await task(page);
      if (options.storageStateToSave && withPageOptions.saveStorageState) {
        await withPageOptions.saveStorageState(options.storageStateToSave);
      }
      return result;
    }),
  };
}

function createLiveSnapshot(overrides = {}) {
  return {
    title: 'KPL王者荣耀职业联赛-快手直播',
    bodyText: 'KPL王者荣耀职业联赛 在线观众',
    state: {
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
    },
  };
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
    const redis = createRedisMock();
    const browserClient = createBrowserClientMock(createLiveSnapshot());
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis,
      browserClient,
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
    const snapshot = createLiveSnapshot({
      isLiving: false,
      liveStream: {},
    });
    snapshot.title = 'KSG句号-快手直播';
    snapshot.bodyText = 'KSG句号 主播尚未开播，可以观看其他直播';
    snapshot.state.liveroom.playList[0].author = { userName: 'KSG句号' };
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KSGJuHao', {
      redis: createRedisMock(),
      browserClient: createBrowserClientMock(snapshot),
      now: () => 100000,
    });

    const result = await checker.checkStatus();

    expect(result.isLive).toBe(false);
    expect(result.roomName).toBe('KSG句号');
    expect(result.streamUrl).toBeNull();
  });

  it('throws KUAISHOU_ANTICRAWL for request-too-fast state', async () => {
    const snapshot = createLiveSnapshot({
      errorType: { title: '请求过快，请稍后重试' },
    });
    const redis = createRedisMock();
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KSGJuHao', {
      redis,
      browserClient: createBrowserClientMock(snapshot),
      now: () => 100000,
    });

    await expect(checker.checkStatus()).rejects.toThrow('KUAISHOU_ANTICRAWL');
    expect(redis.setEx).toHaveBeenCalledWith('kuaishou:checker:backoff:KSGJuHao', 180, '1');
    expect(redis.setEx).toHaveBeenCalledWith('kuaishou:checker:platform_backoff', 180, '1');
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

  it('parses kuaishou cookie header into playwright cookies', () => {
    expect(KuaishouChecker.parseCookieHeader('did=web_x; client_key=abc; Path=/; HttpOnly')).toEqual([
      {
        name: 'did',
        value: 'web_x',
        domain: '.kuaishou.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'Lax',
      },
      {
        name: 'client_key',
        value: 'abc',
        domain: '.kuaishou.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'Lax',
      },
    ]);
  });

  it('does not open browser when platform lock is busy', async () => {
    const browserClient = createBrowserClientMock(createLiveSnapshot());
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock({ lockBusyKey: 'kuaishou:checker:platform_lock' }),
      browserClient,
      now: () => 100000,
    });

    await expect(checker.checkStatus()).rejects.toThrow('KUAISHOU_PLATFORM_LOCK_BUSY');
    expect(browserClient.withPage).not.toHaveBeenCalled();
  });

  it('does not open browser when platform interval is active', async () => {
    const browserClient = createBrowserClientMock(createLiveSnapshot());
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock({
        initial: {
          'kuaishou:checker:platform_last_poll': '95000',
        },
      }),
      browserClient,
      now: () => 100000,
    });

    await expect(checker.checkStatus()).rejects.toThrow('KUAISHOU_PLATFORM_RATE_LIMITED');
    expect(browserClient.withPage).not.toHaveBeenCalled();
  });

  it('loads persisted kuaishou session cookies by default', async () => {
    const storedSession = {
      cookies: [{ name: 'did', value: 'web_x', domain: '.kuaishou.com', path: '/' }],
    };
    const browserClient = createBrowserClientMock(createLiveSnapshot());
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock({
        initial: {
          'kuaishou:checker:session:platform': JSON.stringify(storedSession),
        },
      }),
      browserClient,
      now: () => 100000,
    });

    await checker.checkStatus();

    expect(browserClient.withPage.mock.calls[0][1].storageState).toEqual(storedSession);
  });

  it('uses POLLING_KUAISHOU_COOKIE as initial session seed when redis has no session', async () => {
    process.env.POLLING_KUAISHOU_COOKIE = 'did=seed_did; client_key=seed_client';
    const browserClient = createBrowserClientMock(createLiveSnapshot());
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock(),
      browserClient,
      now: () => 100000,
    });

    await checker.checkStatus();

    expect(browserClient.withPage.mock.calls[0][1].storageState).toEqual({
      cookies: [
        expect.objectContaining({ name: 'did', value: 'seed_did', domain: '.kuaishou.com' }),
        expect.objectContaining({ name: 'client_key', value: 'seed_client', domain: '.kuaishou.com' }),
      ],
    });
  });

  it('prefers redis session over POLLING_KUAISHOU_COOKIE seed', async () => {
    process.env.POLLING_KUAISHOU_COOKIE = 'did=seed_did';
    const storedSession = {
      cookies: [{ name: 'did', value: 'redis_did', domain: '.kuaishou.com', path: '/' }],
    };
    const browserClient = createBrowserClientMock(createLiveSnapshot());
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock({
        initial: {
          'kuaishou:checker:session:platform': JSON.stringify(storedSession),
        },
      }),
      browserClient,
      now: () => 100000,
    });

    await checker.checkStatus();

    expect(browserClient.withPage.mock.calls[0][1].storageState).toEqual(storedSession);
  });

  it('saves only kuaishou cookies after a poll', async () => {
    const redis = createRedisMock();
    const browserClient = createBrowserClientMock(createLiveSnapshot(), {
      storageStateToSave: {
        cookies: [
          { name: 'did', value: 'web_x', domain: '.kuaishou.com', path: '/' },
          { name: 'third_party', value: '1', domain: '.example.com', path: '/' },
        ],
      },
    });
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis,
      browserClient,
      now: () => 100000,
    });

    await checker.checkStatus();

    expect(redis.setEx).toHaveBeenCalledWith(
      'kuaishou:checker:session:platform',
      604800,
      JSON.stringify({
        cookies: [{ name: 'did', value: 'web_x', domain: '.kuaishou.com', path: '/' }],
      })
    );
  });

  it('ignores corrupted persisted session JSON', async () => {
    const browserClient = createBrowserClientMock(createLiveSnapshot());
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock({
        initial: {
          'kuaishou:checker:session:platform': '{bad-json',
        },
      }),
      browserClient,
      now: () => 100000,
    });

    await checker.checkStatus();

    expect(browserClient.withPage.mock.calls[0][1].storageState).toBeUndefined();
  });

  it('simulates human behavior by default', async () => {
    const humanBehavior = {
      simulateHumanBehavior: jest.fn().mockResolvedValue(undefined),
    };
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock(),
      browserClient: createBrowserClientMock(createLiveSnapshot()),
      humanBehavior,
      now: () => 100000,
    });

    await checker.checkStatus();

    expect(humanBehavior.simulateHumanBehavior).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        minDelayMs: 1500,
        maxDelayMs: 4000,
        scrollCount: 2,
      })
    );
  });

  it('uses fixed internal behavior and session tuning constants', () => {
    const checker = new KuaishouChecker('https://live.kuaishou.com/u/KPL704668133', {
      redis: createRedisMock(),
      browserClient: createBrowserClientMock(createLiveSnapshot()),
    });

    expect(checker.getTimeoutMs()).toBe(45000);
    expect(checker.getWaitMs()).toBe(12000);
    expect(checker.getRoomIntervalSeconds()).toBe(60);
    expect(checker.getGlobalIntervalSeconds()).toBe(20);
    expect(checker.getBackoffSeconds()).toBe(180);
    expect(checker.getSessionTtlSeconds()).toBe(604800);
    expect(checker.getSessionKey()).toBe('kuaishou:checker:session:platform');
    expect(checker.getHumanBehaviorOptions()).toEqual({
      minDelayMs: 1500,
      maxDelayMs: 4000,
      scrollCount: 2,
    });
  });
});

describe('RemoteBrowserClient', () => {
  function createFakeBrowser() {
    const page = {
      route: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const context = {
      addInitScript: jest.fn().mockResolvedValue(undefined),
      newPage: jest.fn().mockResolvedValue(page),
      storageState: jest.fn().mockResolvedValue({
        cookies: [{ name: 'did', value: 'web_x', domain: '.kuaishou.com', path: '/' }],
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newContext: jest.fn().mockResolvedValue(context),
      close: jest.fn().mockResolvedValue(undefined),
      isConnected: jest.fn(() => true),
      on: jest.fn(),
    };

    return { browser, context, page };
  }

  it('closes page and context after successful task', async () => {
    const fake = createFakeBrowser();
    const client = new RemoteBrowserClient({ endpoint: 'ws://test' });
    client.getBrowser = jest.fn().mockResolvedValue(fake.browser);

    await expect(client.withPage(async () => 'ok')).resolves.toBe('ok');

    expect(fake.page.close).toHaveBeenCalledTimes(1);
    expect(fake.context.close).toHaveBeenCalledTimes(1);
  });

  it('closes page and context after task error', async () => {
    const fake = createFakeBrowser();
    const client = new RemoteBrowserClient({ endpoint: 'ws://test' });
    client.getBrowser = jest.fn().mockResolvedValue(fake.browser);

    await expect(
      client.withPage(async () => {
        throw new Error('task failed');
      })
    ).rejects.toThrow('task failed');

    expect(fake.page.close).toHaveBeenCalledTimes(1);
    expect(fake.context.close).toHaveBeenCalledTimes(1);
  });

  it('closes page and context after timeout', async () => {
    const fake = createFakeBrowser();
    const client = new RemoteBrowserClient({ endpoint: 'ws://test' });
    client.getBrowser = jest.fn().mockResolvedValue(fake.browser);

    await expect(client.withPage(() => new Promise(() => {}), { timeoutMs: 5 })).rejects.toThrow(
      'REMOTE_BROWSER_PAGE_TIMEOUT'
    );

    expect(fake.page.close).toHaveBeenCalledTimes(1);
    expect(fake.context.close).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh context for each withPage call', async () => {
    const fake = createFakeBrowser();
    const client = new RemoteBrowserClient({ endpoint: 'ws://test' });
    client.getBrowser = jest.fn().mockResolvedValue(fake.browser);

    await client.withPage(async () => 'first');
    await client.withPage(async () => 'second');

    expect(fake.browser.newContext).toHaveBeenCalledTimes(2);
  });

  it('loads and saves storage state around a page task', async () => {
    const fake = createFakeBrowser();
    const client = new RemoteBrowserClient({ endpoint: 'ws://test' });
    const storageState = {
      cookies: [{ name: 'did', value: 'web_x', domain: '.kuaishou.com', path: '/' }],
    };
    const saveStorageState = jest.fn().mockResolvedValue(undefined);
    client.getBrowser = jest.fn().mockResolvedValue(fake.browser);

    await client.withPage(async () => 'ok', {
      storageState,
      saveStorageState,
    });

    expect(fake.browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ storageState }));
    expect(saveStorageState).toHaveBeenCalledWith(storageState);
  });
});
