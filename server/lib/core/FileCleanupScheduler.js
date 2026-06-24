const FileManageService = require('../../services/FileManageService');
const DataService = require('../../services/DataService');
const { send } = require('./notify');

/**
 * 文件管理定时任务
 *
 * 功能：
 * 1. 每日扫描文件索引
 * 2. 空间水位告警（磁盘占用超阈值通知）
 * 3. 自动清理（按保留天数 + 可安全删除 + 分类过滤）
 * 4. 清理建议通知
 *
 * 通过 setTimeout 自调度，与 watchdog 模式一致。
 */

let timer = null;
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

/**
 * 检查磁盘空间水位
 * 读取 VIDEO_DOWNLOAD_DIR 所在分区的磁盘使用率
 */
async function checkDiskWatermark() {
  try {
    const videoDir = process.env.VIDEO_DOWNLOAD_DIR || '/data/video_downloads';
    // 使用 statvfs 风格的 df 命令获取磁盘使用率
    const { execSync } = require('child_process');
    const dfOutput = execSync(`df -P "${videoDir}" 2>/dev/null | tail -1`, { encoding: 'utf8', timeout: 5000 });
    const parts = dfOutput.trim().split(/\s+/);
    // Filesystem 1024-blocks Used Available Capacity Mounted_on
    const usedPercent = parseInt(parts[4], 10);

    if (isNaN(usedPercent)) return null;

    const warnThreshold = parseInt(await DataService.getSetting('file_cleanup_watermark_warn', '80'), 10);
    const criticalThreshold = parseInt(await DataService.getSetting('file_cleanup_watermark_critical', '90'), 10);

    if (usedPercent >= criticalThreshold) {
      return {
        level: 'critical',
        percent: usedPercent,
        message: `🔴 磁盘空间紧急！已使用 ${usedPercent}%（阈值 ${criticalThreshold}%）`,
      };
    }
    if (usedPercent >= warnThreshold) {
      return {
        level: 'warn',
        percent: usedPercent,
        message: `🟡 磁盘空间警告：已使用 ${usedPercent}%（阈值 ${warnThreshold}%）`,
      };
    }
    return { level: 'ok', percent: usedPercent };
  } catch (err) {
    console.error('[文件管理定时] 磁盘水位检查失败:', err.message);
    return null;
  }
}

async function runCleanupCheck() {
  try {
    console.log('[文件管理定时] 开始执行...');

    // 1. 全量扫描更新索引
    const scanResult = await FileManageService.scanAllFiles();
    console.log(
      `[文件管理定时] 扫描完成: ${scanResult.scanned} 个文件, ` +
        `新建 ${scanResult.created}, 更新 ${scanResult.updated}, 缺失 ${scanResult.missing}`
    );

    // 2. 磁盘水位检查
    const watermark = await checkDiskWatermark();
    if (watermark && watermark.level !== 'ok') {
      await send('磁盘空间告警', watermark.message);
      console.log(`[文件管理定时] ${watermark.message}`);
    }

    // 3. 自动清理（如果启用）
    const cleanupEnabled = await DataService.getSetting('file_cleanup_enabled', 'false');
    if (cleanupEnabled === 'true') {
      await runAutoCleanup();
    }

    // 4. 清理建议通知
    await sendCleanupSuggestion();
  } catch (err) {
    console.error('[文件管理定时] 执行失败:', err.message);
  }
}

/**
 * 自动清理：按保留天数 + 可安全删除 + 分类过滤生成删除计划并执行
 */
async function runAutoCleanup() {
  try {
    const retentionDays = parseInt(await DataService.getSetting('file_cleanup_retention_days', '30'), 10);
    const categoriesRaw = await DataService.getSetting('file_cleanup_categories', '');
    const categories = categoriesRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const filters = {
      safe_to_delete: true,
      older_than_days: retentionDays,
    };
    // 如果配置了分类，逐个执行；否则清理全部
    const categoryFilters = categories.length > 0 ? categories : [null];

    let totalDeleted = 0;
    let totalFailed = 0;
    let totalReleased = 0;

    for (const cat of categoryFilters) {
      const f = { ...filters };
      if (cat) f.category = cat;

      const plan = await FileManageService.generateDeletePlan({ filters: f }, 'auto-scheduler');
      if (plan.deletable_count === 0) continue;

      console.log(
        `[自动清理] ${cat || '全部'}: 匹配 ${plan.deletable_count} 个文件, 预计释放 ${formatBytes(plan.total_size)}`
      );

      const { task_id: taskId } = await FileManageService.executeDelete(plan.plan_id, 'auto-scheduler');

      // 轮询等待任务完成（最多 10 分钟）
      const maxWait = 10 * 60 * 1000;
      const startTime = Date.now();
      while (Date.now() - startTime < maxWait) {
        const status = await FileManageService.getDeleteTaskStatus(taskId);
        if (status && status.status === 'completed') {
          totalDeleted += status.deleted_count;
          totalFailed += status.failed_count;
          totalReleased += status.actual_release_size;
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (totalDeleted > 0 || totalFailed > 0) {
      const msg = `🗑️ 自动清理完成: 删除 ${totalDeleted} 个文件, 失败 ${totalFailed}, 释放 ${formatBytes(totalReleased)}`;
      await send('文件管理 - 自动清理', msg);
      console.log(`[自动清理] ${msg}`);
    } else {
      console.log('[自动清理] 无可清理文件');
    }
  } catch (err) {
    console.error('[自动清理] 失败:', err.message);
    await send('文件管理 - 自动清理失败', err.message);
  }
}

async function sendCleanupSuggestion() {
  try {
    // 全局开关：可通过 DB 设置关闭清理建议通知
    const suggestionEnabled = await DataService.getSetting('file_cleanup_suggestion_notify', 'false');
    if (suggestionEnabled !== 'true') {
      // console.log('[文件管理定时] 清理建议通知已关闭（file_cleanup_suggestion_notify=false）');
      return;
    }

    // 开发环境不发通知
    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
      console.log('[文件管理定时] 开发环境跳过清理建议通知');
      return;
    }

    const summary = await FileManageService.getFileSummary();
    if (summary.safe_to_delete_size === 0) {
      console.log('[文件管理定时] 无可清理文件，跳过建议通知');
      return;
    }

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

    await send('文件管理 - 清理建议', lines.join('\n'));
    console.log('[文件管理定时] 清理建议通知已发送');
  } catch (err) {
    console.error('[文件管理定时] 建议通知失败:', err.message);
  }
}

async function run() {
  await runCleanupCheck();
  // 读取实际间隔（允许运行时修改）
  const intervalHours = 24;
  timer = setTimeout(run, intervalHours * 60 * 60 * 1000);
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

module.exports = { start, stop, runCleanupCheck, checkDiskWatermark };
