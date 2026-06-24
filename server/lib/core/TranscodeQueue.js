const fs = require('fs');
const path = require('path');
const redis = require('../../db/redis');
const pool = require('../../db/index');
const transcoder = require('./transcoder');
const hlsGenerator = require('./hls-generator');

const QUEUE_KEY = 'transcode_queue';
const QUEUE_PATHS_SET = 'transcode_queue_paths'; // 文件路径索引集，用于快速检查文件是否在队列中
const PROCESSING_KEY = 'transcode_processing_count';

class TranscodeQueue {
  constructor() {
    this.concurrency = 1;
    this.isRunning = false;
  }

  /**
   * 初始化转码队列:从数据库加载并发配置
   */
  async init() {
    await this.reloadConcurrency();
    await this.resetProcessingCount();
    console.log(`[转码队列] 初始化完成, 并发数: ${this.concurrency}`);
  }

  /**
   * 重载并发配置(从数据库)
   */
  async reloadConcurrency() {
    try {
      const result = await pool.query("SELECT value FROM settings WHERE key = 'transcode_concurrency'");
      if (result.rows.length > 0) {
        const newConcurrency = parseInt(result.rows[0].value, 10) || 1;
        if (newConcurrency !== this.concurrency) {
          console.log(`[转码队列] 并发数更新: ${this.concurrency} → ${newConcurrency}`);
          this.concurrency = newConcurrency;
        }
      }
    } catch (err) {
      console.error('[转码队列] 重载并发配置失败:', err.message);
    }
  }

  /**
   * 入队:添加转码任务到Redis队列
   * @param {Object} taskData - 任务数据
   * @param {string} taskData.videoPathToTrans - 需要转码的文件路径（flv/ts）
   * @param {string} taskData.mp4Path - 输出的MP4文件路径
   * @param {string} taskData.sessionId - 录制会话ID
   * @param {boolean} [taskData.force] - 是否强制入队（无视 auto_transcode 设置）
   */
  async enqueue(taskData) {
    try {
      if (!taskData.force) {
        const autoTranscode = await this.getSetting('auto_transcode', 'true');
        if (autoTranscode !== 'true') {
          console.log(`[转码队列] 自动转码已禁用，跳过入队: ${path.basename(taskData.videoPathToTrans)}`);
          return;
        }
      }

      await redis.lPush(QUEUE_KEY, JSON.stringify(taskData));
      // 维护路径索引集，供 _isFileInRedisQueue 快速查询
      await redis.sAdd(QUEUE_PATHS_SET, taskData.videoPathToTrans);
      if (taskData.mp4Path) await redis.sAdd(QUEUE_PATHS_SET, taskData.mp4Path);
      await this.createTranscodeRecord(taskData);
      const tag = taskData.force ? '[手动]' : '[自动]';
      console.log(`[转码队列] ${tag} 任务入队: ${path.basename(taskData.videoPathToTrans)}`);
      this.processQueue();
    } catch (err) {
      console.error('[转码队列] 入队失败:', err.message);
    }
  }

  /**
   * 创建转码记录
   */
  async createTranscodeRecord(taskData) {
    try {
      await pool.query(
        `INSERT INTO transcode_records (session_id, original_path, transcoded_path, status, enqueued_at)
         VALUES ($1, $2, $3, 'queued', NOW())
         ON CONFLICT (original_path) DO NOTHING`,
        [taskData.sessionId, taskData.videoPathToTrans, taskData.mp4Path]
      );
    } catch (err) {
      console.warn('[转码队列] 创建记录失败:', err.message);
    }
  }

  /**
   * 更新转码记录为进行中
   */
  async startTranscodeRecord(videoPathToTrans) {
    try {
      await pool.query(
        `UPDATE transcode_records SET status = 'processing', started_at = NOW() WHERE original_path = $1`,
        [videoPathToTrans]
      );
    } catch (err) {
      console.warn('[转码队列] 更新记录失败:', err.message);
    }
  }

