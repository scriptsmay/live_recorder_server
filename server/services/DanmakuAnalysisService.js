const fs = require('fs');
const dayjs = require('dayjs');
const pool = require('../db/index');
const DataService = require('./DataService');
const notify = require('../lib/core/notify');
const config = require('../config/config');
const {
  getDanmakuJsonlPath,
  getDanmakuAnalysisDir,
  getDanmakuAnalysisHtmlPath,
  getDanmakuAnalysisJsonPath,
} = require('../lib/utils/tool');
const llm = require('../lib/core/llm/litellm-client');

/**
 * AI 弹幕分析服务 — ADR-017 方案 B（统计高光点 + LLM 文字总结）
 *
 * 算法口径 = danmaku-batch/analyze.py（2026-10-16 批量 50 场实测验证），逐分支移植，不另立标准。
 * 四条调研实证约束（勿删）：
 *   1. like 权重对快手是死参数（0 条事件），保留仅为跨平台预留；
 *   2. 必须先剔除系统事件（gift_name="直播已停止" 或无身份行），否则末尾桶加权达真实峰值 93 倍、阈值被抬 7.6 倍；
 *   3. 礼物名是平台混淆串 → 只计数，报告不承诺礼物名分析；
 *   4. 样本按 score 降序取 top-N 区间 + 区间内去重 + 全局高频词单独成表（重复率约 47.7%）。
 * 批量实测新增两条（勿删）：
 *   5. 推理型模型 max_tokens 必须给 8000（1500 会被 reasoning 吃光、正文 0 字）；
 *   6. 全程高密度场次相对阈值失效 → 三层降级阈值 + 峰值补足（20% 场次靠它出高光）。
 */

const LOG = '[弹幕分析]';

// ---------------------------------------------------------------- 统计层常量（analyze.py 逐一对应）
const BUCKET_MS = 10000;
const COMMENT_WEIGHT = 1.0;
const GIFT_WEIGHT = 8.0;
const LIKE_WEIGHT = 0.0;
const PEAK_K = 2.5;
const PEAK_K_RELAXED = 1.5;
const FALLBACK_TOP_BUCKETS = 5;
const MIN_INTERVAL_BUCKETS = 2;
const MIN_HIGHLIGHTS = 5;
const TOP_N_HIGHLIGHTS = 10;
const SAMPLES_PER_INTERVAL = 20;
const GIFT_TOP_N = 10;
const PHRASE_TOP_N = 15;
const SYSTEM_GIFT_NAMES = new Set(['直播已停止']);
// 纯表情/占位弹幕（如 [666]），抽样时降权、不足才补位
const PLACEHOLDER_RE = /^\s*(\[[^\]]{1,8}\]\s*)+$/;

/** Python round 的半数位取偶（round half to even）等价实现，保证与 analyze.py 口径一致 */
function pyRound(value, places = 0) {
  const m = 10 ** places;
  const x = value * m;
  const fl = Math.floor(x);
  const diff = x - fl;
  let r;
  if (diff > 0.5) r = fl + 1;
  else if (diff < 0.5) r = fl;
  else r = fl % 2 === 0 ? fl : fl + 1;
  return r / m;
}

function fmean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/** nearest-rank 百分位（不插值），与选型调研基线口径一致 */
function percentile(sortedVals, pct) {
  if (!sortedVals.length) return 0.0;
  let idx = Math.ceil(pct * sortedVals.length) - 1;
  idx = Math.min(Math.max(idx, 0), sortedVals.length - 1);
  return sortedVals[idx];
}

/** 系统事件判定（约束 2）：gift 命中系统名，或「无身份」（未知/空用户名且无 user_id）——后者连 comment 也剔 */
function isSystemEvent(ev) {
  const type = ev.type || '';
  if (type === 'gift' && SYSTEM_GIFT_NAMES.has(ev.gift_name || '')) return true;
  const u = ev.username;
  if ((u === '未知' || u === '' || u === null || u === undefined) && !ev.user_id) return true;
  return false;
}

