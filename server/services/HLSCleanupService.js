const fs = require('fs');
const path = require('path');
const pool = require('../db/index');
const DataService = require('./DataService');
const { resolveAndValidate } = require('../lib/utils/path-safety');
const { getDirectoryStats } = require('../lib/utils/directory-stats');

const DEFAULT_RETENTION_DAYS = 30;
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ADVISORY_LOCK_NAMESPACE = 41010;

class HLSCleanupService {
  constructor() {
    this.firstRunTimer = null;
    this.intervalTimer = null;
  }

  async deleteForRecording(recordingFileId, reason = 'user', operator = 'user') {
    if (!['retention', 'user'].includes(reason)) {
      throw new Error(`Unsupported HLS deletion reason: ${reason}`);
    }

    const finalStatus = reason === 'retention' ? 'expired' : 'deleted';
    const client = await pool.connect();
    let locked = false;
    let hlsDir = null;
    let managedFileId = null;
    let estimatedSize = 0;

    try {
      await client.query(`SELECT pg_advisory_lock($1, $2)`, [ADVISORY_LOCK_NAMESPACE, recordingFileId]);
      locked = true;

      const { rows } = await client.query(
        `SELECT rf.id, rf.session_id, rf.status AS recording_status, rf.hls_status,
                rf.hls_playlist_path, rs.status AS session_status,
                mf.id AS managed_file_id, mf.file_size AS managed_file_size
         FROM recording_files rf
         LEFT JOIN recording_sessions rs ON rs.id = rf.session_id
         LEFT JOIN managed_files mf
           ON mf.source_table = 'recording_files'
          AND mf.source_id = rf.id
          AND mf.file_type = 'hls_directory'
         WHERE rf.id = $1`,
        [recordingFileId]
      );

      if (rows.length === 0) {
        return { result: 'blocked', error: 'recording_file_not_found', actual_release_size: 0 };
      }

      const recording = rows[0];
      managedFileId = recording.managed_file_id;
      estimatedSize = Number(recording.managed_file_size || 0);

      if (['expired', 'deleted'].includes(recording.hls_status)) {
        return {
          file_id: managedFileId,
          recording_file_id: recordingFileId,
          result: 'success_noop',
          actual_release_size: 0,
        };
      }
      if (recording.hls_status !== 'ready') {
        return {
          file_id: managedFileId,
          recording_file_id: recordingFileId,
          result: 'blocked',
          error: `hls_status_${recording.hls_status}`,
          actual_release_size: 0,
        };
      }
      if (recording.session_status === 'recording') {
        return {
          file_id: managedFileId,
          recording_file_id: recordingFileId,
          result: 'blocked',
          error: 'active_recording_session',
          actual_release_size: 0,
        };
      }
      if (!recording.hls_playlist_path) {
        return {
          file_id: managedFileId,
          recording_file_id: recordingFileId,
          result: 'blocked',
          error: 'hls_playlist_path_missing',
          actual_release_size: 0,
        };
      }

      hlsDir = path.dirname(recording.hls_playlist_path);
      const pathCheck = await resolveAndValidate(hlsDir);
      if (!pathCheck.valid) {
        return {
          file_id: managedFileId,
          recording_file_id: recordingFileId,
          file_path: hlsDir,
          result: 'blocked',
          error: pathCheck.reason,
          actual_release_size: 0,
        };
      }

      const transition = await client.query(
        `UPDATE recording_files
         SET hls_status = 'deleting', is_hls_ready = FALSE
         WHERE id = $1 AND hls_status = 'ready'`,
        [recordingFileId]
      );
      if (transition.rowCount !== 1) {
        return {
          file_id: managedFileId,
          recording_file_id: recordingFileId,
          file_path: hlsDir,
          result: 'blocked',
          error: 'hls_status_changed',
          actual_release_size: 0,
        };
      }
      await client.query(
        `UPDATE managed_files SET status = 'deleting', updated_at = NOW()
         WHERE source_table = 'recording_files' AND source_id = $1 AND file_type = 'hls_directory'`,
        [recordingFileId]
      );

      let diskResult = 'success';
      let actualSize = 0;
      try {
        const stats = await getDirectoryStats(hlsDir);
        estimatedSize = stats.size;
        actualSize = stats.size;
        await fs.promises.rm(hlsDir, { recursive: true, force: true });
      } catch (err) {
        if (err.code === 'ENOENT') {
          diskResult = 'success_noop';
        } else {
          await this._restoreReadyAfterFailure(client, recordingFileId, err, {
            managedFileId,
            hlsDir,
            estimatedSize,
            operator,
            reason,
          });
          console.error(`[HLS Cleanup] 删除失败 recording_file_id=${recordingFileId}: ${err.message}`);
          return {
            file_id: managedFileId,
            recording_file_id: recordingFileId,
            file_path: hlsDir,
            result: 'failed',
            error: err.message,
            actual_release_size: 0,
          };
        }
      }

      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE recording_files
           SET hls_status = $1, is_hls_ready = FALSE, hls_playlist_path = NULL,
               hls_deleted_at = NOW()
           WHERE id = $2`,
          [finalStatus, recordingFileId]
        );
        await client.query(
          `UPDATE managed_files
           SET status = 'deleted', exists_on_disk = FALSE, file_size = $1,
               deleted_at = NOW(), updated_at = NOW()
           WHERE source_table = 'recording_files' AND source_id = $2
             AND file_type = 'hls_directory'`,
          [estimatedSize, recordingFileId]
        );
        await this._writeAudit(client, {
          managedFileId,
          recordingFileId,
          hlsDir,
          estimatedSize,
          actualSize,
          operator,
          reason,
          result: diskResult,
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        // The directory is already gone. Converge the lifecycle state with a
        // separate best-effort write so the watchdog can never recreate it.
        await client.query(
          `UPDATE recording_files
           SET hls_status = $1, is_hls_ready = FALSE, hls_playlist_path = NULL,
               hls_deleted_at = NOW()
           WHERE id = $2`,
          [finalStatus, recordingFileId]
        );
        await client.query(
          `UPDATE managed_files
           SET status = 'deleted', exists_on_disk = FALSE, file_size = $1,
               deleted_at = NOW(), updated_at = NOW()
           WHERE source_table = 'recording_files' AND source_id = $2
             AND file_type = 'hls_directory'`,
          [estimatedSize, recordingFileId]
        );
        throw err;
      }

      return {
        file_id: managedFileId,
        recording_file_id: recordingFileId,
        file_path: hlsDir,
        result: diskResult,
        actual_release_size: actualSize,
        hls_status: finalStatus,
      };
    } finally {
      if (locked) {
        try {
          await client.query(`SELECT pg_advisory_unlock($1, $2)`, [ADVISORY_LOCK_NAMESPACE, recordingFileId]);
        } catch (err) {
          console.warn(`[HLS Cleanup] advisory unlock 失败 recording_file_id=${recordingFileId}: ${err.message}`);
        }
      }
      client.release();
    }
  }

  async _restoreReadyAfterFailure(client, recordingFileId, error, audit) {
    await client.query(`UPDATE recording_files SET hls_status = 'ready', is_hls_ready = TRUE WHERE id = $1`, [
      recordingFileId,
    ]);
    await client.query(
      `UPDATE managed_files SET status = 'active', updated_at = NOW()
       WHERE source_table = 'recording_files' AND source_id = $1 AND file_type = 'hls_directory'`,
      [recordingFileId]
    );
    await this._writeAudit(client, {
      ...audit,
      recordingFileId,
      result: 'failed',
      actualSize: 0,
      error: error.message,
    });
  }

  async _writeAudit(client, data) {
    await client.query(
      `INSERT INTO file_delete_audit_logs
        (file_id, file_path, file_size, category, source_table, source_id,
         operator, deleted_by, action, result, estimated_release_size,
         actual_release_size, delete_reason, recording_file_id, error_message)
       VALUES ($1, $2, $3, 'recording', 'recording_files', $4,
               $5, $6, 'hls_delete', $7, $8, $9, $10, $4, $11)`,
      [
        data.managedFileId || null,
        data.hlsDir,
        data.estimatedSize || 0,
        data.recordingFileId,
        data.operator,
        data.reason === 'retention' ? 'system' : 'user',
        data.result,
        data.estimatedSize || 0,
        data.actualSize || 0,
        data.reason,
        data.error || null,
      ]
    );
  }

  async cleanupExpired(retentionDays) {
    let rawValue = retentionDays;
    if (rawValue === undefined) {
      rawValue = await DataService.getSetting('hls_cleanup_days', String(DEFAULT_RETENTION_DAYS));
    }

    const hasValue =
      (typeof rawValue === 'number' && Number.isFinite(rawValue)) ||
      (typeof rawValue === 'string' && rawValue.trim() !== '');
    const days = hasValue ? Number(rawValue) : Number.NaN;
    const normalizedDays = Number.isInteger(days) && days >= 0 ? days : DEFAULT_RETENTION_DAYS;
    if (!Number.isInteger(days) || days < 0) {
      console.warn(`[HLS Cleanup] 非法 hls_cleanup_days=${rawValue}，回退为 ${DEFAULT_RETENTION_DAYS}`);
    }
    if (normalizedDays === 0) {
      console.debug('[HLS Cleanup] hls_cleanup_days=0，自动清理已禁用');
      return { retention_days: 0, matched: 0, succeeded: 0, failed: 0, released_size: 0, skipped: true };
    }

    const cutoff = new Date(Date.now() - normalizedDays * 24 * 60 * 60 * 1000);
    const { rows } = await pool.query(
      `SELECT id FROM recording_files
       WHERE hls_status = 'ready' AND hls_generated_at < $1
       ORDER BY hls_generated_at ASC, id ASC`,
      [cutoff]
    );

    const summary = {
      retention_days: normalizedDays,
      cutoff,
      matched: rows.length,
      succeeded: 0,
      failed: 0,
      released_size: 0,
    };

    for (const row of rows) {
      try {
        const result = await this.deleteForRecording(row.id, 'retention', 'hls-retention-scheduler');
        if (result.result === 'success' || result.result === 'success_noop') {
          summary.succeeded++;
          summary.released_size += Number(result.actual_release_size || 0);
        } else {
          summary.failed++;
        }
      } catch (err) {
        summary.failed++;
        console.error(`[HLS Cleanup] 候选删除异常 recording_file_id=${row.id}: ${err.message}`);
      }
    }

    console.log(
      `[HLS Cleanup] 完成 cutoff=${cutoff.toISOString()} matched=${summary.matched} ` +
        `succeeded=${summary.succeeded} failed=${summary.failed} released=${summary.released_size}`
    );
    return summary;
  }

  start() {
    this.stop();
    this.firstRunTimer = setTimeout(() => {
      this.cleanupExpired().catch((err) => console.error('[HLS Cleanup] 首次任务失败:', err));
      this.intervalTimer = setInterval(() => {
        this.cleanupExpired().catch((err) => console.error('[HLS Cleanup] 定时任务失败:', err));
      }, CLEANUP_INTERVAL_MS);
      this.intervalTimer.unref?.();
    }, FIRST_RUN_DELAY_MS);
    this.firstRunTimer.unref?.();
  }

  stop() {
    if (this.firstRunTimer) clearTimeout(this.firstRunTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.firstRunTimer = null;
    this.intervalTimer = null;
  }
}

const hlsCleanupService = new HLSCleanupService();
module.exports = hlsCleanupService;
module.exports.HLSCleanupService = HLSCleanupService;
