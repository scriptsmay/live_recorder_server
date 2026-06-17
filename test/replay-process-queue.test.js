jest.mock('../db/redis', () => ({
  lPush: jest.fn(),
  rPop: jest.fn(),
  lLen: jest.fn(),
  lRange: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  incr: jest.fn(),
  decr: jest.fn(),
}));

jest.mock('../db/index', () => ({
  query: jest.fn(),
}));

jest.mock('../services/ReplayService', () => ({
  getRecord: jest.fn(),
  updateRecordStatus: jest.fn(),
  listRecords: jest.fn(),
}));

jest.mock('../lib/core/replay/video-processor', () => ({
  extract: jest.fn(),
  download: jest.fn(),
  cut: jest.fn(),
  fix: jest.fn(),
}));

jest.mock('../lib/core/replay/ReplayUploadService', () => ({
  executeUpload: jest.fn(),
}));

const redis = require('../db/redis');
const pool = require('../db/index');
const ReplayService = require('../services/ReplayService');
const videoProcessor = require('../lib/core/replay/video-processor');
const replayQueue = require('../lib/core/ReplayProcessQueue');

beforeEach(() => {
  jest.clearAllMocks();
  replayQueue.isRunning = false;
  replayQueue.concurrency = 1;
});

describe('ReplayProcessQueue', () => {
  test('init 读取并发配置并重置 processing counter', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ value: '3' }] });
    redis.del.mockResolvedValue(1);

    await replayQueue.init();

    expect(replayQueue.concurrency).toBe(1);
    expect(redis.del).toHaveBeenCalledWith('replay_process_processing_count');
  });

  test('enqueue 写入 Redis 队列', async () => {
    redis.lPush.mockResolvedValue(1);
    redis.get.mockResolvedValue('1');

    await replayQueue.enqueue({ replayRecordId: 10, action: 'extract' });

    expect(redis.lPush).toHaveBeenCalledWith(
      'replay_process_queue',
      JSON.stringify({ replayRecordId: 10, action: 'extract' })
    );
  });

  test('processTask 获取不到记录时直接返回', async () => {
    ReplayService.getRecord.mockResolvedValue(null);

    await replayQueue.processTask({ replayRecordId: 10, action: 'extract' });

    expect(redis.set).not.toHaveBeenCalled();
  });

  test('processTask 记录锁存在时跳过处理', async () => {
    ReplayService.getRecord.mockResolvedValue({ id: 10, principal_id: 'abc' });
    redis.set.mockResolvedValueOnce(null);

    await replayQueue.processTask({ replayRecordId: 10, action: 'extract' });

    expect(videoProcessor.extract).not.toHaveBeenCalled();
  });

  test('runAction extract 成功后更新状态', async () => {
    const record = { id: 10, principal_id: 'abc', m3u8_url: 'https://example.com/a.m3u8' };
    videoProcessor.extract.mockResolvedValue({ success: true, m3u8Url: record.m3u8_url });
    ReplayService.updateRecordStatus.mockResolvedValue({ ...record, status: 'extracted' });

    await replayQueue.runAction(record, 'extract');

    expect(ReplayService.updateRecordStatus).toHaveBeenCalledWith(10, 'extracted', {
      m3u8_url: record.m3u8_url,
    });
  });
});
