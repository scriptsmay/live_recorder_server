const fs = require('fs');
const path = require('path');
const pool = require('../db/index');
const redis = require('../db/redis');
const ReplayService = require('./ReplayService');
const { resolveAndValidate } = require('../lib/utils/path-safety');
const { getReplayWorkDir } = require('../config/config');

const YIELD_INTERVAL = 100;
const TERMINAL_REPLAY_STATUSES = ['completed', 'backed_up', 'failed', 'cancelled'];

function isSameOrAncestor(candidate, protectedPath) {
  const relative = path.relative(candidate, protectedPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathsOverlap(candidate, protectedPath) {
  return isSameOrAncestor(candidate, protectedPath) || isSameOrAncestor(protectedPath, candidate);
}

class EmptyDirectoryCleanupService {
  getRoots(categories = ['recording', 'replay']) {
    const available = {
      recording: path.resolve(process.env.VIDEO_DOWNLOAD_DIR || '/data/video_downloads'),
      replay: path.resolve(process.env.REPLAY_WORK_DIR || getReplayWorkDir()),
    };

    return [...new Set(categories)]
      .filter((category) => available[category])
      .map((category) => ({ category, root: available[category] }));
  }

  async cleanup(options = {}) {
    const { categories = ['recording', 'replay'], operator = 'auto-scheduler', dryRun = false } = options;
    const summary = {
      dry_run: dryRun,
      scanned: 0,
      candidates: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
      candidate_paths: [],
      deleted_paths: [],
      skipped_paths: [],
      failures: [],
    };
    const protectedPaths = await this._getProtectedPaths();

    for (const { category, root } of this.getRoots(categories)) {
      let rootStat;
      try {
        rootStat = await fs.promises.lstat(root);
      } catch (err) {
        if (err.code === 'ENOENT') {
          summary.skipped++;
          summary.skipped_paths.push({ path: root, reason: 'root_missing' });
          continue;
        }
        summary.failed++;
        summary.failures.push({ path: root, error: err.message });
        continue;
      }

      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        summary.skipped++;
        summary.skipped_paths.push({ path: root, reason: 'invalid_root' });
        continue;
      }

      await this._walkDirectory(root, root, category, protectedPaths, summary, { operator, dryRun });
    }

    console.log(
      `[空目录清理] 完成 dry_run=${dryRun} scanned=${summary.scanned} candidates=${summary.candidates} ` +
        `deleted=${summary.deleted} skipped=${summary.skipped} failed=${summary.failed}`
    );
    return summary;
  }

  async pruneParents(filePath, options = {}) {
    const roots = this.getRoots(options.category ? [options.category] : undefined);
    const resolvedFile = path.resolve(filePath);
    const rootEntry = roots.find(({ root }) => isSameOrAncestor(root, resolvedFile));
    if (!rootEntry) return { deleted: 0, skipped: 1, failed: 0, deleted_paths: [] };

    const protectedPaths = await this._getProtectedPaths();
    const result = { deleted: 0, skipped: 0, failed: 0, deleted_paths: [] };
    let current = path.dirname(resolvedFile);

    while (current !== rootEntry.root && isSameOrAncestor(rootEntry.root, current)) {
      const deletion = await this._removeCandidate(current, rootEntry.root, rootEntry.category, protectedPaths, {
        operator: options.operator || 'user',
        dryRun: false,
      });
      if (deletion.result === 'success' || deletion.result === 'success_noop') {
        result.deleted++;
        result.deleted_paths.push(current);
        current = path.dirname(current);
        continue;
      }
      if (deletion.result === 'failed') result.failed++;
      else result.skipped++;
      break;
    }

    return result;
  }

  async _walkDirectory(directory, root, category, protectedPaths, summary, context) {
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      summary.failed++;
      summary.failures.push({ path: directory, error: err.message });
      return false;
    }

    let logicallyEmpty = true;
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        logicallyEmpty = false;
        continue;
      }

      summary.scanned++;
      const childRemoved = await this._walkDirectory(entryPath, root, category, protectedPaths, summary, context);
      if (!childRemoved) logicallyEmpty = false;
      if (summary.scanned % YIELD_INTERVAL === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    if (directory === root || !logicallyEmpty) return false;

    summary.candidates++;
    const deletion = await this._removeCandidate(directory, root, category, protectedPaths, context);
    if (deletion.result === 'dry_run') {
      summary.candidate_paths.push(directory);
      return true;
    }
    if (deletion.result === 'success' || deletion.result === 'success_noop') {
      summary.deleted++;
      summary.deleted_paths.push(directory);
      return true;
    }
    if (deletion.result === 'failed') {
      summary.failed++;
      summary.failures.push({ path: directory, error: deletion.error });
    } else {
      summary.skipped++;
      summary.skipped_paths.push({ path: directory, reason: deletion.error });
    }
    return false;
  }

  async _removeCandidate(directory, root, category, protectedPaths, context) {
    const pathCheck = await resolveAndValidate(directory, [root]);
    if (!pathCheck.valid) return { result: 'skipped', error: pathCheck.reason };
    if (protectedPaths.some((protectedPath) => pathsOverlap(directory, protectedPath))) {
      return { result: 'skipped', error: 'active_path_protected' };
    }

    if (context.dryRun) return { result: 'dry_run' };

    let result = 'success';
    let error = null;
    try {
      await fs.promises.rmdir(directory);
    } catch (err) {
      if (err.code === 'ENOENT') result = 'success_noop';
      else if (['ENOTEMPTY', 'EEXIST', 'EBUSY', 'EPERM'].includes(err.code)) {
        result = 'skipped';
        error = err.code.toLowerCase();
      } else {
        result = 'failed';
        error = err.message;
      }
    }

    await this._writeAudit({
      directory,
      category,
      operator: context.operator,
      result,
      error,
    });
    return { result, error };
  }

  async _getProtectedPaths() {
    const protectedPaths = new Set();
    const [recordings, hls, replays, activeTaskKeys, replayLockKeys, replayQueueKeys] = await Promise.all([
      pool.query(`SELECT output_dir FROM recording_sessions WHERE status = 'recording' AND output_dir IS NOT NULL`),
      pool.query(
        `SELECT rf.hls_playlist_path, rs.output_dir
         FROM recording_files rf
         LEFT JOIN recording_sessions rs ON rs.id = rf.session_id
         WHERE rf.hls_status IN ('pending', 'generating', 'ready')`
      ),
      pool.query(
        `SELECT id, principal_id, replay_id
         FROM replay_records
         WHERE status != ALL($1::text[])`,
        [TERMINAL_REPLAY_STATUSES]
      ),
      redis.keys('active_task:*').catch(() => []),
      redis.keys('replay:lock:record:*').catch(() => []),
      redis.keys('replay:queued:record:*').catch(() => []),
    ]);

    for (const row of recordings.rows) {
      if (row.output_dir) protectedPaths.add(path.resolve(row.output_dir));
    }
    for (const key of activeTaskKeys) {
      const rawTask = await redis.get(key).catch(() => null);
      if (!rawTask) continue;
      try {
        const task = JSON.parse(rawTask);
        if (task.outputPath) protectedPaths.add(path.resolve(path.dirname(task.outputPath)));
      } catch (err) {
        console.warn(`[空目录清理] 无法解析活跃录制任务 ${key}: ${err.message}`);
      }
    }
    for (const row of hls.rows) {
      if (row.hls_playlist_path) protectedPaths.add(path.resolve(path.dirname(row.hls_playlist_path)));
      else if (row.output_dir) protectedPaths.add(path.resolve(row.output_dir));
    }

    const replayRows = new Map(replays.rows.map((row) => [Number(row.id), row]));
    const lockedIds = [...replayLockKeys, ...replayQueueKeys]
      .map((key) => Number(key.split(':').pop()))
      .filter(Number.isFinite);
    const missingIds = lockedIds.filter((id) => !replayRows.has(id));
    if (missingIds.length > 0) {
      const { rows } = await pool.query(
        `SELECT id, principal_id, replay_id FROM replay_records WHERE id = ANY($1::int[])`,
        [missingIds]
      );
      for (const row of rows) replayRows.set(Number(row.id), row);
    }
    for (const row of replayRows.values()) {
      protectedPaths.add(ReplayService.resolveRecordWorkDir(row));
    }

    return [...protectedPaths];
  }

  async _writeAudit(data) {
    await pool.query(
      `INSERT INTO file_delete_audit_logs
        (file_id, file_path, file_size, category, source_table, source_id,
         operator, deleted_by, action, result, estimated_release_size,
         actual_release_size, error_message)
       VALUES (NULL, $1, 0, $2, 'filesystem', NULL, $3, $4,
               'delete_directory', $5, 0, 0, $6)`,
      [
        data.directory,
        data.category,
        data.operator,
        data.operator === 'auto-scheduler' ? 'system' : 'user',
        data.result,
        data.error,
      ]
    );
  }
}

module.exports = new EmptyDirectoryCleanupService();
module.exports.EmptyDirectoryCleanupService = EmptyDirectoryCleanupService;