  /**
   * 完成转码记录
   */
  async completeTranscodeRecord(videoPathToTrans, mp4Path, success) {
    try {
      const status = success ? 'completed' : 'failed';
      await pool.query(
        `UPDATE transcode_records SET status = $1, transcoded_path = $2, completed_at = NOW() WHERE original_path = $3`,
        [status, mp4Path, videoPathToTrans]
      );
    } catch (err) {
      console.warn('[转码队列] 完成记录失败:', err.message);
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
          // 清理路径索引集
          redis.sRem(QUEUE_PATHS_SET, task.videoPathToTrans).catch(() => {});
          if (task.mp4Path) redis.sRem(QUEUE_PATHS_SET, task.mp4Path).catch(() => {});
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
    const { videoPathToTrans, mp4Path, sessionId: _sessionId, force } = task;

    try {
      await this.startTranscodeRecord(videoPathToTrans);

      // 检查 auto_transcode 设置
      if (!force) {
        const autoTranscode = await this.getSetting('auto_transcode', 'true');
        if (autoTranscode !== 'true') {
          console.log(`[转码队列] 自动转码已禁用，跳过: ${path.basename(videoPathToTrans)}`);
          await this.completeTranscodeRecord(videoPathToTrans, mp4Path, false);
          return;
        }
      }

      // 检查碎片大小阈值
      const thresholdValue = await this.getSetting('filtering_threshold', '10');
      const thresholdBytes = (parseInt(thresholdValue, 10) || 10) * 1024 * 1024;
      let stat;
      try {
        stat = fs.statSync(videoPathToTrans);
      } catch {
        console.log(`[转码队列] 文件不存在或无法读取，跳过: ${path.basename(videoPathToTrans)}`);
        await this.completeTranscodeRecord(videoPathToTrans, mp4Path, false);
        return;
      }
      if (stat.size < thresholdBytes) {
        console.log(
          `[转码队列] 文件小于碎片阈值，跳过: ${path.basename(videoPathToTrans)} (${(stat.size / 1024 / 1024).toFixed(1)}MB < ${thresholdValue}MB)`
        );
        await this.completeTranscodeRecord(videoPathToTrans, mp4Path, false);
        return;
      }

      console.log(`[转码队列] 开始转码: ${path.basename(videoPathToTrans)} → ${path.basename(mp4Path)}`);

      const result = await transcoder.fastTranscode(videoPathToTrans, mp4Path, task.sessionId);

      if (result.success) {
        console.log(
          `[转码队列] 转码成功: ${path.basename(mp4Path)} (${(result.outputSize / 1024 / 1024).toFixed(1)}MB)`
        );

        // 更新数据库记录
        await this.updateDatabasePaths(videoPathToTrans, mp4Path, result.outputSize, _sessionId);
        await this.completeTranscodeRecord(videoPathToTrans, mp4Path, true);

        // 自动生成 HLS（如果启用）
        this.triggerHLSGeneration(mp4Path, _sessionId).catch((err) => {
          console.warn('[转码队列] HLS 生成触发失败:', err.message);
        });

        // 删除原文件(如果配置了)
        const deleteOriginals = await this.getSetting('transcode_delete_originals', 'true');
        if (deleteOriginals === 'true') {
          try {
            fs.unlinkSync(videoPathToTrans);
            console.log(`[转码队列] 已删除原文件: ${path.basename(videoPathToTrans)}`);
          } catch (err) {
            console.warn(`[转码队列] 删除原文件失败: ${videoPathToTrans}`, err.message);
          }
        }
      } else {
        console.error(`[转码队列] 转码失败: ${path.basename(videoPathToTrans)}, ${result.error}`);
        await this.completeTranscodeRecord(videoPathToTrans, mp4Path, false);
        try {
          if (fs.existsSync(mp4Path)) {
            fs.unlinkSync(mp4Path);
            console.log(`[转码队列] 已清理失败产物: ${path.basename(mp4Path)}`);
          }
        } catch (cleanupErr) {
          console.warn(`[转码队列] 清理失败产物异常: ${path.basename(mp4Path)}`, cleanupErr.message);
        }
      }
    } catch (err) {
      console.error(`[转码队列] 处理任务异常: ${path.basename(videoPathToTrans)}`, err.message);
      await this.completeTranscodeRecord(videoPathToTrans, mp4Path, false);
    }
  }

  /**
   * 更新数据库中的文件路径
   */
  async updateDatabasePaths(videoPathToTrans, mp4Path, outputSize, _sessionId) {
    try {
      await pool.query(
        `UPDATE recording_files SET file_path = $1, file_name = $2, file_size = $3 WHERE file_path = $4`,
        [mp4Path, path.basename(mp4Path), outputSize, videoPathToTrans]
      );
      await pool.query(`UPDATE recordings SET file_path = $1, file_size = $2 WHERE file_path = $3`, [
        mp4Path,
        outputSize,
        videoPathToTrans,
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
      const count = await redis.decr(PROCESSING_KEY);
      if (count <= 0) {
        await redis.del(PROCESSING_KEY);
      }
    } catch (_) {}
  }

  /**
   * 重置处理中计数（启动时调用，防止崩溃泄露）
   */
  async resetProcessingCount() {
    try {
      await redis.del(PROCESSING_KEY);
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
   * 触发 HLS 生成
   */
  async triggerHLSGeneration(mp4Path, _sessionId) {
    try {
      const autoGenerateHLS = await this.getSetting('auto_generate_hls', 'true');
      if (autoGenerateHLS !== 'true') {
        return;
      }

      const result = await pool.query(`SELECT id FROM recording_files WHERE file_path = $1 LIMIT 1`, [mp4Path]);

      if (result.rows.length > 0) {
        const recordingId = result.rows[0].id;
        console.log(`[转码队列] 触发 HLS 生成: ${path.basename(mp4Path)}`);
        const genResult = await hlsGenerator.generateForRecording(recordingId);
        if (genResult.success) {
          console.log(`[转码队列] HLS 生成成功: ${genResult.playlistPath}`);
        } else {
          console.warn(`[转码队列] HLS 生成失败: ${genResult.error}`);
        }
      }
    } catch (err) {
      console.warn('[转码队列] 触发 HLS 生成异常:', err.message);
    }
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
