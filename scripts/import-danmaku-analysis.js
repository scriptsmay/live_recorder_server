/**
 * 批量弹幕分析产出导入脚本（v1.13.0，一次性手动执行）
 *
 * 把 danmaku-batch/analyze.py 回算产出（VIDEO_DOWNLOAD_DIR/danmaku_analysis/{sessionId}.json，
 * _serialize 结构）导入 danmaku_analysis_records，使历史 50 场在前端可看；
 * 入表后 watchdog 经 NOT EXISTS 排重，天然不会对这些场次重算。
 *
 * 用法：
 *   node scripts/import-danmaku-analysis.js            # dry-run（默认，只报告不落库）
 *   node scripts/import-danmaku-analysis.js --apply    # 真实执行
 *
 * 安全约束：
 * - 默认 dry-run，真实执行必须显式 --apply
 * - report_path 不信任 JSON 内容，一律经 getDanmakuAnalysisHtmlPath(数字 sid) 重新推导
 * - 无对应 recording_sessions 活跃行的 JSON 跳过并报告
 * - 已有活跃记录且 status=running 的跳过（不干扰进行中的分析）；其余 upsert 覆盖
 *   （本脚本是一次性导入，跑在自动分析上线前；若日后重算过，以本脚本导入为准属预期内）
 * - 单个 JSON 解析失败只记账不中断整批
 */

require('../server/config/env').initEnv();

const fs = require('fs');
const path = require('path');
const pool = require('../server/db');
const { getDanmakuAnalysisDir, getDanmakuAnalysisHtmlPath } = require('../server/lib/utils/tool');

const apply = process.argv.includes('--apply');
const INDEX_FILE = '_index.json';

const report = {
  scanned: 0,
  inserted: 0,
  updated: 0,
  skippedNoSession: [],
  skippedRunning: [],
  softDeletedSession: [],
  missingHtml: [],
  badFiles: [],
  failures: [],
};

function upsertSql() {
  // ON CONFLICT 谓词必须与部分唯一索引 idx_danmaku_analysis_session_active 的 WHERE 逐字一致（42P10）
  return `
    INSERT INTO danmaku_analysis_records
      (session_id, status, highlights, summary, model, llm_ok, llm_error,
       threshold_mode, stats, report_path, elapsed_s, error)
    VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, NULL)
    ON CONFLICT (session_id) WHERE deleted_at IS NULL
    DO UPDATE SET status = EXCLUDED.status, highlights = EXCLUDED.highlights,
                  summary = EXCLUDED.summary, model = EXCLUDED.model, llm_ok = EXCLUDED.llm_ok,
                  llm_error = EXCLUDED.llm_error, threshold_mode = EXCLUDED.threshold_mode,
                  stats = EXCLUDED.stats, report_path = EXCLUDED.report_path,
                  elapsed_s = EXCLUDED.elapsed_s, error = NULL, updated_at = NOW()
    RETURNING (xmax = 0) AS is_insert
  `;
}

async function main() {
  const dir = getDanmakuAnalysisDir();
  if (!fs.existsSync(dir)) {
    console.error(`分析产物目录不存在: ${dir}`);
    process.exit(1);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== INDEX_FILE)
    .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
  console.log(`扫描目录: ${dir}（${files.length} 个 JSON）${apply ? '[APPLY]' : '[dry-run]'}`);

  // 候选 sid 必须为纯数字文件名；非法名直接记账跳过
  const valid = [];
  for (const f of files) {
    const sid = f.slice(0, -5);
    if (!/^\d+$/.test(sid)) {
      report.badFiles.push(`${f}: 文件名不是 [数字].json`);
      continue;
    }
    valid.push({ sid: Number(sid), file: f });
  }

  // 批量核对会话存在性与软删状态
  const sids = valid.map((v) => v.sid);
  const sessionMap = new Map();
  if (sids.length) {
    const { rows } = await pool.query(
      `SELECT id, deleted_at IS NOT NULL AS is_deleted FROM recording_sessions WHERE id = ANY($1)`,
      [sids]
    );
    rows.forEach((r) => sessionMap.set(r.id, r.is_deleted));
  }

  const existingSql = `SELECT session_id, status FROM danmaku_analysis_records
                         WHERE session_id = ANY($1) AND deleted_at IS NULL`;
  const existingMap = new Map();
  if (sids.length) {
    const { rows } = await pool.query(existingSql, [sids]);
    rows.forEach((r) => existingMap.set(r.session_id, r.status));
  }

  for (const { sid, file } of valid) {
    report.scanned++;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
    } catch (err) {
      report.badFiles.push(`${file}: JSON 解析失败 ${err.message}`);
      continue;
    }

    if (!sessionMap.has(sid)) {
      report.skippedNoSession.push(file);
      continue;
    }
    if (sessionMap.get(sid)) report.softDeletedSession.push(file);
    if (existingMap.get(sid) === 'running') {
      report.skippedRunning.push(file);
      continue;
    }
    if (!data.stats || typeof data.stats !== 'object') {
      report.badFiles.push(`${file}: 缺少 stats 字段`);
      continue;
    }

    // 路径只信数字 sid 推导，不信 JSON 内任何路径字段
    const htmlPath = getDanmakuAnalysisHtmlPath(sid);
    if (!fs.existsSync(htmlPath)) report.missingHtml.push(file);

    const params = [
      sid,
      data.stats.no_danmaku ? 'no_danmaku' : 'completed',
      JSON.stringify(Array.isArray(data.highlights) ? data.highlights : []),
      data.summary || null,
      data.model || null,
      data.llm_ok === true,
      data.llm_error || null,
      data.stats.threshold_mode || null,
      JSON.stringify(data.stats),
      fs.existsSync(htmlPath) ? htmlPath : null,
      typeof data.elapsed_s === 'number' ? data.elapsed_s : null,
    ];

    if (!apply) {
      report.updated++; // dry-run 无法区分 insert/update，统一计入将写入
      continue;
    }
    try {
      const { rows } = await pool.query(upsertSql(), params);
      if (rows[0] && rows[0].is_insert) report.inserted++;
      else report.updated++;
    } catch (err) {
      report.failures.push(`${file}: ${err.message}`);
    }
  }

  console.log('--- 报告 ---');
  console.log(`扫描 JSON 数:         ${report.scanned}`);
  console.log(`新插入:               ${report.inserted}`);
  console.log(`${apply ? '覆盖更新' : '将写入（含新插入+覆盖）'}: ${report.updated}`);
  const sections = [
    ['无对应会话已跳过', report.skippedNoSession],
    ['已有 running 记录已跳过', report.skippedRunning],
    ['会话已软删（仍导入，请知悉）', report.softDeletedSession],
    ['HTML 报告文件缺失（report_path 置空）', report.missingHtml],
    ['文件异常已跳过', report.badFiles],
    ['落库失败', report.failures],
  ];
  for (const [title, list] of sections) {
    if (list.length) {
      console.log(`\n⚠️  ${title}（${list.length}）：`);
      list.forEach((m) => console.log(`  - ${m}`));
    }
  }
  console.log(`\n${apply ? '✅ 导入完成' : '（dry-run 结束，未写入任何数据）'}`);

  await pool.end();
  process.exit(report.failures.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('导入脚本异常:', err);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
