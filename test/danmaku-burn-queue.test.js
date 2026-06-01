const fs = require('fs');
const path = require('path');

// Mocks must be set up BEFORE requiring the module under test
jest.mock('../db/redis', () => ({
  lPush: jest.fn(),
  rPop: jest.fn(),
  lLen: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  setEx: jest.fn(),
  del: jest.fn(),
  incr: jest.fn(),
  decr: jest.fn(),
  exists: jest.fn(),
  keys: jest.fn(),
  expire: jest.fn(),
  ping: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(),
  lRange: jest.fn(),
}));

jest.mock('../db/index', () => ({
  query: jest.fn(),
}));

jest.mock('../lib/core/danmaku-burner', () => ({
  burn: jest.fn(),
  estimateTimeout: jest.fn(),
  getVideoDurationMs: jest.fn(),
  probeCapabilities: jest.fn(),
}));

const redis = require('../db/redis');
const pool = require('../db/index');
const burner = require('../lib/core/danmaku-burner');

// Now load the module under test
const danmakuBurnQueue = require('../lib/core/DanmakuBurnQueue');

// ============================================================
// 辅助函数
// ============================================================

const TMP_DIR = path.join(__dirname, 'tmp_burn_queue_test');

function ensureTmp() {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
}

function tmpPath(name) {
  return path.join(TMP_DIR, name);
}

function createDummyFile(filepath, content) {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filepath, content || 'dummy video content', 'utf-8');
}

beforeEach(() => {
  jest.clearAllMocks();
  ensureTmp();
});

// ============================================================
// 测试组 1: init() — 初始化
// ============================================================

describe('DanmakuBurnQueue — init()', () => {
  test('从数据库读取并发配置', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ value: '1' }],
    });
    redis.del.mockResolvedValue('OK');

    await danmakuBurnQueue.init();

    expect(pool.query).toHaveBeenCalledWith("SELECT value FROM settings WHERE key = 'danmaku_burn_concurrency'");
    expect(danmakuBurnQueue.concurrency).toBe(1);
    expect(redis.del).toHaveBeenCalledWith('danmaku_burn_processing_count');
  });

  test('并发强制最大为 1', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ value: '5' }], // Would set 5, but capped at 1
    });
    redis.del.mockResolvedValue('OK');

    await danmakuBurnQueue.init();
    expect(danmakuBurnQueue.concurrency).toBe(1);
  });

  test('数据库查询失败时使用默认并发', async () => {
    pool.query.mockRejectedValueOnce(new Error('DB error'));
    redis.del.mockResolvedValue('OK');

    // init() catches error, concurrency stays at 1
    await danmakuBurnQueue.init();
    // No throw — graceful degradation
  });
});

// ============================================================
// 测试组 2: enqueue() — 单任务入队
// ============================================================

