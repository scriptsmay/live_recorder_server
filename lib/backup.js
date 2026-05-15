const { spawn } = require('child_process');
const fs = require('fs');
const pool = require('../db/index');
const { createProcLog } = require('./proc-log');
const notify = require('./notify');

function getNasConfig() {
  const host = process.env.NAS_HOST;
  const user = process.env.NAS_USER;
  const dir = process.env.NAS_BACKUP_DIR;
  if (!host || !user || !dir) {
    throw new Error('NAS 配置不完整，请设置 NAS_HOST、NAS_USER、NAS_BACKUP_DIR');
  }
  return { host, user, dir };
}

async function backupToNAS(files, logKey) {
  const { host, user, dir } = getNasConfig();
  const remote = `${user}@${host}:${dir}`;

  const { stream: logStream, logPath, logCommand } = createProcLog('nas_backup', logKey);
  console.log(`[NAS备份] 日志: ${logPath}`);

  const args = ['-avzR', '--progress', ...files, remote];
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
        resolve();
      } else {
        const msg = `rsync exit code ${code}`;
        logStream.write(`[NAS备份] ${msg}\n`);
        reject(new Error(msg));
      }
    });
  });
}

async function deleteLocalFiles(files, logKey) {
  const { stream: logStream, logPath } = createProcLog('file_delete', logKey);
  console.log(`[文件清理] 日志: ${logPath}`);

  const results = { deleted: 0, failed: 0 };
  for (const fp of files) {
    try {
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
        logStream.write(`[删除] ${fp}\n`);
        results.deleted++;
      } else {
        logStream.write(`[跳过-不存在] ${fp}\n`);
      }
    } catch (err) {
      logStream.write(`[失败] ${fp}: ${err.message}\n`);
      results.failed++;
    }
  }
  logStream.write(`[文件清理] 完成: 删除 ${results.deleted}, 失败 ${results.failed}\n`);

  return results;
}

async function afterUpload(action, files, sessionId, templateName, recordId) {
  if (!action || action === 'none' || !files || files.length === 0) return null;

  const logKey = recordId || sessionId;
  const tmplInfo = `模板：${templateName}\n文件：${files.length} 个`;

  if (action === 'backup') {
    try {
      notify.send('📤 开始NAS备份', tmplInfo);
      await backupToNAS(files, logKey);
      notify.send('✅ NAS备份完成', tmplInfo);
      return { action: 'backup', status: 'success' };
    } catch (err) {
      notify.send('❌ NAS备份失败', `${tmplInfo}\n错误：${err.message}`);
      console.error(`[NAS备份] 失败:`, err.message);
      return { action: 'backup', status: 'failed', error: err.message };
    }
  }

  if (action === 'delete') {
    try {
      const result = await deleteLocalFiles(files, logKey);
      notify.send('🗑️ 本地文件已清理', `${tmplInfo}\n删除：${result.deleted} 个\n失败：${result.failed} 个`);
      return { action: 'delete', status: 'success', deleted: result.deleted, failed: result.failed };
    } catch (err) {
      console.error(`[文件清理] 失败:`, err.message);
      return { action: 'delete', status: 'failed', error: err.message };
    }
  }

  return null;
}

module.exports = { afterUpload };
