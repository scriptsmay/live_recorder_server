// RemoteBrowserClient 生命周期测试（TODO 12）
//
// 关注点：异常 / 超时 / 清理自身失败等路径下，page 与 context 都不能泄漏。
// v1.8.3 起该模块只服务回放 m3u8 提取，跑在 Browserless 上，连接是稀缺资源，
// 漏一个 context 就会把并发额度占死，所以这里逐条钉住 finally 的清理契约。
//
// 不 mock playwright-core：构造函数支持注入 browser / chromium，直接喂假对象即可。
const { RemoteBrowserClient } = require('../server/lib/core/browser/RemoteBrowserClient');

function makePage(overrides = {}) {
  return {
    route: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeContext(page, overrides = {}) {
  return {
    newPage: jest.fn().mockResolvedValue(page),
    addInitScript: jest.fn().mockResolvedValue(undefined),
    storageState: jest.fn().mockResolvedValue({ cookies: [{ name: 'did', value: 'x' }] }),
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeBrowser(context, overrides = {}) {
  return {
    isConnected: jest.fn().mockReturnValue(true),
    newContext: jest.fn().mockResolvedValue(context),
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// 一次性搭好 browser/context/page 三件套并返回注入好的 client
function setup(overrides = {}) {
  const page = makePage(overrides.page);
  const context = makeContext(page, overrides.context);
  const browser = makeBrowser(context, overrides.browser);
  const client = new RemoteBrowserClient({ endpoint: 'ws://browserless:3000', browser });
  return { client, browser, context, page };
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  console.log.mockRestore();
});

// ========== withPage：资源清理 ==========

describe('withPage 资源清理', () => {
  test('成功路径 — 返回任务结果，page 先关后关 context', async () => {
    const { client, context, page } = setup();
    const order = [];
    page.close.mockImplementation(async () => order.push('page'));
    context.close.mockImplementation(async () => order.push('context'));

    const result = await client.withPage(async (p, ctx) => {
      expect(p).toBe(page);
      expect(ctx).toBe(context);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(order).toEqual(['page', 'context']);
  });

  test('任务抛错 — 异常上抛且 page/context 仍被关闭', async () => {
    const { client, context, page } = setup();

    await expect(
      client.withPage(async () => {
        throw new Error('extract failed');
      })
    ).rejects.toThrow('extract failed');

    expect(page.close).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  test('任务超时 — 抛 REMOTE_BROWSER_PAGE_TIMEOUT 且不遗留 page/context', async () => {
    const { client, context, page } = setup();

    await expect(client.withPage(() => new Promise(() => {}), { timeoutMs: 20 })).rejects.toThrow(
      'REMOTE_BROWSER_PAGE_TIMEOUT:20'
    );

    expect(page.close).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  test('超时后任务才失败 — 不产生 unhandledRejection', async () => {
    const { client } = setup();
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    try {
      await expect(
        client.withPage(() => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 30)), {
          timeoutMs: 5,
        })
      ).rejects.toThrow('REMOTE_BROWSER_PAGE_TIMEOUT:5');

      // 等迟到的 rejection 落地
      await new Promise((r) => setTimeout(r, 60));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  test('newContext 失败 — 没有资源可清理，异常直接上抛', async () => {
    const context = makeContext(makePage());
    const browser = makeBrowser(context, {
      newContext: jest.fn().mockRejectedValue(new Error('browserless queue full')),
    });
    const client = new RemoteBrowserClient({ endpoint: 'ws://x', browser });

    await expect(client.withPage(async () => 'never')).rejects.toThrow('browserless queue full');
    expect(context.close).not.toHaveBeenCalled();
  });

  test('newPage 失败 — context 被关闭，不会误调用 page.close', async () => {
    const page = makePage();
    const context = makeContext(page, { newPage: jest.fn().mockRejectedValue(new Error('target closed')) });
    const browser = makeBrowser(context);
    const client = new RemoteBrowserClient({ endpoint: 'ws://x', browser });

    await expect(client.withPage(async () => 'never')).rejects.toThrow('target closed');
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(page.close).not.toHaveBeenCalled();
  });

  test('page.route 注册失败 — page 和 context 都被关闭', async () => {
    const { client, context, page } = setup({ page: { route: jest.fn().mockRejectedValue(new Error('route fail')) } });

    await expect(client.withPage(async () => 'never')).rejects.toThrow('route fail');
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  test('page.close 自身失败被吞 — context 仍被关闭且任务结果照常返回', async () => {
    const { client, context } = setup({ page: { close: jest.fn().mockRejectedValue(new Error('page close fail')) } });

    await expect(client.withPage(async () => 'ok')).resolves.toBe('ok');
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  test('context.close 自身失败被吞 — 不影响任务结果', async () => {
    const { client } = setup({ context: { close: jest.fn().mockRejectedValue(new Error('ctx close fail')) } });

    await expect(client.withPage(async () => 'ok')).resolves.toBe('ok');
  });
});

// ========== withPage：storageState 与选项 ==========

describe('withPage 选项透传', () => {
  test('saveStorageState 在 context.close 之前被调用并拿到 cookies', async () => {
    const { client, context } = setup();
    const order = [];
    context.close.mockImplementation(async () => order.push('close'));
    const saveStorageState = jest.fn(async () => order.push('save'));

    await client.withPage(async () => 'ok', { saveStorageState });

    expect(saveStorageState).toHaveBeenCalledWith({ cookies: [{ name: 'did', value: 'x' }] });
    expect(order).toEqual(['save', 'close']);
  });

  test('未传 saveStorageState 时不读取 storageState', async () => {
    const { client, context } = setup();
    await client.withPage(async () => 'ok');
    expect(context.storageState).not.toHaveBeenCalled();
  });

  test('storageState 读取失败被吞 — context 仍关闭，结果照常返回', async () => {
    const { client, context } = setup({
      context: { storageState: jest.fn().mockRejectedValue(new Error('state fail')) },
    });
    const saveStorageState = jest.fn();

    await expect(client.withPage(async () => 'ok', { saveStorageState })).resolves.toBe('ok');
    expect(saveStorageState).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  test('stealth 才注入反检测脚本', async () => {
    const plain = setup();
    await plain.client.withPage(async () => 'ok');
    expect(plain.context.addInitScript).not.toHaveBeenCalled();

    const stealth = setup();
    await stealth.client.withPage(async () => 'ok', { stealth: true });
    expect(stealth.context.addInitScript).toHaveBeenCalledWith(expect.stringContaining('webdriver'));
  });

  test('newContext 收到默认环境参数，storageState 可覆盖', async () => {
    const { client, browser } = setup();
    const storageState = { cookies: [{ name: 'sid' }] };

    await client.withPage(async () => 'ok', { storageState });

    expect(browser.newContext).toHaveBeenCalledWith({
      userAgent: expect.stringContaining('Chrome/121'),
      viewport: { width: 1365, height: 768 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      storageState,
    });
  });

  test('路由拦截 — 按 shouldBlockRequest 结果 abort / continue', async () => {
    const { client, page } = setup();
    await client.withPage(async () => 'ok');

    const handler = page.route.mock.calls[0][1];
    const abort = jest.fn();
    const cont = jest.fn();

    // image 属于被拦截资源类型
    handler({ request: () => ({ url: () => 'https://x/a.png', resourceType: () => 'image' }), abort, continue: cont });
    expect(abort).toHaveBeenCalled();

    // document 放行
    handler({
      request: () => ({ url: () => 'https://x/page', resourceType: () => 'document' }),
      abort,
      continue: cont,
    });
    expect(cont).toHaveBeenCalled();
  });
});

// ========== 连接管理 ==========

describe('getBrowser 连接管理', () => {
  test('未配置 endpoint 抛错', async () => {
    const client = new RemoteBrowserClient({ endpoint: '' });
    await expect(client.getBrowser()).rejects.toThrow('REMOTE_BROWSER_WS_ENDPOINT is not configured');
  });

  test('已连接则直接复用，不再 connectOverCDP', async () => {
    const connectOverCDP = jest.fn();
    const { client } = setup();
    client._chromium = { connectOverCDP };

    await client.getBrowser();
    expect(connectOverCDP).not.toHaveBeenCalled();
  });

  test('并发调用共享同一个连接 Promise', async () => {
    const browser = makeBrowser(makeContext(makePage()));
    const connectOverCDP = jest.fn().mockResolvedValue(browser);
    const client = new RemoteBrowserClient({
      endpoint: 'ws://x',
      chromium: { connectOverCDP },
    });

    const [a, b] = await Promise.all([client.getBrowser(), client.getBrowser()]);

    expect(connectOverCDP).toHaveBeenCalledTimes(1);
    expect(a).toBe(browser);
    expect(b).toBe(browser);
  });

  test('连接失败重置内部状态，下次仍可重试', async () => {
    const browser = makeBrowser(makeContext(makePage()));
    const connectOverCDP = jest.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(browser);
    const client = new RemoteBrowserClient({ endpoint: 'ws://x', chromium: { connectOverCDP } });

    await expect(client.getBrowser()).rejects.toThrow('ECONNREFUSED');
    expect(client.browser).toBeNull();
    expect(client._connectPromise).toBeNull();

    await expect(client.getBrowser()).resolves.toBe(browser);
    expect(connectOverCDP).toHaveBeenCalledTimes(2);
  });

  test('disconnected 事件清空缓存，下次重新连接', async () => {
    const listeners = {};
    const browser = makeBrowser(makeContext(makePage()), {
      on: jest.fn((event, cb) => {
        listeners[event] = cb;
      }),
    });
    const connectOverCDP = jest.fn().mockResolvedValue(browser);
    const client = new RemoteBrowserClient({ endpoint: 'ws://x', chromium: { connectOverCDP } });

    await client.getBrowser();
    expect(client.browser).toBe(browser);

    listeners.disconnected();
    expect(client.browser).toBeNull();

    await client.getBrowser();
    expect(connectOverCDP).toHaveBeenCalledTimes(2);
  });
});

describe('close', () => {
  test('关闭浏览器并重置状态', async () => {
    const { client, browser } = setup();
    await client.close();

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(client.browser).toBeNull();
    expect(client._connectPromise).toBeNull();
  });

  test('没有 browser 时不报错', async () => {
    const client = new RemoteBrowserClient({ endpoint: 'ws://x' });
    await expect(client.close()).resolves.toBeUndefined();
  });

  test('browser.close 失败被吞，状态照样重置', async () => {
    const { client } = setup({ browser: { close: jest.fn().mockRejectedValue(new Error('already closed')) } });

    await expect(client.close()).resolves.toBeUndefined();
    expect(client.browser).toBeNull();
  });
});
