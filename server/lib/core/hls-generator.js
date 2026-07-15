const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const pool = require('../../db/index');
const { createProcLog } = require('../utils/proc-log');
const { getDirectoryStats } = require('../utils/directory-stats');

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

  async generateForRecording(recordingId, options = {}) {
    const { manual = false } = options;
    let transitionedToGenerating = false;
    try {
      const result = await pool.query(
        `SELECT file_path, is_hls_ready, hls_playlist_path, hls_status, session_id
         FROM recording_files WHERE id = $1`,
        [recordingId]
      );

      if (result.rows.length === 0) {
        return { success: false, error: 'Recording not found' };
      }

      const recording = result.rows[0];
      const currentStatus =
        recording.hls_status || (recording.is_hls_ready && recording.hls_playlist_path ? 'ready' : 'pending');

      if (currentStatus === 'ready' && recording.hls_playlist_path) {
        const exists = fs.existsSync(recording.hls_playlist_path);
        if (exists) {
          return { success: true, playlistPath: recording.hls_playlist_path, alreadyExists: true };
        }

        await pool.query(
          `UPDATE recording_files
           SET hls_status = 'missing', is_hls_ready = FALSE
           WHERE id = $1 AND hls_status = 'ready'`,
          [recordingId]
        );
        if (!manual) {
          return { success: false, error: 'HLS playlist is missing; manual regeneration is required' };
        }
      }

      if (!recording.file_path || !fs.existsSync(recording.file_path)) {
        return { success: false, error: 'Source file not found' };
      }

      const allowedStatuses = manual ? ['pending', 'expired', 'deleted', 'missing', 'failed', 'ready'] : ['pending'];
      const transition = await pool.query(
        `UPDATE recording_files
         SET hls_status = 'generating', is_hls_ready = FALSE
         WHERE id = $1 AND hls_status = ANY($2::varchar[])
         RETURNING id`,
        [recordingId, allowedStatuses]
      );
      if (transition.rows.length === 0) {
        return { success: false, error: `HLS cannot be generated from status ${currentStatus}` };
      }
      transitionedToGenerating = true;

      const inputPath = recording.file_path;
      const outputDir = path.dirname(inputPath);

      const genResult = await this.generate(inputPath, outputDir, recording.session_id);

      if (genResult.success) {
        await this.updateRecordingHLSStatus(recordingId, genResult.playlistPath);
      } else {
        await this.markGenerationFailed(recordingId);
      }

      return genResult;
    } catch (err) {
      console.error('[HLS Generator] Error:', err);
      if (transitionedToGenerating) {
        await this.markGenerationFailed(recordingId).catch((statusErr) => {
          console.error('[HLS Generator] Failed to persist failure status:', statusErr);
        });
      }
      return { success: false, error: err.message };
    }
  }

  async updateRecordingHLSStatus(recordingId, playlistPath) {
    try {
      await pool.query(
        `UPDATE recording_files
         SET is_hls_ready = TRUE,
             hls_playlist_path = $1,
             hls_generated_at = NOW(),
             hls_deleted_at = NULL,
             hls_status = 'ready'
         WHERE id = $2`,
        [playlistPath, recordingId]
      );

      const hlsDir = path.dirname(playlistPath);
      const stats = await getDirectoryStats(hlsDir);
      const recordingResult = await pool.query(`SELECT session_id FROM recording_files WHERE id = $1`, [recordingId]);
      const sessionId = recordingResult.rows[0]?.session_id;
      await pool.query(
        `INSERT INTO managed_files
          (category, file_type, source_table, source_id, group_id, file_path,
           file_name, extension, file_size, mtime, exists_on_disk, status,
           safe_to_delete, delete_block_reason, deleted_at)
         VALUES ('recording', 'hls_directory', 'recording_files', $1, $2, $3,
                 $4, '', $5, $6, true, 'active', true, NULL, NULL)
         ON CONFLICT (file_path) DO UPDATE SET
           source_table = 'recording_files', source_id = EXCLUDED.source_id,
           group_id = EXCLUDED.group_id, file_size = EXCLUDED.file_size,
           mtime = EXCLUDED.mtime, exists_on_disk = true, status = 'active',
           safe_to_delete = true, delete_block_reason = NULL, deleted_at = NULL,
           updated_at = NOW()`,
        [recordingId, sessionId ? String(sessionId) : null, hlsDir, path.basename(hlsDir), stats.size, stats.mtime]
      );
    } catch (err) {
      console.error('[HLS Generator] Update status failed:', err);
      throw err;
    }
  }

  async markGenerationFailed(recordingId) {
    await pool.query(
      `UPDATE recording_files
       SET hls_status = 'failed', is_hls_ready = FALSE
       WHERE id = $1 AND hls_status = 'generating'`,
      [recordingId]
    );
  }

  isHLSAvailable(playlistPath) {
    if (!playlistPath || !fs.existsSync(playlistPath)) {
      return false;
    }
    const stat = fs.statSync(playlistPath);
    return stat.size > 0;
  }
}

function logCommand(command, args) {
  console.log('[HLS]', command, args.join(' '));
}

module.exports = new HLSGenerator();
