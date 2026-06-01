const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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
   * @returns {Promise<{ success: boolean, outputPath: string, duration: number, error: string|null }>}
   */
  async burn(params) {
    const {
      inputPath,
      assPath,
      outputPath,
      force = false,
      useQsv = false,
      timeoutMs = 30 * 60 * 1000, // 默认 30 分钟
    } = params;

    const startTime = Date.now();

    // 前置检查
    if (!fs.existsSync(inputPath)) {
      return { success: false, outputPath, duration: 0, error: `输入文件不存在: ${inputPath}` };
    }

    if (!fs.existsSync(assPath)) {
      return { success: false, outputPath, duration: 0, error: `ASS 文件不存在: ${assPath}` };
    }

    // 检查 ASS 文件是否为空（无事件行）
    try {
      const assContent = fs.readFileSync(assPath, 'utf-8');
      const eventSection = assContent.indexOf('[Events]');
      if (eventSection === -1 || assContent.slice(eventSection).split('\n').length <= 2) {
        return { success: false, outputPath, duration: 0, error: 'ASS 文件无弹幕事件' };
      }
    } catch (err) {
      return { success: false, outputPath, duration: 0, error: `ASS 文件读取失败: ${err.message}` };
    }

    if (!force && fs.existsSync(outputPath)) {
      return { success: false, outputPath, duration: 0, error: `输出文件已存在（使用 force=true 覆盖）` };
    }

    // 构建 FFmpeg 命令
    const args = this._buildArgs(inputPath, assPath, outputPath, useQsv);

    console.log(`[DanmakuBurner] 开始压制: ${path.basename(inputPath)}`);
    console.log(`[DanmakuBurner] 命令: ${this.ffmpegPath} ${args.join(' ')}`);

    return new Promise((resolve) => {
      const proc = spawn(this.ffmpegPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NICE: '10' },
      });

      let stderr = '';
      let killed = false;

      // 超时控制
      const timeout = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
      }, timeoutMs);

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          outputPath,
          duration: Date.now() - startTime,
          error: `FFmpeg 启动失败: ${err.message}`,
        });
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);

        if (killed) {
          resolve({
            success: false,
            outputPath,
            duration: Date.now() - startTime,
            error: '压制超时被终止',
          });
          return;
        }

        if (code !== 0) {
          // 提取 FFmpeg 错误信息
          const errorLines = stderr.split('\n').slice(-5).join('\n');
          resolve({
            success: false,
            outputPath,
            duration: Date.now() - startTime,
            error: `FFmpeg 退出码 ${code}: ${errorLines}`,
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
   */
  _buildFilterChain(assPath) {
    // FFmpeg subtitles 滤镜需要使用绝对路径，并且转义特殊字符
    const escapedPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

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
