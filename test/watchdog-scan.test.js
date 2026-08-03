// P1-1：看门狗主循环应记录「扫描开始 / 扫描完成（含耗时）」important 日志。
// 通过 mock logger 捕获 watchdog 模块日志器的 important 调用，避免运行真实内部任务。
jest.mock('../server/db/index', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../server/services/DataService', () => ({ getSetting: jest.fn().mockResolvedValue('30') }));
jest.mock('../server/services/UploadService', () => ({ scanPendingAutoUpload: jest.fn().mockResolvedValue() }));
jest.mock('../server/lib/core/downloaders/DownloaderFactory', () => ({ getActiveDownloader: jest.fn() }));
jest.mock('../server/lib/core/scan-files', () => ({ scanRecordingFiles: jest.fn().mockResolvedValue({}) }));
jest.mock('../server/lib/core/TranscodeQueue', () => ({ enqueue: jest.fn() }));
jest.mock('../server/lib/core/hls-generator', () => ({
  generateForRecording: jest.fn().mockResolvedValue({ success: true }),
}));
jest.mock('../server/lib/core/logger', () => ({
  createModuleLogger: jest.fn(() => ({
    info: jest.fn(),
    important: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

const { createModuleLogger } = require('../server/lib/core/logger');
const { runWatchdog, stop } = require('../server/lib/core/watchdog');

describe('watchdog scan boundary logs (P1-1)', () => {
  afterEach(() => {
    stop(); // 清除 setTimeout，避免打开句柄 / 测试挂起
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('logs scan start and completion (with duration) as important', async () => {
    await runWatchdog();

    expect(createModuleLogger).toHaveBeenCalledWith('watchdog');
    const logger = createModuleLogger.mock.results[0].value;
    const importantCalls = logger.important.mock.calls.map((c) => c[0]);

    expect(importantCalls.some((m) => m.includes('扫描开始'))).toBe(true);

    const completion = importantCalls.find((m) => m.includes('扫描完成'));
    expect(completion).toBeDefined();
    expect(completion).toMatch(/扫描完成.*耗时\s*\d+\s*ms/);
  });
});
