const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createProcLog } = require('../utils/proc-log');

/**
 * danmaku-burner.js — FFmpeg 弹幕压制器
 *
 * 将 ASS 弹幕字幕压制到视频上，输出 *_danmaku.mp4。
 * 支持 CPU 编码 (libx264) 和 Intel QSV 硬件编码 (h264_qsv)。
 */
class DanmakuBurner {
  constructor() {
    this.ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
    this.ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
  }

  /**
   * 检查 FFmpeg 能力
   *
   * @returns {Promise<{ subtitlesFilter: boolean, qsvEncoder: boolean, vaapiEncoder: boolean, libx264: boolean }>}
   */
  async probeCapabilities() {
    const result = {
      subtitlesFilter: false,
      qsvEncoder: false,
      vaapiEncoder: false,
      libx264: false,
      fontconfig: false,
    };

    try {
      const filterOutput = await this._execCapture(this.ffmpegPath, ['-filters']);
      result.subtitlesFilter = /subtitles|ass/i.test(filterOutput);
    } catch (_) {}

    try {
      const encoderOutput = await this._execCapture(this.ffmpegPath, ['-encoders']);
      result.qsvEncoder = /h264_qsv/i.test(encoderOutput);
      result.vaapiEncoder = /h264_vaapi/i.test(encoderOutput);
      result.libx264 = /libx264/i.test(encoderOutput);
    } catch (_) {}

    return result;
  }