describe('DanmakuBurnQueue — enqueue()', () => {
  test('正常入队推送任务到 Redis', async () => {
    const input = tmpPath('enq_input.mp4');
    const ass = tmpPath('enq_ass.ass');
    const output = tmpPath('enq_out.mp4');
    createDummyFile(input);
    createDummyFile(ass);

    redis.lPush.mockResolvedValue(1);
    pool.query.mockResolvedValue({ rows: [] });
    // Mock processQueue to avoid infinite recursion
    danmakuBurnQueue.processQueue = jest.fn();

    await danmakuBurnQueue.enqueue({
      recordingFileId: 1,
      sessionId: 100,
      segmentIndex: 0,
      segmentStartMs: 0,
      segmentEndMs: 10000,
      inputPath: input,
      assPath: ass,
      outputPath: output,
    });

    expect(redis.lPush).toHaveBeenCalledWith('danmaku_burn_queue', expect.any(String));
    // Verify task data serialized correctly
    const taskStr = redis.lPush.mock.calls[0][1];
    const task = JSON.parse(taskStr);
    expect(task.recordingFileId).toBe(1);
    expect(task.sessionId).toBe(100);
    expect(task.segmentIndex).toBe(0);
    expect(task.inputPath).toBe(input);
    expect(task.assPath).toBe(ass);
    expect(task.outputPath).toBe(output);
  });

  test('输入文件不存在跳过', async () => {
    redis.lPush.mockResolvedValue(1);
    danmakuBurnQueue.processQueue = jest.fn();

    await danmakuBurnQueue.enqueue({
      recordingFileId: 1,
      sessionId: 100,
      inputPath: tmpPath('no_such.mp4'),
      assPath: tmpPath('some.ass'),
      outputPath: tmpPath('out.mp4'),
    });

    // Should NOT push to queue
    expect(redis.lPush).not.toHaveBeenCalled();
  });

  test('ASS 文件不存在标记 skipped', async () => {
    const input = tmpPath('has_input.mp4');
    createDummyFile(input);

    redis.lPush.mockResolvedValue(1);
    pool.query.mockResolvedValue({ rows: [] });
    danmakuBurnQueue.processQueue = jest.fn();

    await danmakuBurnQueue.enqueue({
      recordingFileId: 2,
      sessionId: 101,
      inputPath: input,
      assPath: tmpPath('no_ass.ass'),
      outputPath: tmpPath('out.mp4'),
    });

    expect(redis.lPush).not.toHaveBeenCalled();
    // Should update burn record to skipped
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE danmaku_burn_records'), [
      'skipped',
      null,
      'ASS 文件不存在',
      2,
    ]);
  });

  test('输出文件已存在且非 force 跳过', async () => {
    const input = tmpPath('has_both.mp4');
    const ass = tmpPath('has_both.ass');
    const output = tmpPath('has_both_out.mp4');
    createDummyFile(input);
    createDummyFile(ass);
    createDummyFile(output);

    redis.lPush.mockResolvedValue(1);
    danmakuBurnQueue.processQueue = jest.fn();

    await danmakuBurnQueue.enqueue({
      recordingFileId: 3,
      sessionId: 102,
      inputPath: input,
      assPath: ass,
      outputPath: output,
      force: false,
    });

    expect(redis.lPush).not.toHaveBeenCalled();
  });
});

// ============================================================
// 测试组 3: enqueueSession() — 批量入队
// ============================================================

describe('DanmakuBurnQueue — enqueueSession()', () => {
  test('批量入队所有有 ASS 的分段', async () => {
    const seg1 = tmpPath('seg1.mp4');
    const seg1Ass = tmpPath('seg1.ass');
    const seg2 = tmpPath('seg2.mp4');
    const seg2Ass = tmpPath('seg2.ass');
    createDummyFile(seg1);
    createDummyFile(seg1Ass);
    createDummyFile(seg2);
    createDummyFile(seg2Ass);

    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 10,
          file_path: seg1,
          segment_index: 0,
          segment_start_ms: 0,
          segment_end_ms: 30000,
          danmaku_ass_path: seg1Ass,
        },
        {
          id: 11,
          file_path: seg2,
          segment_index: 1,
          segment_start_ms: 30000,
          segment_end_ms: 60000,
          danmaku_ass_path: seg2Ass,
        },
      ],
    });

    // Mock enqueue to capture calls
    const originalEnqueue = danmakuBurnQueue.enqueue;
    const enqueueCalls = [];
    danmakuBurnQueue.enqueue = async (task) => {
      enqueueCalls.push(task);
    };
    redis.lPush.mockResolvedValue(1);
    pool.query.mockResolvedValue({ rows: [] });
    danmakuBurnQueue.processQueue = jest.fn();

    const count = await danmakuBurnQueue.enqueueSession({ sessionId: 200 });

    expect(count).toBe(2);
    expect(enqueueCalls).toHaveLength(2);
    expect(enqueueCalls[0].recordingFileId).toBe(10);
    expect(enqueueCalls[0].inputPath).toBe(seg1);
    expect(enqueueCalls[1].recordingFileId).toBe(11);
    expect(enqueueCalls[1].inputPath).toBe(seg2);

    danmakuBurnQueue.enqueue = originalEnqueue;
  });

  test('无录制文件返回 0', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const count = await danmakuBurnQueue.enqueueSession({ sessionId: 300 });
    expect(count).toBe(0);
  });

  test('分段无 ASS 文件跳过', async () => {
    const seg1 = tmpPath('seg_no_ass.mp4');
    createDummyFile(seg1);

    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 20,
          file_path: seg1,
          segment_index: 0,
          segment_start_ms: 0,
          segment_end_ms: 30000,
          danmaku_ass_path: '', // No ASS
        },
      ],
    });

    danmakuBurnQueue.processQueue = jest.fn();

    const count = await danmakuBurnQueue.enqueueSession({ sessionId: 301 });
    expect(count).toBe(0);
    expect(redis.lPush).not.toHaveBeenCalled();
  });

  test('优先使用转码后 MP4', async () => {
    const tsFile = tmpPath('seg.ts');
    const mp4File = tmpPath('seg.mp4');
    const assFile = tmpPath('seg.ass');
    createDummyFile(tsFile);
    createDummyFile(mp4File); // MP4 exists (transcoded)
    createDummyFile(assFile);

    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 30,
          file_path: tsFile,
          segment_index: 0,
          segment_start_ms: 0,
          segment_end_ms: 30000,
          danmaku_ass_path: assFile,
        },
      ],
    });

    const originalEnqueue = danmakuBurnQueue.enqueue;
    const enqueueCalls = [];
    danmakuBurnQueue.enqueue = async (task) => {
      enqueueCalls.push(task);
    };
    redis.lPush.mockResolvedValue(1);
    pool.query.mockResolvedValue({ rows: [] });
    danmakuBurnQueue.processQueue = jest.fn();

    const count = await danmakuBurnQueue.enqueueSession({ sessionId: 400 });

    expect(count).toBe(1);
    // Should use MP4 instead of TS
    expect(enqueueCalls[0].inputPath).toBe(mp4File);
    expect(enqueueCalls[0].outputPath).toContain('seg_danmaku.mp4');

    danmakuBurnQueue.enqueue = originalEnqueue;
  });
});

