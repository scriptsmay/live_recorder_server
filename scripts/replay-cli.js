#!/usr/bin/env node

'use strict';

/**
 * 回放工具箱 CLI — 手动触发回放全流程或单阶段
 *
 * 用法:
 *   node scripts/replay-cli.js all --principal <id> [--count N] [--skip-completed] [--dry-run]
 *   node scripts/replay-cli.js sync --principal <id> [--count N] [--dry-run]
 *   node scripts/replay-cli.js extract|download|cut|fix|upload --record <id>
 *   node scripts/replay-cli.js status [--principal <id>]
 */

require('../config/env').initEnv();

const pool = require('../db/index');
const ReplayService = require('../services/ReplayService');
const KuaishouReplayClient = require('../lib/core/replay/KuaishouReplayClient');
const videoProcessor = require('../lib/core/replay/video-processor');
const cleanup = require('../lib/core/replay/cleanup');
const ReplayUploadService = require('../lib/core/replay/ReplayUploadService');

// ── 参数解析 ──

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] || '';
  const options = {
    command,
    principal: null,
    record: null,
    count: 1,
    skipCompleted: true,
    dryRun: false,
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--principal') options.principal = args[++i] || null;
    else if (arg === '--record') options.record = parseInt(args[++i], 10) || null;
    else if (arg === '--count') options.count = parseInt(args[++i], 10) || 1;
    else if (arg === '--skip-completed') options.skipCompleted = true;
    else if (arg === '--no-skip-completed') options.skipCompleted = false;
    else if (arg === '--dry-run') options.dryRun = true;
  }
  return options;
}

// ── 辅助函数 ──

function log(msg) {
  console.log(`[replay-cli] ${msg}`);
}

function logError(msg) {
  console.error(`[replay-cli] ERROR: ${msg}`);
}

