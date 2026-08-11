/**
 * 弹幕 JSONL 路径迁移脚本（v1.8.0）
 *
 * 将历史弹幕文件从会话子目录迁移到集中扁平目录：
 *   旧: VIDEO_DOWNLOAD_DIR/[sessionId]/danmaku/danmaku.jsonl
 *       VIDEO_DOWNLOAD_DIR/[sessionId]/danmaku.jsonl
 *       VIDEO_DOWNLOAD_DIR/[roomId]/[sessionId]/danmaku/danmaku.jsonl
 *   新: VIDEO_DOWNLOAD_DIR/danmaku/[sessionId].jsonl
 *
 * 用法：
 *   node scripts/migrate-danmaku-paths.js            # dry-run（默认，只报告不落盘）
 *   node scripts/migrate-danmaku-paths.js --apply    # 真实执行
 *
 * 安全约束：
 * - 默认 dry-run，真实执行必须显式 --apply
 * - 幂等：目标文件已存在则跳过移动，仅补齐 DB
 * - 顺序：移动文件 → 更新 danmaku_capture_records.raw_path → 更新 managed_files.file_path
 *         → 清理残留空目录
 * - 不猜测：raw_path 形态不符合预期时跳过并告警，不做改写
 * - 执行前请先备份：bash scripts/backup-db.sh
 */

require('../server/config/env').initEnv();

const fs = require('fs');
const path = require('path');
const pool = require('../server/db');
const { getDanmakuJsonlPath, getDanmakuDir } = require('../server/lib/utils/tool');

const DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR;
const apply = process.argv.includes('--apply');

const report = {
  dbRows: 0,
  moved: 0,
  alreadyNew: 0,
  targetExists: 0,
  sourceMissing: 0,
  unexpectedShape: [],
  captureUpdated: 0,
  managedUpdated: 0,
  emptyDirsRemoved: 0,
  orphanFiles: [],
  failures: [],
};

/**
 * 判断 raw_path 是否已是新的扁平形态
 */
function isNewShape(rawPath, sessionId) {
  return path.resolve(rawPath) === path.resolve(getDanmakuJsonlPath(sessionId));
}

/**
 * 判断 raw_path 是否是已知的旧形态（位于 VIDEO_DOWNLOAD_DIR 内、文件名为 danmaku.jsonl）
 */
function isKnownOldShape(rawPath) {
  const resolved = path.resolve(rawPath);
  const rel = path.relative(path.resolve(DOWNLOAD_DIR), resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return path.basename(resolved) === 'danmaku.jsonl';
}

/**
 * 移动单个文件；目标已存在则不覆盖
 * @returns {'moved'|'target_exists'|'source_missing'}
 */
function moveFile(src, dest) {
  if (fs.existsSync(dest)) return 'target_exists';
  if (!fs.existsSync(src)) return 'source_missing';
  if (apply) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
  }
  return 'moved';
}

/**
 * 递归清理 VIDEO_DOWNLOAD_DIR 下残留的空 danmaku 目录，
 * 以及因此变空的父会话目录（只删空目录，不递归删文件）
 */
function cleanupEmptyDanmakuDirs(dir, depth = 0) {
  if (depth > 3) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fp = path.join(dir, entry.name);
    // 跳过新的集中目录本身
    if (path.resolve(fp) === path.resolve(getDanmakuDir())) continue;

    if (entry.name === 'danmaku') {
      let inner;
      try {
        inner = fs.readdirSync(fp);
      } catch {
        continue;
      }
      if (inner.length === 0) {
        if (apply) {
          try {
            fs.rmdirSync(fp);
          } catch (err) {
            report.failures.push(`删除空目录失败 ${fp}: ${err.message}`);
            continue;
          }
        }
        report.emptyDirsRemoved++;
      } else {
        report.orphanFiles.push(`${fp} 仍有 ${inner.length} 个文件，未清理`);
      }
      continue;
    }

    cleanupEmptyDanmakuDirs(fp, depth + 1);
  }
}