// ============================================================
// 测试组 4: processTask() — 成功场景
// ============================================================

describe('DanmakuBurnQueue — processTask()', () => {
  test('压制成功更新 DB 记录', async () => {
    const input = tmpPath('proc_ok.mp4');
    const ass = tmpPath('proc_ok.ass');
    const output = tmpPath('proc_ok_danmaku.mp4');
    createDummyFile(input);
    createDummyFile(ass);

    burner.burn.mockResolvedValue({
      success: true,
      outputPath: output,
      duration: 15000,
      outputSize: 1048576,
    });
    burner.estimateTimeout.mockResolvedValue(1800000);
    pool.query.mockResolvedValue({ rows: [] });

    await danmakuBurnQueue.processTask({
      recordingFileId: 50,
      sessionId: 500,
      segmentIndex: 0,
      inputPath: input,
      assPath: ass,
      outputPath: output,
    });

    // Should update danmaku_burn_records to completed
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE danmaku_burn_records SET status = 'processing'"),
      [50]
    );

    // Verify completed update
    const completedCalls = pool.query.mock.calls.filter((call) => call[0].includes("'completed'"));
    expect(completedCalls.length).toBeGreaterThanOrEqual(1);

    // Verify recording_files updated
    const rfUpdateCalls = pool.query.mock.calls.filter((call) => call[0].includes('UPDATE recording_files'));
    expect(rfUpdateCalls.length).toBeGreaterThanOrEqual(1);
    const rfSql = rfUpdateCalls[0][0];
    expect(rfSql).toContain('is_danmaku_burned = TRUE');
    expect(rfUpdateCalls[0][1]).toContain(output);
    expect(rfUpdateCalls[0][1]).toContain(50);
  });
});

// ============================================================
// 测试组 5: processTask() — 失败场景
// ============================================================

describe('DanmakuBurnQueue — processTask() 失败', () => {
  test('压制失败更新 DB 记录为 failed', async () => {
    const input = tmpPath('fail_input.mp4');
    const ass = tmpPath('fail_ass.ass');
    const output = tmpPath('fail_out.mp4');
    createDummyFile(input);
    createDummyFile(ass);

    burner.burn.mockResolvedValue({
      success: false,
      outputPath: output,
      duration: 5000,
      error: 'FFmpeg crashed',
    });
    burner.estimateTimeout.mockResolvedValue(1800000);
    pool.query.mockResolvedValue({ rows: [] });

    await danmakuBurnQueue.processTask({
      recordingFileId: 60,
      sessionId: 600,
      segmentIndex: 0,
      inputPath: input,
      assPath: ass,
      outputPath: output,
    });

    // Should update to failed
    const failedCalls = pool.query.mock.calls.filter((call) => call[0].includes("'failed'"));
    expect(failedCalls.length).toBeGreaterThanOrEqual(1);
    expect(failedCalls[0][1]).toContain('FFmpeg crashed');
  });

  test('burner 抛出异常时更新 DB 为 failed', async () => {
    const input = tmpPath('err_input.mp4');
    const ass = tmpPath('err_ass.ass');
    const output = tmpPath('err_out.mp4');
    createDummyFile(input);
    createDummyFile(ass);

    burner.burn.mockRejectedValue(new Error('ENOMEM'));
    burner.estimateTimeout.mockResolvedValue(1800000);

    // First call：UPDATE processing
    pool.query.mockResolvedValueOnce({ rows: [] });

    // Second call after catch: UPDATE failed
    pool.query.mockResolvedValueOnce({ rows: [] });

    await danmakuBurnQueue.processTask({
      recordingFileId: 70,
      sessionId: 700,
      segmentIndex: 0,
      inputPath: input,
      assPath: ass,
      outputPath: output,
    });

    // Should have two DB calls: processing + failed
    const failedCalls = pool.query.mock.calls.filter((call) => call[0].includes("'failed'"));
    expect(failedCalls.length).toBeGreaterThanOrEqual(1);
    expect(failedCalls[0][1]).toContain('ENOMEM');
  });
});

