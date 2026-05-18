const fs = require('fs');
const path = require('path');
const redis = require('../../db/redis');
const pool = require('../../db/index');
const transcoder = require('./transcoder');

const QUEUE_KEY = 'transcode_queue';
const PROCESSING_KEY = 'transcode_processing_count';

class TranscodeQueue {
  constructor() {
    this.concurrency = 3;
    this.isRunning = false;
  }

  /**
   * 初始化转码队列:从数据库加载并发配置
   */
  async init() {
    try {
      const result = await pool.query("SELECT value FROM settings WHERE key = 'transcode_concurrency'");
      if (result.rows.length > 0) {
        this.concurrency = parseInt(result.rows[0].value, 10) || 3;
      }
      console.log(`[转码队列] 初始化完成, 并发数: ${this.concurrency}`);
    } catch (err) {
      console.error('[转码队列] 初始化失败:', err.message);
    }
  }

  /**
   * 入队:添加转码任务到Redis队列
   * @param {Object} taskData - 任务数据
   * @param {string} taskData.flvPath - FLV文件路径
   * @param {string} taskData.mp4Path - 输出的MP4文件路径
   * @param {string} taskData.sessionId - 录制会话ID
   */
  async enqueue(taskData) {
    try {
      await redis.lPush(QUEUE_KEY, JSON.stringify(taskData));
      console.log(`[转码队列] 任务入队: ${path.basename(taskData.flvPath)}`);
      this.processQueue();
    } catch (err) {
      console.error('[转码队列] 入队失败:', err.message);
    }
  }

  /**
   * 处理队列:控制并发数
   */
  async processQueue() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      while (true) {
        const currentProcessing = await this.getCurrentProcessingCount();
        if (currentProcessing >= this.concurrency) {
          break;
        }

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
      console.error('[转码队列] 处理队列异常:', err.message);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 处理单个转码任务
   */
  async processTask(task) {
    const { flvPath, mp4Path, sessionId: _sessionId } = task;

    try {
      // 检查 auto_transcode 设置
      const autoTranscode = await this.getSetting('auto_transcode', 'true');
      if (autoTranscode !== 'true') {
        console.log(`[转码队列] 自动转码已禁用，跳过: ${path.basename(flvPath)}`);
        return;
      }

      // 检查碎片大小阈值
      const thresholdValue = await this.getSetting('filtering_threshold', '10');
      const thresholdBytes = (parseInt(thresholdValue, 10) || 10) * 1024 * 1024;
      let stat;
      try {
        stat = fs.statSync(flvPath);
      } catch {
        console.log(`[转码队列] 文件不存在或无法读取，跳过: ${path.basename(flvPath)}`);
        return;
      }
      if (stat.size < thresholdBytes) {
        console.log(`[转码队列] 文件小于碎片阈值，跳过: ${path.basename(flvPath)} (${(stat.size / 1024 / 1024).toFixed(1)}MB < ${thresholdValue}MB)`);
        return;
      }

      console.log(`[转码队列] 开始转码: ${path.basename(flvPath)} → ${path.basename(mp4Path)}`);

      const result = await transcoder.fastTranscode(flvPath, mp4Path);

      if (result.success) {
        console.log(
          `[转码队列] 转码成功: ${path.basename(mp4Path)} (${(result.outputSize / 1024 / 1024).toFixed(1)}MB)`
        );

        // 更新数据库记录
        await this.updateDatabasePaths(flvPath, mp4Path, result.outputSize, _sessionId);

        // 删除原文件(如果配置了)
        const deleteOriginals = await this.getSetting('transcode_delete_originals', 'true');
        if (deleteOriginals === 'true') {
          try {
            fs.unlinkSync(flvPath);
            console.log(`[转码队列] 已删除原文件: ${path.basename(flvPath)}`);
          } catch (err) {
            console.warn(`[转码队列] 删除原文件失败: ${flvPath}`, err.message);
          }
        }
      } else {
        console.error(`[转码队列] 转码失败: ${path.basename(flvPath)}, ${result.error}`);
      }
    } catch (err) {
      console.error(`[转码队列] 处理任务异常: ${path.basename(flvPath)}`, err.message);
    }
  }

  /**
   * 更新数据库中的文件路径
   */
  async updateDatabasePaths(flvPath, mp4Path, outputSize, _sessionId) {
    try {
      await pool.query(
        `UPDATE recording_files SET file_path = $1, file_name = $2, file_size = $3 WHERE file_path = $4`,
        [mp4Path, path.basename(mp4Path), outputSize, flvPath]
      );
      await pool.query(`UPDATE recordings SET file_path = $1, file_size = $2 WHERE file_path = $3`, [
        mp4Path,
        outputSize,
        flvPath,
      ]);
    } catch (err) {
      console.error('[转码队列] 更新数据库失败:', err.message);
    }
  }

  /**
   * 获取当前处理中的任务数
   */
  async getCurrentProcessingCount() {
    try {
      const count = await redis.get(PROCESSING_KEY);
      return parseInt(count, 10) || 0;
    } catch (_) {
      return 0;
    }
  }

  /**
   * 增加处理中计数
   */
  async incrementProcessingCount() {
    try {
      await redis.incr(PROCESSING_KEY);
    } catch (_) {}
  }

  /**
   * 减少处理中计数
   */
  async decrementProcessingCount() {
    try {
      await redis.decr(PROCESSING_KEY);
    } catch (_) {}
  }

  /**
   * 获取设置值
   */
  async getSetting(key, defaultValue) {
    try {
      const result = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
      if (result.rows.length > 0) {
        return result.rows[0].value;
      }
    } catch (_) {}
    return defaultValue;
  }

  /**
   * 转码队列中是否仍有指定会话的任务
   */
  async hasSessionPending(sessionId) {
    const sid = String(sessionId);
    try {
      const len = await redis.lLen(QUEUE_KEY);
      if (len === 0) return false;
      const items = await redis.lRange(QUEUE_KEY, 0, len - 1);
      for (const item of items) {
        try {
          if (String(JSON.parse(item).sessionId) === sid) return true;
        } catch (_) {}
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  /**
   * 获取队列长度(用于监控)
   */
  async getQueueLength() {
    try {
      return await redis.lLen(QUEUE_KEY);
    } catch (_) {
      return 0;
    }
  }
}

module.exports = new TranscodeQueue();
