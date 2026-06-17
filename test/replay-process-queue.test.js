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
  replayQueue.activeTasks.clear();
});

describe('ReplayProcessQueue', () => {
  test('init 读取并发配置并重置 processing counter', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ value: '3' }] });
    redis.del.mockResolvedValue(1);

    await replayQueue.init();

    expect(replayQueue.concurrency).toBe(3);
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
      error_message: '',
    });
  });

  test('runAction download 步骤成功后更新状态', async () => {
    const record = { id: 10, principal_id: 'abc', m3u8_url: 'https://example.com/a.m3u8' };
    videoProcessor.download.mockResolvedValue({ success: true, rawFilePath: '/tmp/a.mp4', fileSize: 2048 });
    ReplayService.updateRecordStatus.mockResolvedValue({
      ...record,
      status: 'downloaded',
      raw_file_path: '/tmp/a.mp4',
    });

    await replayQueue.runAction(record, 'download');

    expect(ReplayService.updateRecordStatus).toHaveBeenCalledWith(10, 'downloaded', {
      raw_file_path: '/tmp/a.mp4',
      file_size: 2048,
      error_message: '',
    });
  });

  test('runAction 步骤失败时抛出错误', async () => {
    const record = { id: 10, principal_id: 'abc' };
    videoProcessor.extract.mockResolvedValue({ success: false, error: 'm3u8 提取失败' });

    await expect(replayQueue.runAction(record, 'extract')).rejects.toThrow('m3u8 提取失败');
  });

  test('runAction unknown action 抛出错误', async () => {
    const record = { id: 10, principal_id: 'abc' };

    await expect(replayQueue.runAction(record, 'unknown_action')).rejects.toThrow('未知回放动作');
  });

  test('runAction backup 步骤已移除，抛出未知动作错误', async () => {
    const record = { id: 10, principal_id: 'abc' };

    // backup 已移除，应抛出未知动作错误
    await expect(replayQueue.runAction(record, 'backup')).rejects.toThrow('未知回放动作');
  });

  test('runAction all 执行完整 pipeline', async () => {
    const record = { id: 10, principal_id: 'abc', cut_file_paths: '["/tmp/a.mkv"]' };
    videoProcessor.extract.mockResolvedValue({ success: true, m3u8Url: 'https://example.com/a.m3u8' });
    videoProcessor.download.mockResolvedValue({ success: true, rawFilePath: '/tmp/a.mp4', fileSize: 1024 });
    videoProcessor.cut.mockResolvedValue({ success: true, cutFilePaths: ['/tmp/a_part.mkv'] });
    videoProcessor.fix.mockResolvedValue({
      success: true,
      fixedFilePaths: ['/tmp/a_fixed.mp4'],
      finalFilePaths: ['/tmp/a_fixed.mp4'],
    });

    const ReplayUploadService = require('../lib/core/replay/ReplayUploadService');
    ReplayUploadService.executeUpload.mockResolvedValue({ success: true });

    ReplayService.updateRecordStatus.mockImplementation((id, status, fields) => {
      return Promise.resolve({ id, status, ...fields, cut_file_paths: JSON.stringify(['/tmp/a_part.mkv']) });
    });

    await replayQueue.runAction(record, 'all');

    expect(videoProcessor.extract).toHaveBeenCalled();
    expect(videoProcessor.download).toHaveBeenCalled();
    expect(videoProcessor.cut).toHaveBeenCalled();
    expect(videoProcessor.fix).toHaveBeenCalled();
    expect(ReplayUploadService.executeUpload).toHaveBeenCalled();
  });

  test('enqueue 缺少 replayRecordId 时抛出错误', async () => {
    await expect(replayQueue.enqueue({})).rejects.toThrow('缺少 replayRecordId');
    await expect(replayQueue.enqueue(null)).rejects.toThrow('缺少 replayRecordId');
  });

  test('getStatus 返回队列状态', async () => {
    redis.lLen.mockResolvedValue(3);
    redis.get.mockResolvedValue('1');
    replayQueue.activeTasks.set(10, {
      recordId: 10,
      principalId: 'abc',
      action: 'download',
      step: 'download',
      pid: 1234,
      command: 'yt-dlp url',
      startedAt: '2026-06-18T00:00:00.000Z',
    });

    const status = await replayQueue.getStatus();

    expect(status.queue_length).toBe(3);
    expect(status.processing).toBe(1);
    expect(status.concurrency).toBe(1);
    expect(status.active).toEqual([
      {
        record_id: 10,
        principal_id: 'abc',
        action: 'download',
        step: 'download',
        pid: 1234,
        command: 'yt-dlp url',
        started_at: '2026-06-18T00:00:00.000Z',
      },
    ]);
  });

  test('cancelRecord 终止运行中的子进程并更新状态', async () => {
    jest.useFakeTimers();
    const proc = {
      pid: 4321,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: jest.fn(),
    };
    replayQueue.activeTasks.set(10, {
      recordId: 10,
      principalId: 'abc',
      action: 'all',
      step: 'download',
      proc,
      pid: 4321,
      command: 'yt-dlp url',
      startedAt: '2026-06-18T00:00:00.000Z',
      runtime: { cancelled: false },
      logStream: { write: jest.fn() },
    });
    ReplayService.updateRecordStatus.mockResolvedValue({ id: 10, status: 'cancelled' });

    const result = await replayQueue.cancelRecord(10);

    expect(result.cancelled).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    jest.advanceTimersByTime(5000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    expect(ReplayService.updateRecordStatus).toHaveBeenCalledWith(10, 'cancelled', {
      error_message: '用户取消任务',
    });
    expect(replayQueue.activeTasks.get(10).runtime.cancelled).toBe(true);
    jest.useRealTimers();
  });

  test('cancelRecord 非运行任务返回未取消', async () => {
    const result = await replayQueue.cancelRecord(999);

    expect(result.cancelled).toBe(false);
    expect(result.message).toBe('回放任务未在运行中');
  });
});
