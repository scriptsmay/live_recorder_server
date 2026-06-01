const { spawn } = require('child_process');
const fs = require('fs');
const { createProcLog } = require('../utils/proc-log');

/**
 * 转码器类，提供视频文件的快速转码功能
 * 使用 FFmpeg 进行无损复制转码，优化文件结构以支持流式播放
 */
class Transcoder {
  constructor() {
    this.name = 'transcoder';
  }

  /**
   * 执行快速转码操作
   * 使用 copy 编码模式进行无损转码，并添加 faststart 标志优化 MP4 文件结构
   *
   * @param {string} inputPath - 输入视频文件的完整路径
   * @param {string} outputPath - 输出视频文件的完整路径
   * @param {string|null} sessionId - 会话ID，用于日志追踪和归档，可选参数
   * @returns {Promise<Object>} 返回转码结果的 Promise 对象
   * @returns {boolean} return.success - 转码是否成功
   * @returns {string} [return.outputPath] - 成功时返回输出文件路径
   * @returns {number} [return.outputSize] - 成功时返回输出文件大小（字节）
   * @returns {string} [return.error] - 失败时返回错误信息
   * @returns {string} return.logPath - 始终返回日志文件路径
   */
  async fastTranscode(inputPath, outputPath, sessionId = null) {
    return new Promise((resolve) => {
      // 构建 FFmpeg 命令参数：无损复制编码、启用 faststart、覆盖输出文件
      const args = ['-i', inputPath, '-c', 'copy', '-movflags', '+faststart', '-y', outputPath];

      const procLog = createProcLog('transcode', sessionId);
      const { stream, logCommand } = procLog;
      logCommand('ffmpeg', args);

      const proc = spawn('ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: false,
      });

      if (proc.stderr) {
        proc.stderr.on('data', (chunk) => stream.write(chunk));
      }

      proc.on('close', (code) => {
        // 结束时，释放日志资源
        procLog.destroy();
        if (code === 0) {
          let outputSize = 0;
          try {
            outputSize = fs.statSync(outputPath).size;
          } catch (_) {}
          resolve({ success: true, outputPath, outputSize, logPath: procLog.logPath });
        } else {
          resolve({ success: false, error: `Fast transcode failed with code ${code}`, logPath: procLog.logPath });
        }
      });

      // 设置超时保护，防止转码过程卡死
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill();
          resolve({ success: false, error: 'Fast transcode timeout' });
        }
      }, 120000);
    });
  }
}

module.exports = new Transcoder();