async function main() {
  if (!DOWNLOAD_DIR) {
    console.error('❌ 环境变量 VIDEO_DOWNLOAD_DIR 未配置，终止');
    process.exit(1);
  }

  console.log('=== 弹幕路径迁移 (v1.8.0) ===');
  console.log(`模式: ${apply ? '⚠️  APPLY（真实写入）' : 'DRY-RUN（只报告）'}`);
  console.log(`VIDEO_DOWNLOAD_DIR: ${DOWNLOAD_DIR}`);
  console.log(`目标目录: ${getDanmakuDir()}\n`);

  if (!apply) {
    console.log('提示：确认报告无误后加 --apply 真实执行；执行前请先 bash scripts/backup-db.sh\n');
  }

  const { rows } = await pool.query(
    `SELECT id, session_id, raw_path
     FROM danmaku_capture_records
     WHERE raw_path IS NOT NULL AND raw_path != ''
     ORDER BY session_id`
  );
  report.dbRows = rows.length;

  for (const row of rows) {
    const { id, session_id: sessionId, raw_path: rawPath } = row;

    if (!sessionId) {
      report.unexpectedShape.push(`capture_id=${id} 缺少 session_id，跳过`);
      continue;
    }

    const dest = getDanmakuJsonlPath(sessionId);

    if (isNewShape(rawPath, sessionId)) {
      report.alreadyNew++;
      continue;
    }

    if (!isKnownOldShape(rawPath)) {
      // 防御性检测：形态不符合预期（例如历史归档目录），不猜测、不改写
      report.unexpectedShape.push(`capture_id=${id} session=${sessionId} raw_path=${rawPath}`);
      continue;
    }

    let result;
    try {
      result = moveFile(rawPath, dest);
    } catch (err) {
      report.failures.push(`capture_id=${id} 移动失败 ${rawPath} → ${dest}: ${err.message}`);
      continue;
    }

    if (result === 'moved') report.moved++;
    if (result === 'target_exists') report.targetExists++;
    if (result === 'source_missing') report.sourceMissing++;

    // 无论文件是否存在磁盘，DB 路径都应指向新位置（磁盘缺失的记录本就是历史清理产物）
    if (apply) {
      try {
        const capRes = await pool.query(
          `UPDATE danmaku_capture_records SET raw_path = $1 WHERE id = $2 AND raw_path IS DISTINCT FROM $1`,
          [dest, id]
        );
        report.captureUpdated += capRes.rowCount;

        const mfRes = await pool.query(
          `UPDATE managed_files SET file_path = $1, file_name = $2, updated_at = NOW()
           WHERE source_table = 'danmaku_capture_records' AND source_id = $3
             AND file_path IS DISTINCT FROM $1`,
          [dest, path.basename(dest), id]
        );
        report.managedUpdated += mfRes.rowCount;
      } catch (err) {
        report.failures.push(`capture_id=${id} DB 更新失败: ${err.message}`);
      }
    } else {
      report.captureUpdated++;
    }
  }

  cleanupEmptyDanmakuDirs(DOWNLOAD_DIR);

  console.log('--- 报告 ---');
  console.log(`DB 记录总数:          ${report.dbRows}`);
  console.log(`已是新路径（跳过）:   ${report.alreadyNew}`);
  console.log(`文件已移动:           ${report.moved}`);
  console.log(`目标已存在（跳过移动）: ${report.targetExists}`);
  console.log(`源文件不在磁盘:       ${report.sourceMissing}`);
  console.log(`capture 记录待更新/已更新: ${report.captureUpdated}`);
  console.log(`managed_files 已更新: ${report.managedUpdated}`);
  console.log(`清理空 danmaku 目录:  ${report.emptyDirsRemoved}`);

  if (report.unexpectedShape.length) {
    console.log(`\n⚠️  形态异常已跳过（${report.unexpectedShape.length}）：`);
    report.unexpectedShape.forEach((m) => console.log(`  - ${m}`));
  }
  if (report.orphanFiles.length) {
    console.log(`\n⚠️  非空目录未清理（${report.orphanFiles.length}）：`);
    report.orphanFiles.forEach((m) => console.log(`  - ${m}`));
  }
  if (report.failures.length) {
    console.log(`\n❌ 失败（${report.failures.length}）：`);
    report.failures.forEach((m) => console.log(`  - ${m}`));
  }

  console.log(`\n${apply ? '✅ 迁移完成' : '（dry-run 结束，未写入任何数据）'}`);

  await pool.end();
  process.exit(report.failures.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('迁移脚本异常:', err);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
