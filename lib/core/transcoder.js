const { spawn } = require('child_process');
const fs = require('fs');
const { createProcLog } = require('../utils/proc-log');

class Transcoder {
  constructor() {
    this.name = 'transcoder';
  }

  /**
   * 快速转码视频文件，使用流复制方式实现高效转码
   *
   * 该函数通过 FFmpeg 执行视频转码操作，采用 copy 编码模式（不重新编码）以实现快速处理。
   * 设置了超时机制防止进程卡死，并记录详细的处理日志。
   *
   * @param {string} inputPath - 输入视频文件的路径
   * @param {string} outputPath - 输出视频文件的路径
   * @param {string|null} sessionId - 会话ID，用于日志追踪，可选参数，默认为 null
   * @returns {Promise<Object>} 返回一个 Promise 对象，解析为包含以下属性的对象：
   *   - success {boolean}: 转码是否成功
   *   - outputPath {string}: 输出文件路径（仅在成功时返回）
   *   - outputSize {number}: 输出文件大小，单位为字节（仅在成功时返回）
   *   - logPath {string}: 日志文件路径
   *   - error {string}: 错误信息（仅在失败时返回）
   */
  async fastTranscode(inputPath, outputPath, sessionId = null) {
    return new Promise((resolve) => {
      let timer = null; // 提前声明，避免引用错误

      const args = [
        '-nostdin',
        '-i',
        inputPath,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-y',
        '-loglevel',
        'error',
        outputPath,
      ];

      const procLog = createProcLog('transcode', sessionId);
      const { stream, logCommand } = procLog;
      logCommand('ffmpeg', args);

      const proc = spawn('ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'pipe'], // 注意：stderr 需要捕获
        detached: false,
      });

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (procLog) procLog.destroy();
      };

      // 增加错误监听：防止命令不存在或权限问题
      proc.on('error', (err) => {
        cleanup();
        resolve({ success: false, error: `Spawn error: ${err.message}` });
      });

      timer = setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGTERM');
          setTimeout(() => {
            if (!proc.killed) proc.kill('SIGKILL');
          }, 2000);
          cleanup();
          resolve({ success: false, error: 'Fast transcode timeout & killed' });
        }
      }, 120000);

      if (proc.stderr) {
        proc.stderr.on('data', (chunk) => {
          if (!stream.write(chunk)) {
            // 如果缓冲区满了，暂停读取直到 drain
            proc.stderr.pause();
            stream.once('drain', () => proc.stderr.resume());
          }
        });
      }

      proc.on('close', (code) => {
        cleanup();
        if (code === 0) {
          let outputSize = 0;
          try {
            outputSize = fs.statSync(outputPath).size;
          } catch (_) {}
          resolve({ success: true, outputPath, outputSize, logPath: procLog.logPath });
        } else {
          resolve({ success: false, error: `Code ${code}`, logPath: procLog.logPath });
        }
      });
    });
  }
}

module.exports = new Transcoder();
