const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const pool = require('../../db/index');
const { createProcLog } = require('../utils/proc-log');

const PLAYLIST_NAME = 'playlist.m3u8';

class HLSGenerator {
  constructor() {
    this.name = 'hls-generator';
  }

  async generate(inputPath, outputDir, sessionId = null) {
    return new Promise((resolve) => {
      const fileName = path.basename(inputPath, path.extname(inputPath));
      const hlsDir = path.join(outputDir, `hls_${fileName}`);

      if (!fs.existsSync(hlsDir)) {
        fs.mkdirSync(hlsDir, { recursive: true });
      }

      const args = [
        '-i',
        inputPath,
        '-c',
        'copy',
        '-f',
        'hls',
        '-hls_time',
        '10',
        '-hls_list_size',
        '0',
        '-hls_segment_filename',
        path.join(hlsDir, 'segment_%03d.ts'),
        path.join(hlsDir, PLAYLIST_NAME),
      ];

      // 日志命名：hls_{sessionId}_{inputBasename}.log
      const inputBasename = path.basename(inputPath, path.extname(inputPath));
      let logId = null;
      if (sessionId != null) {
        logId = `${sessionId}_${inputBasename}`;
      } else {
        logId = `${inputBasename}`;
      }

      const procLog = createProcLog('hls', logId);
      const { stream, logPath } = procLog;
      logCommand('ffmpeg', args);

      const proc = spawn('ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: false,
      });

      if (proc.stderr) {
        proc.stderr.on('data', (chunk) => stream.write(chunk));
      }

      proc.on('close', (code) => {
        procLog.destroy();
        if (code === 0) {
          const playlistPath = path.join(hlsDir, PLAYLIST_NAME);
          let fileSize = 0;
          try {
            const stat = fs.statSync(playlistPath);
            fileSize = stat.size;
          } catch (_) {}
          resolve({ success: true, playlistPath, hlsDir, fileSize, logPath });
        } else {
          resolve({ success: false, error: `HLS generation failed with code ${code}`, logPath });
        }
      });

      setTimeout(() => {
        if (!proc.killed) {
          proc.kill();
          resolve({ success: false, error: 'HLS generation timeout' });
        }
      }, 300000);
    });
  }

  async generateForRecording(recordingId) {
    try {
      const result = await pool.query(
        `SELECT file_path, is_hls_ready, hls_playlist_path, session_id FROM recording_files WHERE id = $1`,
        [recordingId]
      );

      if (result.rows.length === 0) {
        return { success: false, error: 'Recording not found' };
      }

      const recording = result.rows[0];

      if (recording.is_hls_ready && recording.hls_playlist_path) {
        const exists = fs.existsSync(recording.hls_playlist_path);
        if (exists) {
          return { success: true, playlistPath: recording.hls_playlist_path, alreadyExists: true };
        }
      }

      if (!recording.file_path || !fs.existsSync(recording.file_path)) {
        return { success: false, error: 'Source file not found' };
      }

      const inputPath = recording.file_path;
      const outputDir = path.dirname(inputPath);

      const genResult = await this.generate(inputPath, outputDir, recording.session_id);

      if (genResult.success) {
        await this.updateRecordingHLSStatus(recordingId, genResult.playlistPath);
      }

      return genResult;
    } catch (err) {
      console.error('[HLS Generator] Error:', err);
      return { success: false, error: err.message };
    }
  }

  async updateRecordingHLSStatus(recordingId, playlistPath) {
    try {
      await pool.query(
        `UPDATE recording_files SET is_hls_ready = TRUE, hls_playlist_path = $1, hls_generated_at = NOW() WHERE id = $2`,
        [playlistPath, recordingId]
      );
    } catch (err) {
      console.error('[HLS Generator] Update status failed:', err);
    }
  }

  isHLSAvailable(playlistPath) {
    if (!playlistPath || !fs.existsSync(playlistPath)) {
      return false;
    }
    const stat = fs.statSync(playlistPath);
    return stat.size > 0;
  }

  async cleanupOldFiles(days = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const result = await pool.query(
        `SELECT id, hls_playlist_path, hls_generated_at FROM recording_files WHERE is_hls_ready = TRUE AND hls_generated_at < $1`,
        [cutoffDate]
      );

      let deletedCount = 0;
      for (const row of result.rows) {
        if (row.hls_playlist_path) {
          const hlsDir = path.dirname(row.hls_playlist_path);
          try {
            if (fs.existsSync(hlsDir)) {
              fs.rmSync(hlsDir, { recursive: true, force: true });
              deletedCount++;
            }
          } catch (_) {}
        }
      }

      console.log(`[HLS Generator] Cleaned up ${deletedCount} old HLS directories`);
      return { deletedCount };
    } catch (err) {
      console.error('[HLS Generator] Cleanup failed:', err);
      return { deletedCount: 0, error: err.message };
    }
  }
}

function logCommand(command, args) {
  console.log('[HLS]', command, args.join(' '));
}

module.exports = new HLSGenerator();
