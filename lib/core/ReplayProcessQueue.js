const redis = require('../../db/redis');
const pool = require('../../db/index');
const ReplayService = require('../../services/ReplayService');
const ReplayUploadService = require('./replay/ReplayUploadService');
const videoProcessor = require('./replay/video-processor');
const cleanup = require('./replay/cleanup');

const QUEUE_KEY = 'replay_process_queue';
const PROCESSING_KEY = 'replay_process_processing_count';
const RECORD_LOCK_PREFIX = 'replay:lock:record:';
const PRINCIPAL_LOCK_PREFIX = 'replay:lock:principal:';
const LOCK_TTL_SECONDS = 6 * 60 * 60;

function safeParseJson(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

class ReplayProcessQueue {
  constructor() {
    this.concurrency = 1;
    this.isRunning = false;
  }

  async init() {
    await this.reloadConcurrency();
    await this.resetProcessingCount();
    console.log(`[回放队列] 初始化完成, 并发数: ${this.concurrency}`);
  }

  async reloadConcurrency() {
    try {
      const result = await pool.query("SELECT value FROM settings WHERE key = 'replay_queue_concurrency'");
      const value = parseInt(result.rows[0]?.value, 10) || 1;
      this.concurrency = Math.max(value, 1);
    } catch (err) {
      console.warn('[回放队列] 重载并发配置失败:', err.message);
      this.concurrency = 1;
    }
  }

  async enqueue(taskData) {
    if (!taskData || !taskData.replayRecordId) {
      throw new Error('缺少 replayRecordId');
    }
    await redis.lPush(QUEUE_KEY, JSON.stringify(taskData));
    this.processQueue();
    return taskData;
  }

  async enqueuePrincipal({ principalId, count = 1, skipCompleted = true, dryRun = false }) {
    const records = await ReplayService.listRecords(principalId, {
      page: 1,
      page_size: count,
      status: skipCompleted ? undefined : undefined,
    });
    const candidates = records.rows.filter((row) => {
      if (!skipCompleted) return true;
      return !['completed', 'backed_up'].includes(row.status);
    });
    if (dryRun) {
      return { dry_run: true, enqueued: 0, candidates };
    }
    for (const record of candidates) {
      await this.enqueue({
        replayRecordId: record.id,
        action: 'all',
      });
    }
    return { enqueued: candidates.length };
  }

  async processQueue() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      while (true) {
        const currentProcessing = await this.getCurrentProcessingCount();
        if (currentProcessing >= this.concurrency) break;

        const taskStr = await redis.rPop(QUEUE_KEY);
        if (!taskStr) break;

        const task = JSON.parse(taskStr);
        await this.incrementProcessingCount();
        this.processTask(task).finally(() => {
          this.decrementProcessingCount();
          this.processQueue();
        });
      }
    } catch (err) {
      console.error('[回放队列] 处理队列异常:', err.message);
    } finally {
      this.isRunning = false;
    }
  }

  async processTask(task) {
    const record = await ReplayService.getRecord(task.replayRecordId);
    if (!record) return;

    const recordLock = `${RECORD_LOCK_PREFIX}${record.id}`;
    const principalLock = `${PRINCIPAL_LOCK_PREFIX}${record.principal_id}`;
    const token = `${process.pid}:${Date.now()}`;
    const recordAcquired = await redis.set(recordLock, token, { NX: true, EX: LOCK_TTL_SECONDS });
    if (!recordAcquired) {
      console.log(`[回放队列] 记录 ${record.id} 已在处理中，跳过`);
      return;
    }

    let principalAcquired = false;
    let deferred = false;
    try {
      principalAcquired = await redis.set(principalLock, token, { NX: true, EX: LOCK_TTL_SECONDS });
      if (!principalAcquired) {
        console.log(`[回放队列] 主播 ${record.principal_id} 已有任务处理中，重新入队`);
        await redis.lPush(QUEUE_KEY, JSON.stringify(task));
        deferred = true;
        return;
      }

      await this.runAction(record, task.action || 'all');
    } catch (err) {
      console.error(`[回放队列] 任务失败 record=${record.id}:`, err.message);
      await ReplayService.updateRecordStatus(record.id, 'failed', { error_message: err.message });
    } finally {
      // 延迟入队的任务保留 record 锁，避免与重入队任务冲突
      if (!deferred) await redis.del(recordLock).catch(() => {});
      if (principalAcquired) await redis.del(principalLock).catch(() => {});
    }
  }

  async runAction(record, action) {
    const actions = action === 'all' ? ['extract', 'download', 'cut', 'fix', 'upload'] : [action];
    let current = record;

    for (const step of actions) {
      if (step === 'extract') {
        const result = await videoProcessor.extract(current);
        if (!result.success) throw new Error(result.error);
        const updateFields = { m3u8_url: result.m3u8Url };
        if (result.duration && (!current.duration || current.duration === 0)) {
          updateFields.duration = result.duration;
        }
        current = await ReplayService.updateRecordStatus(current.id, 'extracted', updateFields);
      } else if (step === 'download') {
        const result = await videoProcessor.download(current);
        if (!result.success) throw new Error(result.error);
        current = await ReplayService.updateRecordStatus(current.id, 'downloaded', {
          raw_file_path: result.rawFilePath,
          file_size: result.fileSize,
        });
      } else if (step === 'cut') {
        const result = await videoProcessor.cut(current);
        if (!result.success) throw new Error(result.error);
        current = await ReplayService.updateRecordStatus(current.id, 'cut', {
          cut_file_paths: result.cutFilePaths,
        });
        if (current.raw_file_path) cleanup.removeFiles([current.raw_file_path]).catch(() => {});
      } else if (step === 'fix') {
        const result = await videoProcessor.fix(current);
        if (!result.success) throw new Error(result.error);
        const previous = safeParseJson(current.cut_file_paths, []);
        current = await ReplayService.updateRecordStatus(current.id, 'fixed', {
          fixed_file_paths: result.fixedFilePaths,
          final_file_paths: result.finalFilePaths,
        });
        cleanup.removeFiles(previous).catch(() => {});
      } else if (step === 'upload') {
        const result = await ReplayUploadService.executeUpload(current.id);
        if (result.error) throw new Error(result.message);
      } else {
        throw new Error(`未知回放动作: ${step}`);
      }
    }
  }

  async getCurrentProcessingCount() {
    try {
      return parseInt(await redis.get(PROCESSING_KEY), 10) || 0;
    } catch (_) {
      return 0;
    }
  }

  async incrementProcessingCount() {
    try {
      await redis.incr(PROCESSING_KEY);
    } catch (_) {}
  }

  async decrementProcessingCount() {
    try {
      const count = await redis.decr(PROCESSING_KEY);
      if (count <= 0) await redis.del(PROCESSING_KEY);
    } catch (_) {}
  }

  async resetProcessingCount() {
    try {
      await redis.del(PROCESSING_KEY);
    } catch (_) {}
  }

  async getQueueLength() {
    try {
      return await redis.lLen(QUEUE_KEY);
    } catch (_) {
      return 0;
    }
  }

  async getStatus() {
    return {
      queue_length: await this.getQueueLength(),
      processing: await this.getCurrentProcessingCount(),
      concurrency: this.concurrency,
    };
  }
}

module.exports = new ReplayProcessQueue();