  /**
   * 执行弹幕压制
   *
   * @param {Object} params
   * @param {string} params.inputPath - 输入视频路径
   * @param {string} params.assPath - ASS 字幕文件路径
   * @param {string} params.outputPath - 输出视频路径
   * @param {boolean} [params.force=false] - 是否强制覆盖已有文件
   * @param {boolean} [params.useQsv=false] - 是否使用 Intel QSV
   * @param {number} [params.timeoutMs] - 超时时间
   * @param {number} [params.sessionId] - 会话 ID（用于日志文件命名）
   * @returns {Promise<{ success: boolean, outputPath: string, duration: number, error: string|null, logPath: string|null }>}
   */
  async burn(params) {
    let {
      inputPath,
      assPath,
      outputPath,
      force = false,
      useQsv = false,
      timeoutMs = 30 * 60 * 1000, // 默认 30 分钟
      sessionId = null,
    } = params;

    // 统一解析为绝对路径，避免 FFmpeg CWD 与 Node.js 不一致导致找不到文件
    inputPath = path.resolve(inputPath);
    assPath = path.resolve(assPath);
    outputPath = path.resolve(outputPath);

    const startTime = Date.now();

    // 前置检查
    if (!fs.existsSync(inputPath)) {
      return { success: false, outputPath, duration: 0, error: `输入文件不存在: ${inputPath}`, logPath: null };
    }

    if (!fs.existsSync(assPath)) {
      return { success: false, outputPath, duration: 0, error: `ASS 文件不存在: ${assPath}`, logPath: null };
    }

    // 检查 ASS 文件是否为空（无事件行）
    try {
      const assContent = fs.readFileSync(assPath, 'utf-8');
      const eventSection = assContent.indexOf('[Events]');
      if (eventSection === -1 || assContent.slice(eventSection).split('\n').length <= 2) {
        return { success: false, outputPath, duration: 0, error: 'ASS 文件无弹幕事件', logPath: null };
      }
    } catch (err) {
      return { success: false, outputPath, duration: 0, error: `ASS 文件读取失败: ${err.message}`, logPath: null };
    }

    if (!force && fs.existsSync(outputPath)) {
      return { success: false, outputPath, duration: 0, error: `输出文件已存在（使用 force=true 覆盖）`, logPath: null };
    }

    // 构建 FFmpeg 命令
    const args = this._buildArgs(inputPath, assPath, outputPath, useQsv);

    // 创建 proc-log：记录命令和完整 stderr
    const logId = sessionId ? `s${sessionId}_${path.basename(inputPath, path.extname(inputPath))}` : null;
    const procLog = createProcLog('danmaku_burn', logId);
    procLog.logCommand(this.ffmpegPath, args);

    console.log(`[DanmakuBurner] 开始压制: ${path.basename(inputPath)} → log: ${path.basename(procLog.logPath)}`);

    return new Promise((resolve) => {
      const proc = spawn(this.ffmpegPath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, NICE: '10' },
      });

      let killed = false;

      // 超时控制
      const timeout = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
      }, timeoutMs);

      // stderr 同时写入 proc-log 和内存（用于错误摘要）
      let stderrTail = '';
      proc.stderr.on('data', (chunk) => {
        procLog.stream.write(chunk);
        // 只保留最后 2KB 用于错误消息
        stderrTail += chunk.toString();
        if (stderrTail.length > 2048) stderrTail = stderrTail.slice(-2048);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        procLog.destroy();
        resolve({
          success: false,
          outputPath,
          duration: Date.now() - startTime,
          error: `FFmpeg 启动失败: ${err.message}`,
          logPath: procLog.logPath,
        });
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        procLog.destroy();

        if (killed) {
          resolve({
            success: false,
            outputPath,
            duration: Date.now() - startTime,
            error: '压制超时被终止',
            logPath: procLog.logPath,
          });
          return;
        }

        if (code !== 0) {
          const errorLines = stderrTail.split('\n').slice(-5).join('\n');
          resolve({
            success: false,
            outputPath,
            duration: Date.now() - startTime,
            error: `FFmpeg 退出码 ${code}: ${errorLines}`,
            logPath: procLog.logPath,
          });
          return;
        }

        // 验证输出文件
        if (!fs.existsSync(outputPath)) {
          resolve({
            success: false,
            outputPath,
            duration: Date.now() - startTime,
            error: '输出文件不存在',
            logPath: procLog.logPath,
          });
          return;
        }

        const duration = Date.now() - startTime;
        const outputSize = fs.statSync(outputPath).size;
        console.log(
          `[DanmakuBurner] 压制完成: ${path.basename(outputPath)} (${(outputSize / 1024 / 1024).toFixed(1)}MB, ${(duration / 1000).toFixed(1)}s)`
        );

        resolve({
          success: true,
          outputPath,
          duration,
          outputSize,
          error: null,
          logPath: procLog.logPath,
        });
      });
    });
  }

  /**
   * 构建 FFmpeg 参数
   */
  _buildArgs(inputPath, assPath, outputPath, useQsv) {
    const args = ['-i', inputPath, '-vf', this._buildFilterChain(assPath)];

    if (useQsv) {
      args.push('-c:v', 'h264_qsv', '-global_quality', '23');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
    }

    args.push('-c:a', 'copy', '-movflags', '+faststart', '-y', outputPath);

    return args;
  }

  /**
   * 构建 FFmpeg 滤镜链
   * 使用 subtitles 滤镜渲染 ASS 字幕
   *
   * 注意：FFmpeg subtitles 滤镜要求绝对路径，且路径中的
   * \ : ' [ ] 需要反斜杠转义（filtergraph 语法要求）。
   */
  _buildFilterChain(assPath) {
    // Windows 反斜杠转正斜杠
    let escapedPath = assPath.replace(/\\/g, '/');
    // 解析为绝对路径，确保 FFmpeg 能找到文件
    escapedPath = path.resolve(escapedPath);

    // FFmpeg filtergraph 特殊字符转义（在单引号内仍需转义）
    escapedPath = escapedPath
      .replace(/\\/g, '\\\\')  // \ → \\
      .replace(/:/g, '\\:')    // : → \:
      .replace(/'/g, "\\'")    // ' → \'
      .replace(/\[/g, '\\[')   // [ → \[
      .replace(/\]/g, '\\]');  // ] → \]

    return `subtitles='${escapedPath}'`;
  }

  /**
   * 获取视频时长（毫秒）
   *
   * @param {string} videoPath - 视频文件路径
   * @returns {Promise<number>} 时长毫秒数
   */
  async getVideoDurationMs(videoPath) {
    try {
      const output = await this._execCapture(this.ffprobePath, [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        videoPath,
      ]);
      const seconds = parseFloat(output.trim());
      return isNaN(seconds) ? 0 : Math.round(seconds * 1000);
    } catch (_) {
      return 0;
    }
  }

  /**
   * 估算超时时间
   * 公式：max(30 分钟, 视频时长 * 4)
   */
  async estimateTimeout(videoPath) {
    const durationMs = await this.getVideoDurationMs(videoPath);
    const minTimeout = 30 * 60 * 1000; // 30 分钟
    return Math.max(minTimeout, durationMs * 4);
  }

  /**
   * 执行命令并捕获输出
   */
  _execCapture(cmd, args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout + stderr);
        } else {
          reject(new Error(`Exit code ${code}: ${stderr.slice(-200)}`));
        }
      });
    });
  }
}

module.exports = new DanmakuBurner();
