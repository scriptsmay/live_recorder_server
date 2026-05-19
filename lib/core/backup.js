const { spawn } = require('child_process');
const fs = require('fs');
const pool = require('../../db/index');
const { createProcLog } = require('../utils/proc-log');
const notify = require('./notify');

function getNasConfig() {
  const host = process.env.NAS_HOST;
  const user = process.env.NAS_USER;
  const dir = process.env.NAS_BACKUP_DIR;
  if (!host || !user || !dir) {
    return null;
  }
  return { host, user, dir };
}

async function backupToNAS(files, subDir, logKey) {
  const config = getNasConfig();
  if (!config) {
    return { status: 'skipped', reason: 'NAS 配置未设置，跳过备份' };
  }

  const { host, user, dir } = config;
  const remote = `${user}@${host}:${dir}/${subDir}`;

  const { stream: logStream, logPath, logCommand } = createProcLog('nas_backup', logKey);
  console.log(`[NAS备份] 日志: ${logPath}`);

  const args = ['-avz', '--progress', ...files, remote];
  logCommand('rsync', args);

  return new Promise((resolve, reject) => {
    const proc = spawn('rsync', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', (d) => logStream.write(d));
    proc.stderr.on('data', (d) => logStream.write(d));

    proc.on('error', (err) => {
      logStream.write(`[NAS备份] 进程启动失败: ${err.message}\n`);
      reject(err);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        logStream.write('[NAS备份] 完成\n');
        resolve({ status: 'success' });
      } else {
        const msg = `rsync exit code ${code}`;
        logStream.write(`[NAS备份] ${msg}\n`);
        reject(new Error(msg));
      }
    });
  });
}

async function deleteLocalFiles(files, logKey, sessionId) {
  const { stream: logStream, logPath } = createProcLog('file_delete', logKey);
  console.log(`[文件清理] 日志: ${logPath}`);

  const results = { deleted: 0, failed: 0 };
  for (const fp of files) {
    try {
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
        logStream.write(`[删除] ${fp}\n`);
        results.deleted++;
        try {
          await pool.query(
            `UPDATE recording_files SET status = 'deleted', checked_at = NOW() WHERE file_path = $1 AND status != 'deleted'`,
            [fp]
          );
        } catch (dbErr) {
          logStream.write(`[DB更新失败] ${fp}: ${dbErr.message}\n`);
        }
      } else {
        logStream.write(`[跳过-不存在] ${fp}\n`);
        try {
          await pool.query(
            `UPDATE recording_files SET status = 'deleted', checked_at = NOW() WHERE file_path = $1 AND status != 'deleted'`,
            [fp]
          );
        } catch (dbErr) {
          logStream.write(`[DB更新失败] ${fp}: ${dbErr.message}\n`);
        }
      }
    } catch (err) {
      logStream.write(`[失败] ${fp}: ${err.message}\n`);
      results.failed++;
    }
  }
  if (sessionId) {
    try {
      await pool.query(
        `UPDATE recording_files SET status = 'deleted', checked_at = NOW() WHERE session_id = $1 AND status NOT IN ('deleted', 'missing')`,
        [sessionId]
      );
    } catch (dbErr) {
      logStream.write(`[DB会话更新失败] session ${sessionId}: ${dbErr.message}\n`);
    }
  }
  logStream.write(`[文件清理] 完成: 删除 ${results.deleted}, 失败 ${results.failed}\n`);

  return results;
}

/**
 * 执行上传后的文件处理操作（备份、删除或两者结合）
 *
 * 根据指定的动作类型，对录制文件执行以下操作之一：
 * - backup: 仅备份到NAS
 * - delete: 仅删除本地文件
 * - backup_and_delete: 先备份到NAS，再删除本地文件
 *
 * @param {string} action - 要执行的动作类型，可选值：'backup' | 'delete' | 'backup_and_delete' | 'none'
 * @param {Array} files - 需要处理的文件列表
 * @param {string} sessionId - 会话ID，用于日志记录和生成子目录名称
 * @param {string} templateName - 模板名称，用于通知消息
 * @param {string} recordId - 投稿记录ID，优先用作日志键
 * @param {string} roomName - 房间名称，用于生成子目录名称和通知消息
 * @param {string} roomUrl - 房间URL，用于通知消息
 * @returns {Promise<Object|null>} 返回处理结果对象或null
 *   - 当action无效或files为空时返回null
 *   - 成功时返回包含action、status等字段的对象
 *   - 失败时返回包含action、status、error字段的对象
 *   - 跳过时返回包含action、status、reason字段的对象
 */
async function afterUpload(action, files, sessionId, templateName, recordId, roomName, roomUrl) {
  if (!action || action === 'none' || !files || files.length === 0) return null;

  const logKey = recordId || sessionId;
  const fileCount = files.length;
  const combined = action === 'backup_and_delete';
  const subDir = (roomName || `session_${sessionId}`).replace(/[\\/:*?"<>|]/g, '_');

  if (action === 'backup' || combined) {
    if (!getNasConfig()) {
      const reason = 'NAS 配置未设置，跳过备份';
      console.warn(`[NAS备份] ${reason}`);
      return {
        action: combined ? 'backup_and_delete' : 'backup',
        status: 'skipped',
        reason,
      };
    }

    try {
      await notify.backupStart(roomName, templateName, fileCount, roomUrl);
      await backupToNAS(files, subDir, logKey);
      await notify.backupComplete(roomName, templateName, fileCount, roomUrl);
    } catch (err) {
      await notify.backupFailed(roomName, templateName, fileCount, err.message, roomUrl);
      console.error(`[NAS备份] 失败:`, err.message);
      return {
        action: combined ? 'backup_and_delete' : 'backup',
        status: 'failed',
        error: err.message,
      };
    }
    if (!combined) return { action: 'backup', status: 'success' };
  }

  if (action === 'delete' || combined) {
    try {
      const result = await deleteLocalFiles(files, logKey, sessionId);
      await notify.filesDeleted(roomName, templateName, result.deleted, result.failed, roomUrl);
      return {
        action: combined ? 'backup_and_delete' : 'delete',
        status: 'success',
        deleted: result.deleted,
        failed: result.failed,
      };
    } catch (err) {
      console.error(`[文件清理] 失败:`, err.message);
      return { action: 'delete', status: 'failed', error: err.message };
    }
  }

  return null;
}

module.exports = { afterUpload };
