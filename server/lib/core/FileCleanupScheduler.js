const FileManageService = require('../../services/FileManageService');
const { send } = require('./notify');

/**
 * 文件管理定时任务
 *
 * 每日扫描文件索引并生成清理建议通知。
 * 通过 setTimeout 自调度，与 watchdog 模式一致。
 */

let timer = null;
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 小时
const CATEGORY_LABELS = {
  recording: '直播录制',
  replay: '回放文件',
  danmaku: '弹幕压制',
  orphan: '孤儿文件',
};

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

async function runCleanupCheck() {
  try {
    console.log('[文件管理定时] 开始扫描...');

    // 1. 全量扫描更新索引
    const scanResult = await FileManageService.scanAllFiles();
    console.log(
      `[文件管理定时] 扫描完成: ${scanResult.scanned} 个文件, ` +
        `新建 ${scanResult.created}, 更新 ${scanResult.updated}, 缺失 ${scanResult.missing}`
    );

    // 2. 获取空间概览
    const summary = await FileManageService.getFileSummary();

    // 3. 检查是否有可清理文件
    if (summary.safe_to_delete_size === 0) {
      console.log('[文件管理定时] 无可清理文件，跳过通知');
      return;
    }

    // 4. 生成清理建议通知
    const lines = ['📊 磁盘空间清理建议'];
    lines.push('');
    lines.push(`总占用: ${formatBytes(summary.total_size)}`);
    lines.push(`可清理: ${formatBytes(summary.safe_to_delete_size)}`);
    lines.push('');

    for (const group of summary.groups) {
      const label = CATEGORY_LABELS[group.type] || group.type;
      lines.push(`  ${label}: ${formatBytes(group.size)} (${group.file_count} 个文件)`);
    }

    lines.push('');
    lines.push('💡 可在「文件管理 → 清理规则」页面执行批量清理');

    const title = '文件管理 - 清理建议';
    const content = lines.join('\n');

    await send(title, content);
    console.log('[文件管理定时] 清理建议通知已发送');
  } catch (err) {
    console.error('[文件管理定时] 执行失败:', err.message);
  }
}

async function run() {
  await runCleanupCheck();
  // 自调度下一次执行
  timer = setTimeout(run, INTERVAL_MS);
}

/**
 * 启动定时任务
 * 首次执行延迟 5 分钟（避免与启动流程竞争），之后每 24 小时执行一次
 */
function start() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(run, 5 * 60 * 1000);
  console.log('[文件管理定时] 已启动，首次执行 5 分钟后');
}

function stop() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

module.exports = { start, stop, runCleanupCheck };