// ============================================================
// 测试组 6: 并发控制
// ============================================================

describe('DanmakuBurnQueue — 并发控制', () => {
  test('getCurrentProcessingCount 正常返回', async () => {
    redis.get.mockResolvedValue('2');
    const count = await danmakuBurnQueue.getCurrentProcessingCount();
    expect(count).toBe(2);
  });

  test('getCurrentProcessingCount Redis 出错返回 0', async () => {
    redis.get.mockRejectedValue(new Error('connection refused'));
    const count = await danmakuBurnQueue.getCurrentProcessingCount();
    expect(count).toBe(0);
  });

  test('incrementProcessingCount', async () => {
    redis.incr.mockResolvedValue(3);
    await danmakuBurnQueue.incrementProcessingCount();
    expect(redis.incr).toHaveBeenCalledWith('danmaku_burn_processing_count');
  });

  test('decrementProcessingCount 正数', async () => {
    redis.decr.mockResolvedValue(1);
    await danmakuBurnQueue.decrementProcessingCount();
    expect(redis.decr).toHaveBeenCalledWith('danmaku_burn_processing_count');
  });

  test('decrementProcessingCount 归零时删除 key', async () => {
    redis.decr.mockResolvedValue(0);
    await danmakuBurnQueue.decrementProcessingCount();
    expect(redis.del).toHaveBeenCalledWith('danmaku_burn_processing_count');
  });

  test('resetProcessingCount', async () => {
    redis.del.mockResolvedValue('OK');
    await danmakuBurnQueue.resetProcessingCount();
    expect(redis.del).toHaveBeenCalledWith('danmaku_burn_processing_count');
  });

  test('getQueueLength', async () => {
    redis.lLen.mockResolvedValue(5);
    const len = await danmakuBurnQueue.getQueueLength();
    expect(len).toBe(5);
    expect(redis.lLen).toHaveBeenCalledWith('danmaku_burn_queue');
  });
});

// ============================================================
// 测试组 7: processQueue() — 队列处理
// ============================================================

describe('DanmakuBurnQueue — processQueue()', () => {
  test('队列为空时正常退出', async () => {
    redis.get.mockResolvedValue('0'); // currentProcessing = 0
    redis.rPop.mockResolvedValue(null); // Empty queue

    // Call processQueue directly
    await danmakuBurnQueue.processQueue();
    // Should not have called burner.burn
    expect(burner.burn).not.toHaveBeenCalled();
    // isRunning should be reset
    expect(danmakuBurnQueue.isRunning).toBe(false);
  });

  test('达到并发上限时不处理', async () => {
    redis.get.mockResolvedValue('1'); // currentProcessing = 1 = concurrency

    await danmakuBurnQueue.processQueue();
    // Should not call rPop
    expect(redis.rPop).not.toHaveBeenCalled();
  });

  test('正在运行时不重入', async () => {
    danmakuBurnQueue.isRunning = true;
    redis.get.mockResolvedValue('0');
    redis.rPop.mockResolvedValue(
      JSON.stringify({
        recordingFileId: 1,
        sessionId: 1,
        segmentIndex: 0,
        inputPath: '/tmp/test.mp4',
        assPath: '/tmp/test.ass',
        outputPath: '/tmp/test_danmaku.mp4',
      })
    );

    await danmakuBurnQueue.processQueue();
    // Should return early because isRunning is true
    expect(redis.rPop).not.toHaveBeenCalled();
    danmakuBurnQueue.isRunning = false;
  });
});

// Cleanup: remove temporary test directory
afterAll(() => {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
});