function safeParseJson(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

// ── 子命令实现 ──

async function cmdStatus(options) {
  const principals = await ReplayService.getPrincipals();
  const filtered = options.principal ? principals.filter((p) => p.principal_id === options.principal) : principals;

  if (filtered.length === 0) {
    log('未找到主播');
    return;
  }

  for (const p of filtered) {
    console.log(`\n  主播: ${p.room_name} (${p.principal_id})`);
    console.log(`  回放数: ${p.replay_count}`);
    console.log(`  最近: ${p.latest_replay_time || '-'} [${p.latest_status || '-'}]`);

    const records = await ReplayService.listRecords(p.principal_id, { page: 1, page_size: 5 });
    if (records.rows.length > 0) {
      console.log('  最新 5 条:');
      for (const r of records.rows) {
        const time = r.start_time ? new Date(r.start_time).toLocaleString('zh-CN') : '-';
        console.log(`    #${r.id}  ${time}  ${r.status}  ${r.duration ? Math.round(r.duration / 60) + 'min' : '-'}`);
      }
    }
  }
}

async function cmdSync(options) {
  if (!options.principal) {
    logError('缺少 --principal <id>');
    process.exit(1);
  }

  const principals = await ReplayService.getPrincipals();
  const principal = principals.find((p) => p.principal_id === options.principal);
  if (!principal) {
    logError(`未找到主播: ${options.principal}`);
    process.exit(1);
  }

  log(`同步主播 ${principal.room_name} (${principal.principal_id}) 最近 ${options.count} 条回放...`);

  if (options.dryRun) {
    log('[dry-run] 仅预览，不写入数据库');
  }

  const result = await KuaishouReplayClient.syncReplays(principal.principal_id, options.count, principal.room_name);

  if (options.dryRun) {
    log(`[dry-run] API 返回 ${result.records?.length ?? 0} 条记录`);
    for (const r of result.records ?? []) {
      console.log(
        `  ${r.replay_id}  ${r.start_time || '-'}  ${r.duration ? Math.round(r.duration / 60) + 'min' : '-'}`
      );
    }
    return;
  }

  let inserted = 0;
  let skipped = 0;
  for (const record of result.records ?? []) {
    const existing = await ReplayService.getRecordByReplayId(principal.principal_id, record.replay_id);
    if (existing) {
      skipped++;
      continue;
    }
    await ReplayService.upsertRecord({
      principal_id: principal.principal_id,
      principal_name: principal.room_name,
      replay_id: record.replay_id,
      play_url: record.play_url || '',
      video_file_name: record.video_file_name || '',
      start_time: record.start_time || null,
      duration: record.duration || 0,
      status: 'pending',
    });
    inserted++;
  }

  log(`同步完成: 新增 ${inserted}, 跳过 ${skipped}`);
}

async function cmdAll(options) {
  if (!options.principal) {
    logError('缺少 --principal <id>');
    process.exit(1);
  }

  const records = await ReplayService.listRecords(options.principal, {
    page: 1,
    page_size: options.count,
  });

  let candidates = records.rows;
  if (options.skipCompleted) {
    candidates = candidates.filter((r) => !['completed', 'backed_up'].includes(r.status));
  }

  if (candidates.length === 0) {
    log('没有待处理的回放记录');
    return;
  }

  log(`将处理 ${candidates.length} 条回放记录`);
  if (options.dryRun) {
    for (const r of candidates) {
      console.log(`  #${r.id}  ${r.status}  ${r.replay_id || '-'}`);
    }
    log('[dry-run] 仅预览');
    return;
  }

  // 'fix' 默认不处理
  const allTasks = ['extract', 'download', 'cut', 'upload'];

  let success = 0;
  let failed = 0;
  for (const record of candidates) {
    log(`处理 #${record.id} (${record.replay_id || '-'})...`);
    try {
      await runPipeline(record, allTasks);
      success++;
      log(`  #${record.id} 完成`);
    } catch (err) {
      failed++;
      logError(`  #${record.id} 失败: ${err.message}`);
      await ReplayService.updateRecordStatus(record.id, 'failed', { error_message: err.message });
    }
  }

  log(`全部完成: 成功 ${success}, 失败 ${failed}`);
}

async function cmdSingleAction(options) {
  const action = options.command;
  if (!options.record) {
    logError(`缺少 --record <id>`);
    process.exit(1);
  }

  const record = await ReplayService.getRecord(options.record);
  if (!record) {
    logError(`记录不存在: #${options.record}`);
    process.exit(1);
  }

  log(`${action} #${record.id} (${record.replay_id || '-'})...`);

  if (options.dryRun) {
    log('[dry-run] 仅预览');
    return;
  }

  try {
    await runPipeline(record, [action]);
    log(`完成`);
  } catch (err) {
    logError(`失败: ${err.message}`);
    await ReplayService.updateRecordStatus(record.id, 'failed', { error_message: err.message });
    process.exit(1);
  }
}

// ── 流水线执行 ──

async function runPipeline(record, actions) {
  let current = record;

  for (const step of actions) {
    if (step === 'extract') {
      const result = await videoProcessor.extract(current);
      if (!result.success) throw new Error(result.error);
      current = await ReplayService.updateRecordStatus(current.id, 'extracted', { m3u8_url: result.m3u8Url });
    } else if (step === 'download') {
      const result = await videoProcessor.download(current);
      if (!result.success) throw new Error(result.error);
      current = await ReplayService.updateRecordStatus(current.id, 'downloaded', {
        raw_file_path: result.rawFilePath,
        file_size: result.fileSize,
      });
    } else if (step === 'cut') {
      const result = await videoProcessor.cut(current);
      if (!result.success) throw new Error(result.error);
      current = await ReplayService.updateRecordStatus(current.id, 'cut', {
        cut_file_paths: result.cutFilePaths,
      });
      if (current.raw_file_path) cleanup.removeFiles([current.raw_file_path]).catch(() => {});
    } else if (step === 'fix') {
      const result = await videoProcessor.fix(current);
      if (!result.success) throw new Error(result.error);
      const previous = safeParseJson(current.cut_file_paths, []);
      current = await ReplayService.updateRecordStatus(current.id, 'fixed', {
        fixed_file_paths: result.fixedFilePaths,
        final_file_paths: result.finalFilePaths,
      });
      cleanup.removeFiles(previous).catch(() => {});
    } else if (step === 'upload') {
      const result = await ReplayUploadService.executeUpload(current.id);
      if (result.error) throw new Error(result.message);
    } else {
      throw new Error(`未知动作: ${step}`);
    }
  }

  return current;
}

// ── 主入口 ──

async function main() {
  const options = parseArgs(process.argv);

  const commands = {
    all: cmdAll,
    sync: cmdSync,
    status: cmdStatus,
    extract: cmdSingleAction,
    download: cmdSingleAction,
    cut: cmdSingleAction,
    fix: cmdSingleAction,
    upload: cmdSingleAction,
  };

  if (!options.command || options.command === '--help' || options.command === '-h') {
    console.log(`
回放工具箱 CLI

用法:
  node scripts/replay-cli.js <command> [options]

命令:
  status    [--principal <id>]              查看回放状态
  sync      --principal <id> [--count N]    同步回放列表
  all       --principal <id> [--count N]    执行全流程
  extract   --record <id>                   提取 m3u8
  download  --record <id>                   下载视频
  cut       --record <id>                   切片
  fix       --record <id>                   修复分辨率
  upload    --record <id>                   投稿

选项:
  --principal <id>     指定主播 ID
  --record <id>        指定记录 ID
  --count <n>          处理条数（默认 1）
  --skip-completed     跳过已完成记录（默认开启）
  --no-skip-completed  不跳过已完成记录
  --dry-run            预览模式，不执行
`);
    process.exit(0);
  }

  const handler = commands[options.command];
  if (!handler) {
    logError(`未知命令: ${options.command}`);
    process.exit(1);
  }

  try {
    await handler(options);
  } catch (err) {
    logError(err.message);
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
