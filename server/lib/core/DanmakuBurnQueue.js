const fs = require('fs');
const path = require('path');
const redis = require('../../db/redis');
const pool = require('../../db/index');
const burner = require('./danmaku-burner');
const danmakuAssGenerator = require('./danmaku/DanmakuAssGenerator');
const { SUPPORTED_TRANSCODE_EXT, getDanmakuOutputDir } = require('../../config/config');

const QUEUE_KEY = 'danmaku_burn_queue';
const QUEUE_PATHS_SET = 'danmaku_burn_queue_paths'; // 文件路径索引集
const PROCESSING_KEY = 'danmaku_burn_processing_count';

/**
 * DanmakuBurnQueue — 弹幕压制队列
 *
 * 使用 Redis LIST 作为队列，Redis 计数器控制并发。
 * 独立于 TranscodeQueue，防止长时间压制任务阻塞普通转码。
 * 默认并发固定为 1。
 */
class DanmakuBurnQueue {
  constructor() {
    this.concurrency = 1;
    this.isRunning = false;
  }

  /**
   * 初始化队列：从数据库读取并发配置（强制最大 1）
   */
  async init() {
    try {
      const result = await pool.query("SELECT value FROM settings WHERE key = 'danmaku_burn_concurrency'");
      if (result.rows.length > 0) {
        const value = parseInt(result.rows[0].value, 10) || 1;
        this.concurrency = Math.min(value, 1); // 强制最大 1
      }
      await this.resetProcessingCount();
      console.log(`[弹幕压制队列] 初始化完成, 并发数: ${this.concurrency}`);
    } catch (err) {
      console.error('[弹幕压制队列] 初始化失败:', err.message);
    }
  }

  /**
   * 入队
   *
   * @param {Object} taskData
   * @param {number} taskData.recordingFileId - recording_files.id
   * @param {number} taskData.sessionId - 录制会话 ID
   * @param {number} taskData.segmentIndex - 分段索引
   * @param {number} taskData.segmentStartMs - 分段开始时间（ms）
   * @param {number} taskData.segmentEndMs - 分段结束时间（ms）
   * @param {string} taskData.inputPath - 输入视频路径
   * @param {string} taskData.assPath - ASS 字幕路径
   * @param {string} taskData.outputPath - 输出视频路径
   * @param {boolean} [taskData.force=false] - 是否强制覆盖
   * @param {boolean} [taskData.useQsv=false] - 是否使用 QSV
   */
  async enqueue(taskData) {
    try {
      // 检查前置条件
      if (!taskData.inputPath || !fs.existsSync(taskData.inputPath)) {
        console.warn(`[弹幕压制队列] 输入文件不存在，跳过: ${taskData.inputPath}`);
        return;
      }

      if (!taskData.assPath || !fs.existsSync(taskData.assPath)) {
        console.warn(`[弹幕压制队列] ASS 文件不存在，标记 skipped: recording_file_id=${taskData.recordingFileId}`);
        await this._updateBurnRecord(taskData.recordingFileId, 'skipped', null, 'ASS 文件不存在');
        return;
      }

      // 检查输出文件是否已存在
      if (!taskData.force && fs.existsSync(taskData.outputPath)) {
        console.log(`[弹幕压制队列] 输出文件已存在，跳过: ${path.basename(taskData.outputPath)}`);
        return;
      }

      await redis.lPush(QUEUE_KEY, JSON.stringify(taskData));
      // 维护路径索引集，供 _isFileInRedisQueue 快速查询
      await redis.sAdd(QUEUE_PATHS_SET, taskData.inputPath);
      await redis.sAdd(QUEUE_PATHS_SET, taskData.outputPath);
      await this._createBurnRecord(taskData);

      console.log(
        `[弹幕压制队列] 任务入队: ${path.basename(taskData.inputPath)} → ${path.basename(taskData.outputPath)}`
      );

      this.processQueue();
    } catch (err) {
      console.error('[弹幕压制队列] 入队失败:', err.message);
    }
  }

