const { spawn } = require('child_process');
const fs = require('fs');
const { createProcLog } = require('../utils/proc-log');

class Transcoder {
  constructor() {
    this.name = 'transcoder';
  }

  async fastTranscode(inputPath, outputPath, sessionId = null) {
    return new Promise((resolve) => {
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
