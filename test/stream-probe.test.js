// 直播流画质探测：URL 白名单、ffprobe 输出解析、缓存
jest.mock('child_process', () => ({ spawn: jest.fn() }));

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { probeStream, isProbeableStreamUrl } = require('../server/lib/utils/stream-probe');

const LIVE_URL = 'https://live-source-play.xhscdn.com/live/570526135062847546_hcv530.flv?userId=69ad&abr_pts=-800';

/** 缓存按 pathname 收敛，测试用不同 pathname 隔离缓存。 */
function urlFor(name) {
  return `https://live-source-play.xhscdn.com/live/${name}.flv?userId=69ad`;
}

function newChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

function mockProbeOnce({ stdout = '', stderr = '', code = 0, error = null } = {}) {
  const child = newChild();

  spawn.mockImplementationOnce(() => {
    setImmediate(() => {
      if (error) {
        child.emit('error', error);
        return;
      }
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  });
  return child;
}

/** 不自动结束的探测，用于占住并发槽位并由用例手动收尾。 */
function mockProbePending() {
  const child = newChild();
  spawn.mockImplementationOnce(() => child);
  return child;
}

const VIDEO_JSON = JSON.stringify({
  streams: [{ codec_name: 'h264', width: 1280, height: 720 }],
});

function finishPending(child, { stdout = VIDEO_JSON, code = 0 } = {}) {
  if (stdout) child.stdout.emit('data', Buffer.from(stdout));
  child.emit('close', code);
}

describe('isProbeableStreamUrl', () => {
  test('只接受小红书直播 CDN 地址', () => {
    expect(isProbeableStreamUrl(LIVE_URL)).toBe(true);
    expect(isProbeableStreamUrl('https://live-play.xhscdn.net/live/1.flv')).toBe(true);
    expect(isProbeableStreamUrl('https://www.xiaohongshu.com/livestream/1')).toBe(false);
    expect(isProbeableStreamUrl('https://live-source-play.xhscdn.com.evil.com/live/1.flv')).toBe(false);
    expect(isProbeableStreamUrl('https://evil.com/live/1.flv')).toBe(false);
    expect(isProbeableStreamUrl('http://192.168.1.1/live/1.flv')).toBe(false);
    expect(isProbeableStreamUrl('file:///etc/passwd')).toBe(false);
    expect(isProbeableStreamUrl('')).toBe(false);
    expect(isProbeableStreamUrl(null)).toBe(false);
  });
});

describe('probeStream', () => {
  beforeEach(() => {
    spawn.mockReset();
  });

  test('解析 ffprobe 输出为分辨率/编码/码率', async () => {
    mockProbeOnce({
      stdout: JSON.stringify({
        streams: [
          {
            codec_name: 'hevc',
            width: 1920,
            height: 1080,
            bit_rate: '5940000',
            avg_frame_rate: '30/1',
          },
        ],
      }),
    });

    const result = await probeStream(urlFor('parse'));

    expect(result).toMatchObject({
      ok: true,
      width: 1920,
      height: 1080,
      codec: 'hevc',
      bit_rate: 5940000,
      fps: '30/1',
    });
    expect(spawn).toHaveBeenCalledWith(
      'ffprobe',
      expect.arrayContaining(['-rw_timeout', '5000000']),
      expect.any(Object)
    );
  });

  test('ffprobe 非 0 退出返回 probe_failed 并带 stderr 摘要', async () => {
    mockProbeOnce({ code: 1, stderr: 'Server returned 404 Not Found' });

    const result = await probeStream(urlFor('404'));

    expect(result.ok).toBe(false);
    expect(result.error).toBe('probe_failed');
    expect(result.message).toContain('404');
  });

  test('没有视频流时返回 no_video_stream', async () => {
    mockProbeOnce({ stdout: JSON.stringify({ streams: [] }) });

    const result = await probeStream(urlFor('novideo'));

    expect(result).toEqual({ ok: false, error: 'no_video_stream' });
  });

  test('同一路径（签名参数不同）命中缓存，不重复探测', async () => {
    mockProbeOnce({
      stdout: JSON.stringify({ streams: [{ codec_name: 'h264', width: 1280, height: 720 }] }),
    });

    const first = await probeStream(urlFor('cache'));
    const second = await probeStream(`${urlFor('cache')}&t=2`);

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('白名单外地址不触发 ffprobe', async () => {
    const result = await probeStream('https://example.com/live/1.flv');
    expect(result).toEqual({ ok: false, error: 'unsupported_url' });
    expect(spawn).not.toHaveBeenCalled();
  });

  test('失败结果在 TTL 内复用，且退出码非 0 时带 stderr 摘要', async () => {
    mockProbeOnce({ code: 1, stderr: 'Server returned 403 Forbidden' });

    const first = await probeStream(urlFor('failure-cache'));
    const second = await probeStream(urlFor('failure-cache'));

    expect(first.error).toBe('probe_failed');
    expect(first.message).toContain('403');
    expect(second).toEqual(first);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('并发达到上限时返回 busy，且不触发 ffprobe', async () => {
    const pending = Array.from({ length: 8 }, () => mockProbePending());
    const tasks = pending.map((_, i) => probeStream(urlFor(`concurrent-${i}`)));

    const busy = await probeStream(urlFor('over-limit'));
    expect(busy).toEqual({ ok: false, error: 'busy' });
    expect(spawn).toHaveBeenCalledTimes(8);

    pending.forEach(finishPending);
    await Promise.all(tasks);
  });

  test('busy 不写入缓存，槽位释放后立即重新探测', async () => {
    const pending = Array.from({ length: 8 }, () => mockProbePending());
    const tasks = pending.map((_, i) => probeStream(urlFor(`busy-retry-${i}`)));

    const busy = await probeStream(urlFor('busy-retry-same'));
    expect(busy.error).toBe('busy');

    pending.forEach(finishPending);
    await Promise.all(tasks);

    mockProbeOnce({ stdout: VIDEO_JSON });
    const retried = await probeStream(urlFor('busy-retry-same'));
    expect(retried.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(9);
  });

  test('timeout 属瞬时失败，不缓存且可立即重试', async () => {
    jest.useFakeTimers();
    try {
      const stalled = mockProbePending();
      const timedOut = probeStream(urlFor('timeout'));
      jest.advanceTimersByTime(6000);
      const first = await timedOut;

      expect(first).toEqual({ ok: false, error: 'timeout' });
      expect(stalled.kill).toHaveBeenCalledWith('SIGKILL');

      const retryChild = mockProbePending();
      const retriedTask = probeStream(urlFor('timeout'));
      finishPending(retryChild);
      const retried = await retriedTask;

      expect(retried.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
