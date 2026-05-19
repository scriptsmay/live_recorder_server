const { spawn } = require('child_process');
const { createProcLog } = require('../utils/proc-log');

class Segmenter {
  constructor() {
    this.name = 'segmenter';
  }

  /**
   * 切割并转码
   * @param {string} inputPath - 输入文件
   * @param {string} outputPattern - 输出文件名格式，如: output_%03d.mp4
   * @param {Object} options - 配置项 (时长, 编码器)
   */
  async segmentAndTranscode(inputPath, outputPattern, options = {}, sessionId = null) {
    const {
      segmentTime = 60, // 每个切片时长(秒)
      videoCodec = 'libx264', // 如果不需要转码，可设为 'copy'
      audioCodec = 'aac',
      bitrate = '2000k',
    } = options;

    return new Promise((resolve) => {
      // 核心命令组合：转码参数 + 分片参数
      const args = [
        '-i',
        inputPath,
        '-c:v',
        videoCodec,
        '-c:a',
        audioCodec,
        '-b:v',
        bitrate,
        '-f',
        'segment', // 指定分片复用器
        '-segment_time',
        String(segmentTime),
        '-reset_timestamps',
        '1',
        '-y',
        outputPattern, // 必须是带格式的路径，如 %03d.mp4
      ];

      const procLog = createProcLog('segmenter', sessionId);
      const { stream, logCommand } = procLog;
      logCommand('ffmpeg', args);

      const proc = spawn('ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      if (proc.stderr) {
        proc.stderr.on('data', (chunk) => stream.write(chunk));
      }

      proc.on('close', (code) => {
        // 录制结束时，释放日志资源
        procLog.destroy();
        if (code === 0) {
          resolve({ success: true, logPath: procLog.logPath });
        } else {
          resolve({ success: false, error: `Segmentation failed with code ${code}` });
        }
      });
    });
  }
}

module.exports = new Segmenter();