/** Counter.most_common 等价：按计数降序、并列按首次出现序（Map 插入序 + 稳定排序） */
function mostCommon(counter, n) {
  return [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function makeInterval(run, weighted) {
  const start = run[0] * BUCKET_MS;
  const end = (run[run.length - 1] + 1) * BUCKET_MS;
  let peak = -Infinity;
  let sum = 0;
  for (const b of run) {
    const w = weighted.get(b);
    if (w > peak) peak = w;
    sum += w;
  }
  const score = run.length ? sum / run.length : 0;
  return {
    start_ms: start,
    end_ms: end,
    score: pyRound(score, 1),
    peak_weighted: pyRound(peak, 1),
    bucket_start: run[0],
    bucket_end_last: run[run.length - 1],
    samples: [],
    label: '',
    reason: '',
  };
}

/**
 * 样本抽取（照抄 _pick_samples，含 hi+1 外扩一个桶的既有行为）
 * 第一遍去重取非占位（不收 20 上限），第二遍不足才补占位，最终截 20。
 */
function pickSamples(iv, buckets) {
  const lo = iv.bucket_start;
  const hi = iv.bucket_start + Math.ceil((iv.end_ms - iv.start_ms) / BUCKET_MS); // = 末桶 + 1
  const texts = [];
  for (let b = lo; b <= hi; b++) {
    const slot = buckets.get(b);
    if (slot) texts.push(...slot.texts);
  }
  const seen = new Set();
  const picked = [];
  for (const t of texts) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (!PLACEHOLDER_RE.test(t)) picked.push(t);
  }
  const pickedSet = new Set(picked);
  for (const t of texts) {
    if (picked.length >= SAMPLES_PER_INTERVAL) break;
    if (!pickedSet.has(t) && PLACEHOLDER_RE.test(t)) {
      picked.push(t);
      pickedSet.add(t);
    }
  }
  return picked.slice(0, SAMPLES_PER_INTERVAL);
}

/**
 * 统计层纯函数：事件列表 → (stats, intervals)
 *
 * @param {string|number} sessionId
 * @param {Array<Object>} events - 已解析的 JSONL 对象行
 * @param {number} badLines - 解析失败行数
 */
function computeStats(sessionId, events, badLines) {
  const comments = events.filter((e) => (e.type || '') === 'comment');
  const gifts = events.filter((e) => (e.type || '') === 'gift' && !isSystemEvent(e));
  const likes = events.filter((e) => (e.type || '') === 'like');

  const tsList = [];
  for (const e of events) {
    if (typeof e.ts_ms === 'number' && Number.isFinite(e.ts_ms)) tsList.push(e.ts_ms);
  }
  const spanMs = tsList.length ? Math.max(...tsList) - Math.min(...tsList) : 0;
  const spanMin = spanMs / 60000;

  // 10s 桶：comment_all=统计口径（含系统行），comment/texts=检测口径（剔系统行）
  const buckets = new Map();
  for (const e of events) {
    const t = e.ts_ms;
    if (typeof t !== 'number' || !Number.isFinite(t)) continue;
    const b = Math.floor(t / BUCKET_MS);
    let slot = buckets.get(b);
    if (!slot) {
      slot = { comment: 0, comment_all: 0, gift: 0, like: 0, texts: [] };
      buckets.set(b, slot);
    }
    const type = e.type || '';
    if (type === 'comment') {
      slot.comment_all += 1;
      if (isSystemEvent(e)) continue;
      slot.comment += 1;
      const txt = String(e.text || '').trim();
      if (txt) slot.texts.push(txt);
    } else if (isSystemEvent(e)) {
      continue;
    } else if (type === 'gift') {
      slot.gift += 1;
    } else if (type === 'like') {
      slot.like += 1;
    }
  }

  const commentCounts = [...buckets.values()].map((v) => v.comment_all);
  const weighted = new Map();
  for (const [b, v] of buckets) {
    weighted.set(b, v.comment * COMMENT_WEIGHT + v.gift * GIFT_WEIGHT + v.like * LIKE_WEIGHT);
  }
  const wVals = [...weighted.values()];
  const meanW = fmean(wVals);
  let threshold = meanW * PEAK_K;

  // 60s 桶（统计口径，仅 comment，含系统行）
  const minBuckets = new Map();
  for (const e of comments) {
    const t = e.ts_ms;
    if (typeof t !== 'number' || !Number.isFinite(t)) continue;
    const b = Math.floor(t / 60000);
    minBuckets.set(b, (minBuckets.get(b) || 0) + 1);
  }
  const minCounts = [...minBuckets.values()];

  const bucketOrder = [...weighted.keys()].sort((a, b) => a - b);
  const byWeightDesc = [...weighted.keys()].sort((a, b) => weighted.get(b) - weighted.get(a));

  function intervalsWith(thr, minB, singleTop = 0) {
    const out = [];
    let run = [];
    for (const b of bucketOrder) {
      if (thr > 0 && weighted.get(b) >= thr) {
        run.push(b);
      } else {
        if (run.length >= minB) out.push(makeInterval(run, weighted));
        run = [];
      }
    }
    if (run.length >= minB) out.push(makeInterval(run, weighted));
    if (!out.length && singleTop) {
      for (const b of byWeightDesc.slice(0, singleTop)) {
        out.push(makeInterval([b], weighted));
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  // 三层降级：均值×2.5（≥2桶）→ 均值×1.5 → 绝对峰值+单桶
  let intervals = intervalsWith(threshold, MIN_INTERVAL_BUCKETS);
  let thresholdMode = 'mean_x_K';
  if (!intervals.length && wVals.length) {
    threshold = meanW * PEAK_K_RELAXED;
    intervals = intervalsWith(threshold, MIN_INTERVAL_BUCKETS);
    thresholdMode = 'relaxed_mean_x_K';
  }
  if (!intervals.length && wVals.length) {
    threshold = Math.max(...wVals);
    intervals = intervalsWith(threshold, 1, FALLBACK_TOP_BUCKETS);
    thresholdMode = 'fallback_top_buckets';
  }

  // 峰值补足：区间数 < MIN_HIGHLIGHTS 时按加权降序补未覆盖桶（单桶成段不合并）
  if (wVals.length && intervals.length < MIN_HIGHLIGHTS) {
    const covered = new Set();
    for (const iv of intervals) {
      const lo = Math.floor(iv.start_ms / BUCKET_MS);
      const hi = Math.floor(iv.end_ms / BUCKET_MS);
      for (let b = lo; b < hi; b++) covered.add(b);
    }
    for (const b of byWeightDesc) {
      if (intervals.length >= MIN_HIGHLIGHTS) break;
      if (covered.has(b)) continue;
      intervals.push(makeInterval([b], weighted));
      covered.add(b);
    }
    intervals.sort((a, b) => b.score - a.score);
    thresholdMode += '+top_up';
  }
  intervals.sort((a, b) => b.score - a.score);

  for (const iv of intervals.slice(0, TOP_N_HIGHLIGHTS)) {
    iv.samples = pickSamples(iv, buckets);
  }

  const texts = comments.map((e) => String(e.text || '').trim()).filter((t) => t);
  const uniqTexts = new Set(texts);
  const dup = texts.length - uniqTexts.size;
  const phraseCounter = new Map();
  for (const t of texts) phraseCounter.set(t, (phraseCounter.get(t) || 0) + 1);
  const giftCounter = new Map();
  for (const e of gifts) {
    const name = e.gift_name || '(未知)';
    giftCounter.set(name, (giftCounter.get(name) || 0) + 1);
  }

  const userIds = new Set();
  for (const e of comments) {
    if (e.user_id) userIds.add(e.user_id);
  }

  const maxBucket = buckets.size ? Math.max(...buckets.keys()) : -1;
  const series = [];
  for (let b = 0; b <= maxBucket; b++) {
    series.push(pyRound(weighted.get(b) || 0.0, 1));
  }

  const sorted10s = [...commentCounts].sort((a, b) => a - b);
  const sorted60s = [...minCounts].sort((a, b) => a - b);

  const stats = {
    session_id: String(sessionId),
    total_lines: events.length,
    parse_failures: badLines,
    type_counts: {
      comment: comments.length,
      gift: gifts.length,
      gift_system_filtered: events.filter(isSystemEvent).length,
      like: likes.length,
    },
    span_minutes: pyRound(spanMin, 1),
    rate_per_min: spanMin ? pyRound(comments.length / spanMin, 1) : 0.0,
    unique_users: userIds.size,
    dup_text: dup,
    dup_rate: texts.length ? pyRound(dup / texts.length, 4) : 0.0,
    text_len_mean: texts.length ? pyRound(fmean(texts.map((t) => t.length)), 1) : 0.0,
    bucket_10s_comment: {
      max: commentCounts.length ? Math.max(...commentCounts) : 0,
      p99: pyRound(percentile(sorted10s, 0.99), 1),
      p90: pyRound(percentile(sorted10s, 0.9), 1),
      p50: pyRound(percentile(sorted10s, 0.5), 1),
      mean: pyRound(fmean(commentCounts), 1),
    },
    bucket_60s_comment: {
      max: minCounts.length ? Math.max(...minCounts) : 0,
      p90: pyRound(percentile(sorted60s, 0.9), 1),
      p50: pyRound(percentile(sorted60s, 0.5), 1),
      mean: pyRound(fmean(minCounts), 1),
    },
    weighted_mean_10s: pyRound(meanW, 2),
    threshold: pyRound(threshold, 2),
    threshold_mode: thresholdMode,
    no_danmaku: comments.length === 0,
    intervals_total: intervals.length,
    top_phrases: mostCommon(phraseCounter, PHRASE_TOP_N),
    top_gifts: mostCommon(giftCounter, GIFT_TOP_N),
    series_10s: series,
  };
  return { stats, intervals };
}

// ---------------------------------------------------------------- LLM 输入构造
function fmtHms(ms) {
  const totalSec = Math.floor(ms / 1000);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}`;
}

function buildPayload(stats, intervals) {
  const top = intervals.slice(0, TOP_N_HIGHLIGHTS);
  const lines = [
    '【整场概览】',
    `时长 ${stats.span_minutes} 分钟；弹幕 ${stats.type_counts.comment} 条；` +
      `均速 ${stats.rate_per_min} 条/分；独立用户 ${stats.unique_users}；` +
      `文本重复率 ${pyRound(stats.dup_rate * 100, 1)}%；礼物事件 ${stats.type_counts.gift} 次。`,
    `10s 桶峰值 ${stats.bucket_10s_comment.max}、p90 ${stats.bucket_10s_comment.p90}、均值 ${stats.bucket_10s_comment.mean}。`,
    '高频刷屏词：' +
      stats.top_phrases
        .slice(0, 8)
        .map(([t, c]) => `${t}×${c}`)
        .join('、'),
    '',
    `【高光候选区间（共 ${top.length} 个，按热度排序）】`,
  ];
  top.forEach((iv, idx) => {
    lines.push(`${idx + 1}. ${fmtHms(iv.start_ms)}（峰值加权 ${iv.peak_weighted}）样本弹幕：`);
    lines.push('   ' + iv.samples.slice(0, SAMPLES_PER_INTERVAL).join(' | '));
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------- HTML 报告
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHtml(res) {
  const st = res.stats;
  const ivs = res.intervals;
  const series = st.series_10s;
  const peak = series.length ? Math.max(...series) : 1;
  const width = 900;
  const height = 180;
  const pad = 28;

  const pts = [];
  if (series.length) {
    const step = width / Math.max(series.length - 1, 1);
    series.forEach((v, i) => {
      const x = pad + i * step;
      const y = height - pad - (v / peak) * (height - 2 * pad);
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    });
  }
  const marks = [];
  for (const iv of ivs.slice(0, TOP_N_HIGHLIGHTS)) {
    const b = Math.floor(iv.start_ms / BUCKET_MS);
    const frac = series.length ? b / Math.max(series.length - 1, 1) : 0;
    const x = pad + frac * width;
    marks.push(
      `<line x1="${x.toFixed(1)}" y1="${pad}" x2="${x.toFixed(1)}" y2="${height - pad}" stroke="#e11d48" stroke-width="1.5" stroke-dasharray="4 3"/>`
    );
  }

  const hlBlocks = ivs
    .slice(0, TOP_N_HIGHLIGHTS)
    .map((iv, idx) => {
      const samples = iv.samples.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
      return `
        <div class="hl">
          <div class="hl-head"><span class="badge">#${idx + 1}</span>
            <b>${fmtHms(iv.start_ms)} – ${fmtHms(iv.end_ms)}</b>
            <span class="muted">峰值加权 ${iv.peak_weighted} · 均加权 ${iv.score}</span></div>
          <div class="label">${escapeHtml(iv.label || '（LLM 未标注）')}</div>
          <div class="reason">${escapeHtml(iv.reason || '')}</div>
          <ul class="samples">${samples}</ul>
        </div>`;
    })
    .join('');

  const phrases = st.top_phrases.map(([t, c]) => `<li>${escapeHtml(t)} ×${c}</li>`).join('');
  const gifts = st.top_gifts.map(([g, c]) => `<li>${escapeHtml(g)} ×${c}</li>`).join('');
  const llmNote = res.llm_ok
    ? ''
    : `<p class="warn">LLM 层未成功（${escapeHtml(res.llm_error || '未调用')}），本报告为纯统计结果。</p>`;

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>弹幕分析 · 会话 ${escapeHtml(res.session_id)}</title>
<style>
 :root{--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--acc:#e11d48}
 *{box-sizing:border-box}
 body{margin:0;padding:24px;background:#f8fafc;color:var(--fg);
   font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
 .wrap{max-width:960px;margin:0 auto}
 h1{font-size:20px;margin:0 0 4px} h2{font-size:16px;margin:28px 0 10px}
 .muted{color:var(--muted);font-size:13px}
 .card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px;margin:14px 0}
 table{border-collapse:collapse;width:100%;font-size:14px}
 td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left}
 .hl{border-left:3px solid var(--acc);padding:8px 0 8px 12px;margin:14px 0}
 .hl-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
 .badge{background:var(--acc);color:#fff;border-radius:6px;padding:1px 7px;font-size:12px}
 .label{font-weight:600;margin:6px 0 2px}
 .reason{color:#334155;font-size:14px}
 .samples{margin:8px 0 0;padding-left:20px;color:var(--muted);font-size:13px;columns:2;column-gap:24px}
 .warn{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;padding:8px 12px;border-radius:8px;font-size:13px}
 ul.two{columns:2;column-gap:24px;padding-left:20px;font-size:14px}
</style></head><body><div class="wrap">
<h1>弹幕分析报告 · 会话 ${escapeHtml(res.session_id)}</h1>
<div class="muted">生成时间 ${dayjs().format('YYYY-MM-DD HH:mm:ss')} · 模型 ${escapeHtml(res.model || '-')} · 耗时 ${(res.elapsed_s ?? 0).toFixed(1)}s</div>
${llmNote}
<div class="card"><h2>整场总结</h2><p>${escapeHtml(res.summary || '（无）')}</p></div>
<div class="card"><h2>弹幕密度（10s 加权，红线为高光区间）</h2>
<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none">
 <rect x="0" y="0" width="${width}" height="${height}" fill="#fff"/>
 <polyline fill="none" stroke="#2563eb" stroke-width="1.6" points="${pts.join(' ')}"/>
 ${marks.join('')}
</svg>
<div class="muted">峰值加权 ${peak} · 阈值 ${st.threshold}（均值 ${st.weighted_mean_10s}，模式 ${escapeHtml(st.threshold_mode || '-')}） · 全片 ${st.span_minutes} 分钟</div></div>
<div class="card"><h2>统计概览</h2>
<table><tr><th>指标</th><th>值</th></tr>
<tr><td>弹幕总量</td><td>${st.type_counts.comment} 条（gift ${st.type_counts.gift} 次，已剔除系统事件 ${st.type_counts.gift_system_filtered} 条）</td></tr>
<tr><td>弹幕时长 / 均速</td><td>${st.span_minutes} 分钟 / ${st.rate_per_min} 条·分⁻¹</td></tr>
<tr><td>独立用户</td><td>${st.unique_users}</td></tr>
<tr><td>文本重复率</td><td>${pyRound(st.dup_rate * 100, 1)}%（重复 ${st.dup_text} 条，均值长度 ${st.text_len_mean} 字）</td></tr>
<tr><td>10s 桶（comment）</td><td>max ${st.bucket_10s_comment.max} · p99 ${st.bucket_10s_comment.p99} · p90 ${st.bucket_10s_comment.p90} · p50 ${st.bucket_10s_comment.p50} · mean ${st.bucket_10s_comment.mean}</td></tr>
<tr><td>60s 桶（comment）</td><td>max ${st.bucket_60s_comment.max} · p90 ${st.bucket_60s_comment.p90} · p50 ${st.bucket_60s_comment.p50} · mean ${st.bucket_60s_comment.mean}</td></tr>
<tr><td>高光区间</td><td>检出 ${st.intervals_total} 个，展示前 ${Math.min(ivs.length, TOP_N_HIGHLIGHTS)} 个</td></tr>
</table></div>
<div class="card"><h2>高光区间</h2>${hlBlocks || '<p class="muted">未检出</p>'}</div>
<div class="card"><h2>高频刷屏词</h2><ul class="two">${phrases}</ul>
<h2>礼物事件（仅计数，礼物名为平台混淆串）</h2><ul class="two">${gifts || '<li>无</li>'}</ul></div>
<p class="muted">由 K-Recorder AI 弹幕分析生成。算法口径见 ADR-017 与选型调研。</p>
</div></body></html>`;
}

function serializeResult(res) {
  return {
    session_id: res.session_id,
    stats: res.stats,
    summary: res.summary,
    llm_ok: res.llm_ok,
    llm_error: res.llm_error,
    model: res.model,
    elapsed_s: res.elapsed_s,
    highlights: res.intervals.slice(0, TOP_N_HIGHLIGHTS).map((iv) => ({
      start_ms: iv.start_ms,
      end_ms: iv.end_ms,
      score: iv.score,
      peak_weighted: iv.peak_weighted,
      label: iv.label,
      reason: iv.reason,
      samples: iv.samples,
    })),
  };
}

// ---------------------------------------------------------------- 编排层
const MAX_CONCURRENCY = 2;

class DanmakuAnalysisService {
  constructor() {
    this._inFlight = new Set();
    this._queue = [];
    this._runningCount = 0;
  }

  /**
   * 入队分析请求（fire-and-forget，watchdog 与手动触发共用）
   *
   * @param {number|string} sessionId
   * @param {Object} [options]
   * @param {boolean} [options.force=false] - 已完成场次也重算
   * @returns {Promise<{accepted: boolean, state: string, message?: string}>}
   */
  async requestAnalysis(sessionId, { force = false } = {}) {
    if (this._inFlight.has(String(sessionId))) {
      return { accepted: false, state: 'running', message: '该会话正在分析中' };
    }
    const existing = await this.getRecord(sessionId);
    if (existing && existing.status === 'running') {
      return { accepted: false, state: 'running', message: '该会话正在分析中' };
    }
    if (existing && existing.status === 'completed' && !force) {
      return { accepted: false, state: 'completed', message: '已有分析结果（可用 force 重算）' };
    }
    this._inFlight.add(String(sessionId));
    this._enqueue(sessionId, { force });
    return { accepted: true, state: 'running' };
  }

  _enqueue(sessionId, options) {
    this._queue.push({ sessionId, options });
    this._drain();
  }

  _drain() {
    while (this._runningCount < MAX_CONCURRENCY && this._queue.length) {
      const { sessionId, options } = this._queue.shift();
      this._runningCount++;
      this.analyzeSession(sessionId, options)
        .catch((err) => {
          console.error(`${LOG} 会话 ${sessionId} 分析异常:`, err.message);
        })
        .finally(() => {
          this._runningCount--;
          this._inFlight.delete(String(sessionId));
          this._drain();
        });
    }
  }

  async getRecord(sessionId) {
    const { rows } = await pool.query(
      `SELECT * FROM danmaku_analysis_records WHERE session_id = $1 AND deleted_at IS NULL`,
      [sessionId]
    );
    return rows[0] || null;
  }

  /**
   * 分析记录列表（软删过滤 + 关联会话/房间，分页惯例同 getTranscodeRecords）
   */
  async listRecords({ status, limit = 50, page } = {}) {
    const conditions = ['dar.deleted_at IS NULL'];
    const params = [];
    if (status) {
      conditions.push(`dar.status = $${params.length + 1}`);
      params.push(status);
    }
    const where = ' WHERE ' + conditions.join(' AND ');
    let listSql = `SELECT dar.id, dar.session_id, dar.status, dar.summary, dar.model, dar.llm_ok,
                          dar.llm_error, dar.threshold_mode, dar.elapsed_s,
                          dar.created_at, dar.updated_at,
                          dar.stats->'type_counts'->>'comment' AS comment_count,
                          dar.stats->>'span_minutes' AS span_minutes,
                          dar.stats->>'intervals_total' AS intervals_total,
                          rs.room_url, rm.room_name
                   FROM danmaku_analysis_records dar
                   LEFT JOIN recording_sessions rs ON dar.session_id = rs.id
                   LEFT JOIN rooms rm ON rs.room_url = rm.room_url AND rm.deleted_at IS NULL${where}
                   ORDER BY dar.session_id DESC`;
    let countSql = `SELECT COUNT(*)::int AS total FROM danmaku_analysis_records dar${where}`;
    if (page) {
      const pageSize = parseInt(limit, 10) || 50;
      listSql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      const countParams = [...params];
      params.push(pageSize, (parseInt(page, 10) - 1) * pageSize);
      const [{ rows: countRows }, { rows }] = await Promise.all([
        pool.query(countSql, countParams),
        pool.query(listSql, params),
      ]);
      return { rows, total: countRows[0].total };
    }
    listSql += ` LIMIT $${params.length + 1}`;
    params.push(parseInt(limit, 10) || 50);
    const { rows } = await pool.query(listSql, params);
    return { rows, total: rows.length };
  }

  /**
   * 单场详情（含高光点与统计，供前端详情/会话内嵌区块）
   */
  async getRecordDetail(sessionId) {
    const { rows } = await pool.query(
      `SELECT dar.*, rs.room_url, rm.room_name
       FROM danmaku_analysis_records dar
       LEFT JOIN recording_sessions rs ON dar.session_id = rs.id
       LEFT JOIN rooms rm ON rs.room_url = rm.room_url AND rm.deleted_at IS NULL
       WHERE dar.session_id = $1 AND dar.deleted_at IS NULL`,
      [sessionId]
    );
    return rows[0] || null;
  }

  /**
   * 单场完整分析：读 JSONL → 统计层 → LLM 层 → HTML/JSON 落盘 → 落库 → 通知
   *
   * 任何一步失败只写 error/status，不抛出到调用方主链路（录制/投稿零影响）。
   */
  async analyzeSession(sessionId, { force = false } = {}) {
    const t0 = Date.now();
    const sid = String(sessionId);
    const { rows } = await pool.query(
      `SELECT rs.id, rs.room_url, rs.status AS session_status, r.room_name
       FROM recording_sessions rs
       LEFT JOIN rooms r ON rs.room_url = r.room_url
       WHERE rs.id = $1 AND rs.deleted_at IS NULL`,
      [sid]
    );
    if (!rows.length) {
      throw new Error(`会话 ${sid} 不存在`);
    }
    const session = rows[0];

    const existing = await this.getRecord(sid);
    let recordId;
    if (existing) {
      if (existing.status === 'completed' && !force) {
        return { record: existing, skipped: true };
      }
      recordId = existing.id;
      await pool.query(
        `UPDATE danmaku_analysis_records SET status = 'running', error = NULL, updated_at = NOW() WHERE id = $1`,
        [recordId]
      );
    } else {
      const { rows: ins } = await pool.query(
        `INSERT INTO danmaku_analysis_records (session_id, status) VALUES ($1, 'running')
         ON CONFLICT (session_id) WHERE deleted_at IS NULL DO UPDATE SET status = 'running', error = NULL, updated_at = NOW()
         RETURNING id`,
        [sid]
      );
      recordId = ins[0].id;
    }

    try {
      const result = await this._runPipeline(sid, session);
      result.elapsed_s = pyRound((Date.now() - t0) / 1000, 1);
      await this._finishRecord(recordId, result);
      await this._maybeNotify(session, result);
      return result;
    } catch (err) {
      await pool.query(
        `UPDATE danmaku_analysis_records SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`,
        [recordId, String(err.message || err).slice(0, 500)]
      );
      throw err;
    }
  }

  async _runPipeline(sid) {
    const jsonlPath = getDanmakuJsonlPath(sid);
    let content;
    try {
      content = await fs.promises.readFile(jsonlPath, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`弹幕 JSONL 不存在: ${jsonlPath}`);
      }
      throw err;
    }

    // 与 analyze.py load_events 同口径：坏行计数不中断；非对象行也计入 parse_failures
    const events = [];
    let bad = 0;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch (_) {
        bad++;
        continue;
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj._meta) {
        bad++;
        continue;
      }
      events.push(obj);
    }

    const { stats, intervals } = computeStats(sid, events, bad);
    const res = {
      session_id: sid,
      stats,
      intervals,
      summary: '',
      model: '',
      llm_ok: false,
      llm_error: '',
      elapsed_s: 0,
    };

    if (stats.no_danmaku) {
      res.llm_error = '无弹幕数据（该场 0 条 comment，通常是采集时为空的 JSONL）';
    } else if (!intervals.length) {
      res.llm_error = '无高光区间，未调用 LLM';
    } else {
      const baseUrl = ((await DataService.getSetting('ai_analysis_base_url', '')) || '').trim();
      const apiKey = config.AI_ANALYSIS_API_KEY;
      if (!baseUrl || !apiKey) {
        res.llm_error = '未配置 ai_analysis_base_url 或 AI_ANALYSIS_API_KEY，跳过 LLM（纯统计报告）';
      } else {
        const model = (await DataService.getSetting('ai_analysis_model', llm.DEFAULT_MODEL)) || llm.DEFAULT_MODEL;
        const fallbacks = config.AI_ANALYSIS_FALLBACK_MODELS
          ? config.AI_ANALYSIS_FALLBACK_MODELS.split(',')
              .map((m) => m.trim())
              .filter(Boolean)
          : llm.DEFAULT_FALLBACK_MODELS;
        const payload = buildPayload(stats, intervals);
        const callRes = await llm.completeWithFallback({
          baseUrl,
          apiKey,
          model,
          fallbackModels: fallbacks,
          payload,
          temperature: llm.DEFAULT_TEMPERATURE,
          maxTokens: llm.DEFAULT_MAX_TOKENS,
        });
        if (callRes.data) {
          res.model = callRes.model;
          res.summary = String(callRes.data.session_summary || '').trim();
          res.llm_ok = true;
          const byIdx = new Map();
          for (const h of callRes.data.highlights || []) {
            if (h && typeof h === 'object' && /^\d+$/.test(String(h.index ?? ''))) {
              byIdx.set(parseInt(String(h.index), 10), h);
            }
          }
          res.intervals.slice(0, TOP_N_HIGHLIGHTS).forEach((iv, i) => {
            const h = byIdx.get(i + 1);
            if (h) {
              iv.label = String(h.label || '').slice(0, 40);
              iv.reason = String(h.reason || '');
            }
          });
        } else {
          res.llm_error = callRes.errors.slice(-3).join(' | ') || '全部模型失败';
        }
      }
    }

    // 落盘（VIDEO_DOWNLOAD_DIR 下保留目录，先 mkdir；覆写即重算）
    await fs.promises.mkdir(getDanmakuAnalysisDir(), { recursive: true });
    const htmlPath = getDanmakuAnalysisHtmlPath(sid);
    const jsonPath = getDanmakuAnalysisJsonPath(sid);
    const serialized = serializeResult(res);
    await fs.promises.writeFile(jsonPath, JSON.stringify(serialized, null, 1), 'utf-8');
    await fs.promises.writeFile(htmlPath, renderHtml(res), 'utf-8');
    res.report_path = htmlPath;
    return res;
  }

  async _finishRecord(recordId, result) {
    const highlights = result.intervals.slice(0, TOP_N_HIGHLIGHTS);
    const status = result.stats.no_danmaku ? 'no_danmaku' : 'completed';
    await pool.query(
      `UPDATE danmaku_analysis_records
       SET status = $2, highlights = $3::jsonb, summary = $4, model = $5, llm_ok = $6,
           llm_error = $7, threshold_mode = $8, stats = $9::jsonb, report_path = $10,
           elapsed_s = $11, error = NULL, updated_at = NOW()
       WHERE id = $1`,
      [
        recordId,
        status,
        JSON.stringify(highlights),
        result.summary || null,
        result.model || null,
        result.llm_ok,
        result.llm_error || null,
        result.stats.threshold_mode,
        // stats 整体入库（含 series_10s，供前端画曲线），单场最大约 1500 桶，体积可接受
        JSON.stringify(result.stats),
        result.report_path,
        result.elapsed_s,
      ]
    );
  }

  async _maybeNotify(session, result) {
    try {
      const notifyEnabled = await DataService.getSetting('ai_analysis_notify_enabled', 'true');
      if (notifyEnabled !== 'true') return;
      await notify.danmakuAnalysisComplete({
        roomUrl: session.room_url,
        sessionId: result.session_id,
        roomName: session.room_name || '',
        highlightCount: result.stats.intervals_total,
        summary: result.summary,
        llmOk: result.llm_ok,
        elapsedS: result.elapsed_s,
      });
    } catch (err) {
      console.error(`${LOG} 通知发送失败:`, err.message);
    }
  }
}

module.exports = new DanmakuAnalysisService();
module.exports.computeStats = (...args) => computeStats(...args);
module.exports.serializeResult = serializeResult;
module.exports.renderHtml = renderHtml;
module.exports.buildPayload = buildPayload;
module.exports.pyRound = pyRound;
module.exports.isSystemEvent = isSystemEvent;
module.exports.percentile = percentile;
module.exports.TOP_N_HIGHLIGHTS = TOP_N_HIGHLIGHTS;