  /**
   * 处理队列
   */
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
          // 清理路径索引集
          redis.sRem(QUEUE_PATHS_SET, task.inputPath).catch(() => {});
          redis.sRem(QUEUE_PATHS_SET, task.outputPath).catch(() => {});
          this.decrementProcessingCount();
          this.processQueue();
        });
      }
    } catch (err) {
      console.error('[弹幕压制队列] 处理队列异常:', err.message);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 处理单个压制任务
   */
  async processTask(task) {
    // 自由压制任务走独立流程
    if (task.type === 'free-burn') {
      return this._processFreeBurnTask(task);
    }

    const {
      recordingFileId,
      sessionId,
      segmentIndex,
      inputPath,
      assPath,
      outputPath,
      force = false,
      useQsv = false,
    } = task;

    try {
      // 标记为处理中（清除旧 error）
      await pool.query(
        `UPDATE danmaku_burn_records SET status = 'processing', error = NULL, started_at = NOW() WHERE recording_file_id = $1`,
        [recordingFileId]
      );

      console.log(`[弹幕压制队列] 开始压制: ${path.basename(inputPath)}`);

      // 估算超时时间
      const timeoutMs = await burner.estimateTimeout(inputPath);

      const result = await burner.burn({
        inputPath,
        assPath,
        outputPath,
        force,
        useQsv,
        timeoutMs,
        sessionId,
        segmentIndex,
      });

      if (result.success) {
        console.log(`[弹幕压制队列] 压制成功: ${path.basename(outputPath)} (${(result.duration / 1000).toFixed(1)}s)`);

        // 更新压制记录（清除旧 error，防止重试成功后残留历史错误）
        await pool.query(
          `UPDATE danmaku_burn_records
           SET status = 'completed', output_path = $1, log_path = $2, error = NULL, completed_at = NOW()
           WHERE recording_file_id = $3`,
          [outputPath, result.logPath, recordingFileId]
        );
      } else {
        console.error(`[弹幕压制队列] 压制失败: ${result.error}`);
        if (result.logPath) {
          console.error(`[弹幕压制队列] 详细日志: ${result.logPath}`);
        }

        await pool.query(
          `UPDATE danmaku_burn_records
           SET status = 'failed', error = $1, log_path = $2, completed_at = NOW()
           WHERE recording_file_id = $3`,
          [result.error, result.logPath, recordingFileId]
        );

        // 清理失败产物
        try {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
          }
        } catch (_) {}
      }
    } catch (err) {
      console.error(`[弹幕压制队列] 处理任务异常: ${err.message}`);

      await pool
        .query(
          `UPDATE danmaku_burn_records SET status = 'failed', error = $1, completed_at = NOW() WHERE recording_file_id = $2`,
          [err.message, recordingFileId]
        )
        .catch(() => {});
    }
  }

  /**
   * 自由压制任务入队
   *
   * @param {Object} taskData
   * @param {number} taskData.taskId - danmaku_free_burn_records.id
   * @param {string} taskData.videoPath - 输入视频路径
   * @param {string} taskData.jsonlPath - 弹幕 JSONL 路径
   * @param {string} taskData.assPath - ASS 输出路径
   * @param {string} taskData.outputPath - 视频输出路径
   * @param {number} taskData.offsetMs - 时间偏移
   * @param {number} [taskData.width] - 视频宽度
   * @param {number} [taskData.height] - 视频高度
   */
  async enqueueFreeBurn(taskData) {
    try {
      if (!taskData.videoPath || !fs.existsSync(taskData.videoPath)) {
        console.warn(`[弹幕压制队列] 自由压制输入文件不存在: ${taskData.videoPath}`);
        await pool.query(
          "UPDATE danmaku_free_burn_records SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2",
          ['输入视频文件不存在', taskData.taskId]
        );
        return;
      }

      const task = { type: 'free-burn', ...taskData };
      await redis.lPush(QUEUE_KEY, JSON.stringify(task));
      await redis.sAdd(QUEUE_PATHS_SET, taskData.videoPath);
      await redis.sAdd(QUEUE_PATHS_SET, taskData.outputPath);

      console.log(`[弹幕压制队列] 自由压制入队: taskId=${taskData.taskId}`);
      this.processQueue();
    } catch (err) {
      console.error('[弹幕压制队列] 自由压制入队失败:', err.message);
    }
  }

  /**
   * 处理自由压制任务（先生成 ASS，再调用 burner.burn）
   */
  async _processFreeBurnTask(task) {
    const { taskId, videoPath, jsonlPath, assPath, outputPath, offsetMs, width, height } = task;

    try {
      // 确保输出目录存在
      fs.mkdirSync(path.dirname(assPath), { recursive: true });
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });

      // 生成 ASS
      const assResult = await danmakuAssGenerator.generateFromJsonl({
        jsonlPath,
        assPath,
        videoWidth: width,
        videoHeight: height,
        offsetMs,
      });
      if (!assResult.success) {
        throw new Error(`ASS 生成失败: ${assResult.error}`);
      }

      // 调用 burner 执行 FFmpeg（含 proc-log、字体检测、超时控制）
      const result = await burner.burn({
        inputPath: videoPath,
        assPath,
        outputPath,
        force: true,
        timeoutMs: 60 * 60 * 1000,
        sessionId: `free-${taskId}`,
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      await pool.query(
        "UPDATE danmaku_free_burn_records SET status = 'completed', output_path = $1, log_path = $2, completed_at = NOW() WHERE id = $3",
        [outputPath, result.logPath, taskId]
      );
      console.log(`[弹幕压制队列] 自由压制完成: taskId=${taskId} (log: ${result.logPath})`);
    } catch (err) {
      await pool
        .query(
          "UPDATE danmaku_free_burn_records SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2",
          [err.message, taskId]
        )
        .catch(() => {});
      console.error(`[弹幕压制队列] 自由压制失败: taskId=${taskId}`, err.message);
    } finally {
      redis.sRem(QUEUE_PATHS_SET, videoPath).catch(() => {});
      redis.sRem(QUEUE_PATHS_SET, outputPath).catch(() => {});
    }
  }

  /**
   * 为会话的所有分段批量入队
   *
   * @param {Object} params
   * @param {number} params.sessionId - 录制会话 ID
   * @param {boolean} [params.force=false] - 是否强制覆盖
   * @param {boolean} [params.useQsv=false] - 是否使用 QSV
   * @returns {Promise<number>} 入队数量
   */
  async enqueueSession(params) {
    const { sessionId, force = false, useQsv = false } = params;

    try {
      // 查询会话的所有录制文件
      const files = await pool.query(
        `SELECT rf.id, rf.file_path, rf.segment_index, rf.segment_start_ms, rf.segment_end_ms,
                rf.danmaku_ass_path
         FROM recording_files rf
         WHERE rf.session_id = $1
         ORDER BY rf.id ASC`,
        [sessionId]
      );

      if (files.rows.length === 0) {
        console.warn(`[弹幕压制队列] 会话 ${sessionId} 无录制文件`);
        return 0;
      }

      // 检查自动转码是否启用：若启用，跳过尚未转码的 FLV/TS 文件，
      // 避免使用原始路径入队后转码删除原文件导致压制找不到输入文件
      let autoTranscode = false;
      try {
        const atResult = await pool.query(`SELECT value FROM settings WHERE key = 'auto_transcode'`);
        autoTranscode = (atResult.rows[0]?.value || 'true') === 'true';
      } catch (_) {}

      let enqueued = 0;
      let skippedTranscode = 0;

      // 预查会话 output_dir（用于构建确定性 ASS 路径）
      const sessInfo = await pool.query(`SELECT output_dir FROM recording_sessions WHERE id = $1`, [sessionId]);
      const sessDir = sessInfo.rows[0]?.output_dir;

      for (const file of files.rows) {
        // ASS 文件路径：优先使用 DB 记录，其次使用确定性路径 danmaku/segments/{id}.ass
        let assPath = null;
        if (file.danmaku_ass_path && fs.existsSync(file.danmaku_ass_path)) {
          assPath = file.danmaku_ass_path;
        } else if (sessDir) {
          const detPath = path.join(sessDir, 'danmaku', 'segments', `${file.id}.ass`);
          if (fs.existsSync(detPath)) {
            assPath = detPath;
          }
        }
        if (!assPath) {
          console.log(`[弹幕压制队列] 分段 ${file.id} 无 ASS 文件，跳过`);
          continue;
        }

        // 跳过转码未完成的 FLV/TS 文件，避免使用原始路径入队后转码删除原文件导致压制找不到输入
        if (autoTranscode && SUPPORTED_TRANSCODE_EXT.test(file.file_path)) {
          const expectedMp4 = file.file_path.replace(/\.(ts|flv|m2ts)$/i, '.mp4');
          if (!fs.existsSync(expectedMp4)) {
            skippedTranscode++;
            console.log(`[弹幕压制队列] 分段 ${file.id} (${path.basename(file.file_path)}) 转码未完成，跳过批量入队`);
            continue;
          }
        }

        // 确定输入视频：优先使用转码后的 MP4，否则使用原始文件
        let inputPath = file.file_path;
        const mp4Path = file.file_path.replace(/\.(ts|flv|m2ts)$/i, '.mp4');
        if (fs.existsSync(mp4Path)) {
          inputPath = mp4Path;
        }

        // 生成输出路径（独立输出目录）
        const outputDir = path.join(getDanmakuOutputDir(), String(sessionId));
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        const outputFileName = `${path.basename(inputPath, path.extname(inputPath))}_danmaku.mp4`;
        const outputPath = path.join(outputDir, outputFileName);

        await this.enqueue({
          recordingFileId: file.id,
          sessionId,
          segmentIndex: file.segment_index,
          segmentStartMs: file.segment_start_ms || 0,
          segmentEndMs: file.segment_end_ms || 0,
          inputPath,
          assPath: assPath,
          outputPath,
          force,
          useQsv,
        });

        enqueued++;
      }

      console.log(
        `[弹幕压制队列] 会话 ${sessionId} 共 ${enqueued} 个分段入队` +
          (skippedTranscode > 0 ? `, ${skippedTranscode} 个待转码分段由转码完成后触发` : '')
      );
      return enqueued;
    } catch (err) {
      console.error(`[弹幕压制队列] 会话入队失败:`, err.message);
      return 0;
    }
  }

  // ========== 内部方法 ==========

  async _createBurnRecord(taskData) {
    try {
      await pool.query(
        `INSERT INTO danmaku_burn_records
         (session_id, recording_file_id, segment_index, segment_start_ms, segment_end_ms, input_path, ass_path, status, enqueued_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', NOW())
         ON CONFLICT (recording_file_id) DO UPDATE SET status = 'queued', error = NULL, enqueued_at = NOW()`,
        [
          taskData.sessionId,
          taskData.recordingFileId,
          taskData.segmentIndex || 0,
          taskData.segmentStartMs || 0,
          taskData.segmentEndMs || 0,
          taskData.inputPath,
          taskData.assPath,
        ]
      );
    } catch (err) {
      console.warn('[弹幕压制队列] 创建记录失败:', err.message);
    }
  }

  async _updateBurnRecord(recordingFileId, status, outputPath, error) {
    try {
      await pool.query(
        `UPDATE danmaku_burn_records
         SET status = $1, output_path = COALESCE($2, output_path), error = COALESCE($3, error), completed_at = NOW()
         WHERE recording_file_id = $4`,
        [status, outputPath, error, recordingFileId]
      );
    } catch (_) {}
  }

  // ========== 并发控制（与 TranscodeQueue 相同模式） ==========

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
}

module.exports = new DanmakuBurnQueue();
