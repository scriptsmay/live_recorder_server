const fs = require('fs');
const redis = require('../../db/redis');
const pool = require('../../db/index');
const ReplayService = require('../../services/ReplayService');
const ReplayUploadService = require('./replay/ReplayUploadService');
const videoProcessor = require('./replay/video-processor');
const cleanup = require('./replay/cleanup');
const notify = require('./notify');
const { createProcLog, writeLog } = require('../utils/proc-log');

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

function hasExistingFile(filePath) {
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

function hasExistingFiles(value) {
  const files = Array.isArray(value) ? value : safeParseJson(value, []);
  return files.length > 0 && files.every(hasExistingFile);
}

function getRecordDisplayName(record) {
  return (
    record.principal_name || record.room_name || record.video_file_name || record.principal_id || `回放 ${record.id}`
  );
}

class ReplayProcessQueue {
  constructor() {
    this.concurrency = 1;
    this.isRunning = false;
    this.activeTasks = new Map();
  }

  async init() {
    await this.reloadConcurrency();
    await this.resetProcessingCount();
    await this.clearStaleLocks();
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

    const logger = createProcLog('replay', record.id);
    const logStream = logger.stream;
    writeLog(logStream, `任务开始 record=${record.id} action=${task.action || 'all'}`);
    writeLog(logStream, `principal=${record.principal_id} replay_id=${record.replay_id || ''}`);
    writeLog(logStream, `play_url=${record.play_url || ''}`);
    console.log(`[回放队列] 任务日志: ${logger.logPath}`);

    const recordLock = `${RECORD_LOCK_PREFIX}${record.id}`;
    const principalLock = `${PRINCIPAL_LOCK_PREFIX}${record.principal_id}`;
    const token = `${process.pid}:${Date.now()}`;
    const recordAcquired = await redis.set(recordLock, token, { NX: true, EX: LOCK_TTL_SECONDS });
    if (!recordAcquired) {
      console.log(`[回放队列] 记录 ${record.id} 已在处理中，跳过`);
      writeLog(logStream, '记录锁已存在，跳过处理');
      logger.destroy();
      return;
    }

    let principalAcquired = false;
    let deferred = false;
    try {
      principalAcquired = await redis.set(principalLock, token, { NX: true, EX: LOCK_TTL_SECONDS });
      if (!principalAcquired) {
        console.log(`[回放队列] 主播 ${record.principal_id} 已有任务处理中，重新入队`);
        writeLog(logStream, `主播锁已存在，重新入队 principal=${record.principal_id}`);
        await redis.lPush(QUEUE_KEY, JSON.stringify(task));
        deferred = true;
        return;
      }

      const runtime = { cancelled: false };
      this.activeTasks.set(record.id, {
        recordId: record.id,
        principalId: record.principal_id,
        action: task.action || 'all',
        step: '',
        proc: null,
        pid: null,
        command: '',
        startedAt: new Date().toISOString(),
        runtime,
        logStream,
      });

      await this.runAction(record, task.action || 'all', { logStream, runtime, force: task.force });
      writeLog(logStream, '任务完成');
    } catch (err) {
      console.error(`[回放队列] 任务失败 record=${record.id}:`, err.message);
      writeLog(logStream, `任务失败: ${err.message}`);
      const status = err.code === 'REPLAY_TASK_CANCELLED' ? 'cancelled' : 'failed';
      await ReplayService.updateRecordStatus(record.id, status, { error_message: err.message });
    } finally {
      // 延迟入队的任务保留 record 锁，避免与重入队任务冲突
      if (!deferred) await redis.del(recordLock).catch(() => {});
      if (principalAcquired) await redis.del(principalLock).catch(() => {});
      this.activeTasks.delete(record.id);
      logger.destroy();
    }
  }

  resolveSteps(action, _record, force) {
    const allSteps = ['extract', 'download', 'cut', 'upload'];
    if (action !== 'all') return [action];
    if (force) return allSteps;
    return allSteps;
  }

  async runAction(record, action, options = {}) {
    const force = options.force || false;
    const actions = this.resolveSteps(action, record, force);
    let current = record;
    const { logStream } = options;
    const runtime = options.runtime || { cancelled: false };
    if (!force) writeLog(logStream, `续跑模式: 将复用已有产物 (status=${record.status})`);

    for (const step of actions) {
      if (runtime.cancelled) {
        const err = new Error('用户取消任务');
        err.code = 'REPLAY_TASK_CANCELLED';
        throw err;
      }
      const active = this.activeTasks.get(current.id);
      if (active) {
        active.step = step;
        active.proc = null;
        active.pid = null;
        active.command = '';
      }
      writeLog(logStream, `步骤开始: ${step}`);
      if (action === 'all' && !force && this.isStepComplete(current, step)) {
        writeLog(logStream, `步骤跳过: ${step} 已有可复用产物`);
        continue;
      }
      if (step === 'extract') {
        const result = await videoProcessor.extract(current, { logStream, force });
        this.throwIfCancelled(runtime);
        if (!result.success) throw new Error(result.error);
        const updateFields = { m3u8_url: result.m3u8Url, error_message: '' };
        if (result.duration && (!current.duration || current.duration === 0)) {
          updateFields.duration = result.duration;
        }
        current = await ReplayService.updateRecordStatus(current.id, 'extracted', updateFields);
        writeLog(logStream, `步骤完成: extract m3u8=${result.m3u8Url}`);
        this.notifyPipelineComplete(current, 'extract', { status: 'extracted', m3u8_url: result.m3u8Url }, logStream);
      } else if (step === 'download') {
        const result = await videoProcessor.download(current, this.commandOptions(current.id, step, logStream, force));
        this.throwIfCancelled(runtime);
        if (!result.success) throw new Error(result.error);
        current = await ReplayService.updateRecordStatus(current.id, 'downloaded', {
          raw_file_path: result.rawFilePath,
          file_size: result.fileSize,
          error_message: '',
        });
        writeLog(logStream, `步骤完成: download file=${result.rawFilePath}`);
        this.notifyPipelineComplete(
          current,
          'download',
          { status: 'downloaded', raw_file_path: result.rawFilePath, file_size: result.fileSize },
          logStream
        );
      } else if (step === 'cut') {
        const result = await videoProcessor.cut(current, this.commandOptions(current.id, step, logStream, force));
        this.throwIfCancelled(runtime);
        if (!result.success) throw new Error(result.error);
        current = await ReplayService.updateRecordStatus(current.id, 'cut', {
          cut_file_paths: result.cutFilePaths,
          error_message: '',
        });
        if (current.raw_file_path) cleanup.removeFiles([current.raw_file_path]).catch(() => {});
        writeLog(logStream, `步骤完成: cut files=${JSON.stringify(result.cutFilePaths)}`);
        this.notifyPipelineComplete(current, 'cut', { status: 'cut', cut_file_paths: result.cutFilePaths }, logStream);
      } else if (step === 'fix') {
        const result = await videoProcessor.fix(current, this.commandOptions(current.id, step, logStream, force));
        this.throwIfCancelled(runtime);
        if (!result.success) throw new Error(result.error);
        const previous = safeParseJson(current.cut_file_paths, []);
        current = await ReplayService.updateRecordStatus(current.id, 'fixed', {
          fixed_file_paths: result.fixedFilePaths,
          final_file_paths: result.finalFilePaths,
          error_message: '',
        });
        cleanup.removeFiles(previous).catch(() => {});
        writeLog(logStream, `步骤完成: fix files=${JSON.stringify(result.finalFilePaths)}`);
        this.notifyPipelineComplete(
          current,
          'fix',
          { status: 'fixed', final_file_paths: result.finalFilePaths },
          logStream
        );
      } else if (step === 'upload') {
        const result = await ReplayUploadService.executeUpload(current.id);
        this.throwIfCancelled(runtime);
        if (result.error) throw new Error(result.message);
        writeLog(logStream, `步骤完成: upload upload_record_id=${result.upload_record_id || ''}`);
        this.notifyPipelineComplete(
          current,
          'upload',
          { status: 'upload_started', upload_record_id: result.upload_record_id },
          logStream
        );
      } else {
        throw new Error(`未知回放动作: ${step}`);
      }
    }
  }

  isStepComplete(record, step) {
    if (step === 'extract') return Boolean(record.m3u8_url) && Boolean(record.duration);
    if (step === 'download') {
      return (
        hasExistingFile(record.raw_file_path) ||
        hasExistingFiles(record.cut_file_paths) ||
        hasExistingFiles(record.final_file_paths)
      );
    }
    if (step === 'cut') return hasExistingFiles(record.cut_file_paths) || hasExistingFiles(record.final_file_paths);
    if (step === 'fix') return hasExistingFiles(record.final_file_paths);
    if (step === 'upload') return Boolean(record.bv_id || record.uploaded_at || record.completed_at);
    return false;
  }

  notifyPipelineComplete(record, step, detail, logStream) {
    notify
      .replayPipelineComplete(getRecordDisplayName(record), step, record.id, detail, record.play_url)
      .catch((err) => {
        writeLog(logStream, `步骤完成通知发送失败 step=${step}: ${err.message}`);
        console.error('[回放队列] 步骤完成通知发送失败:', err.message);
      });
  }

  throwIfCancelled(runtime) {
    if (!runtime?.cancelled) return;
    const err = new Error('用户取消任务');
    err.code = 'REPLAY_TASK_CANCELLED';
    throw err;
  }

  commandOptions(recordId, step, logStream, force = false) {
    return {
      force,
      logStream,
      onProcessStart: (proc, command, args) => {
        const active = this.activeTasks.get(recordId);
        if (!active) return;
        active.step = step;
        active.proc = proc;
        active.pid = proc.pid;
        active.command = `${command} ${args.join(' ')}`;
        writeLog(logStream, `子进程启动 step=${step} pid=${proc.pid} command=${active.command}`);
      },
      onProcessEnd: (proc) => {
        const active = this.activeTasks.get(recordId);
        if (!active || active.proc !== proc) return;
        writeLog(logStream, `子进程结束 step=${step} pid=${proc.pid}`);
        active.proc = null;
        active.pid = null;
        active.command = '';
      },
    };
  }

  async cancelRecord(recordId) {
    const id = parseInt(recordId, 10);
    if (!Number.isFinite(id)) {
      throw new Error('无效回放记录 ID');
    }

    const active = this.activeTasks.get(id);
    if (!active) {
      return { cancelled: false, message: '回放任务未在运行中' };
    }

    if (!active.runtime) active.runtime = {};
    active.runtime.cancelled = true;
    if (active.proc && active.proc.exitCode === null && active.proc.signalCode == null) {
      const proc = active.proc;
      writeLog(active.logStream, `取消任务，发送 SIGTERM pid=${active.pid}`);
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (active.proc === proc && proc.exitCode === null && proc.signalCode == null) {
          writeLog(active.logStream, `取消任务超时，发送 SIGKILL pid=${proc.pid}`);
          proc.kill('SIGKILL');
        }
      }, 5000).unref?.();
    }

    await ReplayService.updateRecordStatus(id, 'cancelled', { error_message: '用户取消任务' }).catch(() => {});
    return {
      cancelled: true,
      record_id: id,
      step: active.step,
      pid: active.pid,
    };
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

  async clearStaleLocks() {
    try {
      const patterns = [`${RECORD_LOCK_PREFIX}*`, `${PRINCIPAL_LOCK_PREFIX}*`];
      for (const pattern of patterns) {
        const keys = await redis.keys(pattern);
        if (keys.length > 0) {
          for (const key of keys) {
            await redis.del(key);
          }
          console.log(`[回放队列] 清理残留锁: ${keys.length} 个 (${pattern})`);
        }
      }
    } catch (err) {
      console.warn('[回放队列] 清理残留锁失败:', err.message);
    }
  }

  async getQueueLength() {
    try {
      return await redis.lLen(QUEUE_KEY);
    } catch (_) {
      return 0;
    }
  }

  async getStatus() {
    const active = Array.from(this.activeTasks.values()).map((task) => ({
      record_id: task.recordId,
      principal_id: task.principalId,
      action: task.action,
      step: task.step,
      pid: task.pid,
      command: task.command,
      started_at: task.startedAt,
    }));
    return {
      queue_length: await this.getQueueLength(),
      processing: await this.getCurrentProcessingCount(),
      concurrency: this.concurrency,
      active,
    };
  }
}

module.exports = new ReplayProcessQueue();
