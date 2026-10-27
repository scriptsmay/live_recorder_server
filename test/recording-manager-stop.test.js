// 单例构造时会启动 5 分钟清理定时器，用假定时器避免打开句柄
jest.useFakeTimers();
jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/db/redis', () => ({ del: jest.fn(), setEx: jest.fn() }));
jest.mock('../server/services/DataService', () => ({ getSetting: jest.fn() }));
jest.mock('../server/lib/core/TranscodeQueue', () => ({ enqueue: jest.fn() }));
jest.mock('../server/lib/core/segmenter', () => ({ segmentAndTranscode: jest.fn() }));

const { EventEmitter } = require('events');
const RecordingManager = require('../server/lib/core/RecordingManager');

function makeProcess() {
  const proc = new EventEmitter();
  proc.pid = 1234;
  proc.killed = false;
  proc.exitCode = null;
  proc.kill = jest.fn((sig) => {
    proc.signals.push(sig);
    // 模拟停止后进程退出（close 由 RecorderService 监听，此处只触发 exit）
    if (sig === 'SIGTERM') {
      proc.emit('exit', null, sig);
    }
    return true;
  });
  proc.signals = [];
  return proc;
}

describe('RecordingManager.stopRecordingProcess — 人工停止标记', () => {
  afterEach(() => {
    jest.clearAllTimers();
    jest.restoreAllMocks();
  });

  test('发起停止时写入 _manualStopped = true', async () => {
    const proc = makeProcess();
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const stopped = RecordingManager.stopRecordingProcess(proc, 10000);
    expect(proc._manualStopped).toBe(true);

    await stopped;
    expect(proc.signals).toEqual(['SIGTERM']);
  });

  test('SIGTERM 超时后的兜底 SIGKILL 仍保留人工停止标记', async () => {
    const proc = makeProcess();
    // SIGTERM 不触发 exit，模拟 FFmpeg 无响应
    proc.kill.mockImplementation((sig) => {
      proc.signals.push(sig);
      return true;
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const stopped = RecordingManager.stopRecordingProcess(proc, 10000);
    await jest.advanceTimersByTimeAsync(10000);

    expect(proc.signals).toContain('SIGKILL');
    expect(proc._manualStopped).toBe(true);

    // 兜底 SIGKILL 后进程退出，Promise 收口
    proc.emit('exit', null, 'SIGKILL');
    await stopped;
    expect(proc._manualStopped).toBe(true);
  });

  test('进程已退出时不打标记、不发信号', async () => {
    const proc = makeProcess();
    proc.exitCode = 0;

    await RecordingManager.stopRecordingProcess(proc, 10000);

    expect(proc._manualStopped).toBeUndefined();
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
