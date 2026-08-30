/**
 * DanmakuClientBase 生命周期回归测试（v1.10.0 代码审查补齐）
 *
 * 覆盖审查发现的两个竞态：
 * 1. 心跳超时路径必须关闭旧 socket（否则重连后新旧连接并存 → 事件重复入盘，
 *    且旧 socket 的 close 事件会误杀新连接）
 * 2. destroy() 与建连竞态：getConnectionInfo 的 IO 等待期间销毁，不得再建立连接
 */
const EventEmitter = require('events');
const { DanmakuClientBase } = require('../server/lib/core/danmaku/client/DanmakuClientBase');
const { DouyuDanmakuClient } = require('../server/lib/core/danmaku/client/platforms/douyu');

const noopLogger = { info: () => {}, important: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** ws / net.Socket 的最小假实现 */
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closed = false;
    this.destroyed = false;
    this.readyState = 1; // OPEN
  }
  send(data) {
    this.sent.push(data);
  }
  write(data) {
    this.sent.push(data);
    return true;
  }
  close() {
    this.closed = true;
  }
  destroy() {
    this.destroyed = true;
    this.closed = true;
  }
}

function makeClient() {
  const client = new DanmakuClientBase({ platform: 'test', roomUrl: 'https://example.com/1', logger: noopLogger });
  return client;
}

describe('DanmakuClientBase: 心跳超时关闭旧 socket', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('心跳超时 → _onConnectionLost 关闭旧 socket 并调度重连', () => {
    jest.useFakeTimers();
    const client = makeClient();
    const oldSocket = new FakeSocket();
    client.socket = oldSocket;
    client.connected = true;
    client.lastAckAt = Date.now() - 10 * 60 * 1000; // 远超 ack 窗口

    client._startHeartbeat({ data: Buffer.from([0x01]), intervalMs: 1000, ackTimeoutMs: 5000 });
    jest.advanceTimersByTime(1000);

    expect(client.connected).toBe(false);
    expect(client.socket).toBeNull(); // 旧 socket 已关闭并摘除
    expect(oldSocket.closed).toBe(true);
    expect(client.reconnectTimer).not.toBeNull(); // 已调度重连
    client.destroy(); // 清理挂起的重连定时器
  });

  test('旧 socket 残余消息不再进入 decode（防重复入盘）', () => {
    const client = makeClient();
    const oldSocket = new FakeSocket();
    oldSocket.on('message', () => {}); // ws 风格监听器
    client.socket = oldSocket;
    client.connected = true;
    client.decode = jest.fn(() => []);

    client._onConnectionLost('heartbeat timeout');

    expect(oldSocket.listenerCount('message')).toBe(0);
    oldSocket.emit('message', Buffer.from('stale'));
    oldSocket.emit('data', Buffer.from('stale'));
    expect(client.decode).not.toHaveBeenCalled();
    client.destroy();
  });

  test('未连接状态下的连接丢失事件被忽略（重连流程防重入）', () => {
    const client = makeClient();
    client.connected = false;
    const spy = jest.spyOn(client, '_scheduleReconnect').mockImplementation(() => {});
    client._onConnectionLost('ws close');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('DanmakuClientBase: destroy 与建连竞态', () => {
  test('getConnectionInfo 等待期间 destroy → 不再建立连接', async () => {
    const client = makeClient();
    let resolveInfo;
    client.getConnectionInfo = jest.fn(
      () => new Promise((resolve) => {
        resolveInfo = resolve;
      })
    );
    client._connectWs = jest.fn(() => Promise.resolve(new FakeSocket()));

    client.start();
    client.destroy(); // IO 等待期间销毁
    resolveInfo({
      transport: 'ws',
      endpoints: ['ws://mock/'],
      registration: [],
      heartbeat: { data: Buffer.from([0x01]), intervalMs: 1000, ackTimeoutMs: null },
    });
    await new Promise((r) => setImmediate(r));

    expect(client._connectWs).not.toHaveBeenCalled();
    expect(client.socket).toBeNull();
  });

  test('端点建连完成后发现已 destroy → 立即关闭新 socket，不注册不发心跳', async () => {
    const client = makeClient();
    const freshSocket = new FakeSocket();
    client.getConnectionInfo = async () => ({
      transport: 'ws',
      endpoints: ['ws://mock/'],
      registration: [Buffer.from([0x01])],
      heartbeat: { data: Buffer.from([0x01]), intervalMs: 1000, ackTimeoutMs: null },
    });
    client._connectWs = jest.fn(() => Promise.resolve(freshSocket));

    client.start();
    client.destroy();
    await new Promise((r) => setImmediate(r));
    // destroy 早于 getConnectionInfo 完成 → 走上一条用例；这里直接验证已销毁实例
    expect(client.destroyed).toBe(true);
    expect(freshSocket.sent).toHaveLength(0);

    // 再验证「建连完成瞬间才 destroy」的窗口：手动驱动 _connectAttempt
    const client2 = makeClient();
    const socket2 = new FakeSocket();
    client2.getConnectionInfo = async () => ({
      transport: 'ws',
      endpoints: ['ws://mock/'],
      registration: [Buffer.from([0x01])],
      heartbeat: { data: Buffer.from([0x01]), intervalMs: 1000, ackTimeoutMs: null },
    });
    client2._connectWs = jest.fn(() => {
      client2.destroyed = true; // 建连成功的瞬间被销毁
      return Promise.resolve(socket2);
    });
    await client2._connectAttempt();
    expect(client2.socket).toBeNull();
    expect(socket2.closed).toBe(true);
    expect(socket2.sent).toHaveLength(0); // 未发注册包
    expect(client2.heartbeatTimer).toBeNull(); // 未启心跳
  });
});

describe('DanmakuClientBase: 默认 logger 兜底', () => {
  test('缺省 logger 时 important/debug 不抛错', () => {
    const client = new DanmakuClientBase({ platform: 'test', roomUrl: 'https://example.com/1' });
    expect(() => {
      client.log.important('hello');
      client.log.debug('hidden');
      client.log.warn('warn');
      client.destroy('done');
    }).not.toThrow();
  });
});

describe('DouyuDanmakuClient: 重连清空 TCP 攒缓冲', () => {
  test('_onConnected 重置 _tcpBuf，旧连接半帧不污染新连接', () => {
    const client = new DouyuDanmakuClient({ roomUrl: 'https://www.douyu.com/123', logger: noopLogger });
    // 喂入一段不完整帧（声称长度 100，实际只有几个字节）
    const partial = Buffer.alloc(8);
    partial.writeUInt32LE(100, 0);
    partial.writeUInt32LE(100, 4);
    client.decode(partial);
    expect(client._tcpBuf.length).toBeGreaterThan(0);

    client._onConnected();
    expect(client._tcpBuf.length).toBe(0);
    client.destroy();
  });
});
