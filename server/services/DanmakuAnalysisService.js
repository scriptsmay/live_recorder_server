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
 * AI 弹幕分析服务（统计高光点 + LLM 文字总结）
 *
 * 算法口径 = 离线批量回算脚本 analyze.py（2026-10-16 批量 50 场实测验证），逐分支移植，不另立标准。
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

  const emojiCounter = new Map();
  const phraseTextCounter = new Map();
  for (const [t, c] of phraseCounter) {
    if (PLACEHOLDER_RE.test(t)) {
      emojiCounter.set(t, c);
    } else {
      phraseTextCounter.set(t, c);
    }
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
    llm_tags: {
      atmosphere: [],
      nicknames: [],
      concerns: [],
    },
    wordcloud: {
      emojis: mostCommon(emojiCounter, 10),
      phrases: mostCommon(phraseTextCounter, 15),
    },
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

/**
 * 防御性清洗 LLM 语义标签（非数组转空、过滤非字符串与空串、trim、截断 15 字、最多 5 项）
 */
function sanitizeTags(arr, maxItems = 5, maxLen = 15) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .map((x) => x.slice(0, maxLen))
    .slice(0, maxItems);
}

function buildPayload(stats, intervals) {
  const top = intervals.slice(0, TOP_N_HIGHLIGHTS);
  const lines = [
    '【整场概览】',
    `时长 ${stats.span_minutes} 分钟；弹幕 ${stats.type_counts.comment} 条；` +
      `均速 ${stats.rate_per_min} 条/分；独立用户 ${stats.unique_users}；` +
      `文本重复率 ${pyRound(stats.dup_rate * 100, 1)}%；礼物事件 ${stats.type_counts.gift} 次。`,
    `10s 桶峰值 ${stats.bucket_10s_comment.max}、p90 ${stats.bucket_10s_comment.p90}、均值 ${stats.bucket_10s_comment.mean}。`,
    '高频刷屏词：' + stats.top_phrases.map(([t, c]) => `${t}×${c}`).join('、'),
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
  const st = res.stats || {};
  const ivs = res.intervals || [];
  const series = st.series_10s || [];
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

  // LLM 氛围标签
  const atmoTags = st.llm_tags && Array.isArray(st.llm_tags.atmosphere) ? st.llm_tags.atmosphere : [];
  const atmoHtml = atmoTags.length
    ? `<div class="chips-container">${atmoTags.map((t) => `<span class="chip-atmo">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';

  // 高光时间轴卡片
  const hlBlocks = ivs
    .slice(0, TOP_N_HIGHLIGHTS)
    .map((iv, idx) => {
      const samples = (iv.samples || []).map((s) => `<span class="sample-tag">${escapeHtml(s)}</span>`).join('');
      return `
        <div class="hl-card">
          <div class="hl-head">
            <span class="hl-badge">#${idx + 1}</span>
            <span class="hl-time">${fmtHms(iv.start_ms)} – ${fmtHms(iv.end_ms)}</span>
            <span class="hl-title">${escapeHtml(iv.label || '热度飙升')}</span>
            <span class="muted" style="margin-left:auto;font-size:12px;">峰值加权 ${iv.peak_weighted} · 均加权 ${iv.score}</span>
          </div>
          ${iv.reason ? `<div class="hl-reason">${escapeHtml(iv.reason)}</div>` : ''}
          ${samples ? `<div class="hl-samples">${samples}</div>` : ''}
        </div>`;
    })
    .join('');

  // 词云分桶（带向下兼容降级）
  let emojis = [];
  let phrases = [];
  if (st.wordcloud) {
    emojis = st.wordcloud.emojis || [];
    phrases = st.wordcloud.phrases || [];
  } else if (st.top_phrases) {
    emojis = st.top_phrases.filter(([t]) => PLACEHOLDER_RE.test(t));
    phrases = st.top_phrases.filter(([t]) => !PLACEHOLDER_RE.test(t));
  }
  const nicknames = st.llm_tags && Array.isArray(st.llm_tags.nicknames) ? st.llm_tags.nicknames : [];
  const concerns = st.llm_tags && Array.isArray(st.llm_tags.concerns) ? st.llm_tags.concerns : [];

  const emojiHtml = emojis.length
    ? `<div class="sub-block">
        <div class="sub-title">常用表情包</div>
        <div class="cloud-tags">
          ${emojis.map(([e, c]) => `<span class="tag-emoji">${escapeHtml(e)} <small>×${c}</small></span>`).join('')}
        </div>
      </div>`
    : '';

  const phraseHtml = phrases.length
    ? `<div class="sub-block">
        <div class="sub-title">刷屏热词</div>
        <div class="cloud-tags">
          ${phrases.map(([p, c]) => `<span class="tag-phrase">${escapeHtml(p)} <small>×${c}</small></span>`).join('')}
        </div>
      </div>`
    : '';

  const nickHtml = nicknames.length
    ? `<div class="sub-block">
        <div class="sub-title">粉丝昵称</div>
        <div class="cloud-tags">
          ${nicknames.map((n) => `<span class="tag-nick">${escapeHtml(n)}</span>`).join('')}
        </div>
      </div>`
    : '';

  const concernHtml = concerns.length
    ? `<div class="sub-block">
        <div class="sub-title">观众关心的事</div>
        <ul class="concern-list">
          ${concerns.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}
        </ul>
      </div>`
    : '';

  const gifts = (st.top_gifts || [])
    .map(([g, c]) => `<span class="tag-gift">${escapeHtml(g)} <small>×${c}</small></span>`)
    .join('');
  const giftHtml = gifts
    ? `<div class="sub-block">
        <div class="sub-title">礼物互动 <small class="muted" style="font-weight:normal;">（共 ${st.type_counts ? st.type_counts.gift : 0} 次，仅计数）</small></div>
        <div class="cloud-tags">${gifts}</div>
      </div>`
    : '';

  const llmNote = res.llm_ok
    ? ''
    : `<p class="warn">LLM 层未成功（${escapeHtml(res.llm_error || '未调用')}），本报告为纯统计结果。</p>`;

  const typeCounts = st.type_counts || {};
  const b10 = st.bucket_10s_comment || {};
  const b60 = st.bucket_60s_comment || {};

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>弹幕分析 · 会话 ${escapeHtml(res.session_id)}</title>
<style>
 :root{--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--primary:#e11d48;--primary-light:#fff1f2}
 *{box-sizing:border-box}
 body{margin:0;padding:24px;background:#f8fafc;color:var(--fg);
   font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
 .wrap{max-width:960px;margin:0 auto}
 h1{font-size:22px;margin:0 0 4px;font-weight:700}
 h2{font-size:16px;margin:0 0 14px;font-weight:600;color:#1e293b}
 .muted{color:var(--muted);font-size:13px}
 .card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px;margin:16px 0}
 .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0}
 .stat-card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 18px}
 .stat-label{font-size:13px;color:var(--muted);font-weight:500}
 .stat-val{font-size:24px;font-weight:700;color:var(--fg);margin-top:4px}
 .stat-val small{font-size:14px;font-weight:normal;color:var(--muted);margin-left:2px}
 .stat-sub{font-size:12px;color:var(--muted);margin-top:4px}
 .chips-container{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
 .chip-atmo{background:#fdf2f8;color:#9d174d;border:1px solid #fbcfe8;font-size:12px;font-weight:600;padding:2px 10px;border-radius:9999px}
 .summary-text{font-size:15px;line-height:1.7;color:#1e293b;margin:0}
 .hl-card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0;border-left:3px solid var(--primary)}
 .hl-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}
 .hl-badge{background:var(--primary);color:#fff;border-radius:6px;padding:1px 8px;font-size:12px;font-weight:600}
 .hl-time{font-family:monospace;font-size:13px;font-weight:700;background:#f1f5f9;padding:2px 6px;border-radius:4px;color:#0f172a}
 .hl-title{font-size:14px;font-weight:600;color:#0f172a}
 .hl-reason{color:#334155;font-size:13px;margin:6px 0 8px}
 .hl-samples{display:flex;flex-wrap:wrap;gap:6px}
 .sample-tag{font-size:12px;background:#f8fafc;color:#475569;border:1px solid #e2e8f0;padding:2px 8px;border-radius:6px;max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 .sub-block{margin-top:16px}
 .sub-block:first-of-type{margin-top:0}
 .sub-title{font-size:14px;font-weight:600;color:#334155;margin-bottom:8px}
 .cloud-tags{display:flex;flex-wrap:wrap;gap:8px}
 .tag-emoji{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0;padding:3px 10px;border-radius:9999px;font-size:13px}
 .tag-phrase{background:#eff6ff;color:#1e40af;border:1px solid #bfdbfe;padding:3px 10px;border-radius:9999px;font-size:13px}
 .tag-nick{background:#faf5ff;color:#6b21a8;border:1px solid #e9d5ff;padding:3px 10px;border-radius:9999px;font-size:13px;font-weight:500}
 .tag-gift{background:#fff7ed;color:#9a3412;border:1px solid #fed7aa;padding:3px 10px;border-radius:9999px;font-size:13px}
 .concern-list{margin:6px 0 0;padding-left:20px;color:#334155;font-size:14px}
 .concern-list li{margin-bottom:4px}
 .expert-details{margin:24px 0 16px;border:1px solid var(--line);border-radius:12px;background:#fff;overflow:hidden}
 .expert-details summary{padding:14px 18px;font-size:14px;font-weight:600;color:#475569;cursor:pointer;background:#f8fafc;user-select:none}
 .expert-details summary:hover{color:#0f172a;background:#f1f5f9}
 .expert-content{padding:18px;background:#fafafa}
 table{border-collapse:collapse;width:100%;font-size:14px;background:#fff;border-radius:8px;overflow:hidden}
 td,th{border-bottom:1px solid var(--line);padding:8px 12px;text-align:left}
 th{background:#f8fafc;font-weight:600;color:#475569}
 .warn{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;padding:10px 14px;border-radius:8px;font-size:13px;margin:12px 0}
 .footer{margin-top:24px;font-size:12px;color:var(--muted);text-align:center}
</style></head><body><div class="wrap">
<h1>弹幕分析报告 · 会话 ${escapeHtml(res.session_id)}</h1>
<div class="muted">生成时间 ${dayjs().format('YYYY-MM-DD HH:mm:ss')} · 模型 ${escapeHtml(res.model || '-')} · 耗时 ${(res.elapsed_s ?? 0).toFixed(1)}s</div>
${llmNote}

<div class="card">
  <h2>整场总结</h2>
  ${atmoHtml}
  <p class="summary-text">${escapeHtml(res.summary || '（暂无文字总结）')}</p>
</div>

<div class="stat-grid">
  <div class="stat-card">
    <div class="stat-label">直播时长</div>
    <div class="stat-val">${st.span_minutes ?? 0} <small>分钟</small></div>
  </div>
  <div class="stat-card">
    <div class="stat-label">互动小伙伴</div>
    <div class="stat-val">${st.unique_users ?? 0} <small>人</small></div>
  </div>
  <div class="stat-card">
    <div class="stat-label">弹幕规模</div>
    <div class="stat-val">${typeCounts.comment ?? 0} <small>条</small></div>
    <div class="stat-sub">均速 ${st.rate_per_min ?? 0} 条/分</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">高光时刻</div>
    <div class="stat-val">${st.intervals_total ?? 0} <small>处</small></div>
    <div class="stat-sub">精选前 ${Math.min(ivs.length, TOP_N_HIGHLIGHTS)} 处</div>
  </div>
</div>

<div class="card">
  <h2>🌟 精彩看点时间轴（补档直通车）</h2>
  ${hlBlocks || '<p class="muted">未检出高光时间段</p>'}
</div>

<div class="card">
  <h2>💬 观众在聊什么</h2>
  ${emojiHtml}
  ${phraseHtml}
  ${nickHtml}
  ${concernHtml}
  ${giftHtml}
  ${!emojiHtml && !phraseHtml && !nickHtml && !concernHtml && !giftHtml ? '<p class="muted">暂无词频数据</p>' : ''}
</div>

<details class="expert-details">
  <summary>查看专家指标与底层统计数据</summary>
  <div class="expert-content">
    <div class="card" style="margin-top:0">
      <h3 style="margin-top:0;font-size:15px;color:#1e293b;">弹幕密度曲线（10s 桶加权，红线为高光区间）</h3>
      <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none">
        <rect x="0" y="0" width="${width}" height="${height}" fill="#fff"/>
        <polyline fill="none" stroke="#2563eb" stroke-width="1.6" points="${pts.join(' ')}"/>
        ${marks.join('')}
      </svg>
      <div class="muted" style="margin-top:6px;">峰值加权 ${peak} · 阈值 ${st.threshold ?? '-'}（均值 ${st.weighted_mean_10s ?? '-'}，模式 ${escapeHtml(st.threshold_mode || '-')}） · 全片 ${st.span_minutes ?? 0} 分钟</div>
    </div>

    <div class="card" style="margin-bottom:0">
      <h3 style="margin-top:0;font-size:15px;color:#1e293b;">底层统计指标</h3>
      <table>
        <tr><th>指标</th><th>值</th></tr>
        <tr><td>弹幕总量</td><td>${typeCounts.comment ?? 0} 条（礼物事件 ${typeCounts.gift ?? 0} 次，已剔除系统事件 ${typeCounts.gift_system_filtered ?? 0} 条）</td></tr>
        <tr><td>弹幕时长 / 均速</td><td>${st.span_minutes ?? 0} 分钟 / ${st.rate_per_min ?? 0} 条·分⁻¹</td></tr>
        <tr><td>独立用户</td><td>${st.unique_users ?? 0}</td></tr>
        <tr><td>文本重复率</td><td>${pyRound((st.dup_rate || 0) * 100, 1)}%（重复 ${st.dup_text ?? 0} 条，均值长度 ${st.text_len_mean ?? 0} 字）</td></tr>
        <tr><td>10s 桶（comment）</td><td>max ${b10.max ?? 0} · p99 ${b10.p99 ?? 0} · p90 ${b10.p90 ?? 0} · p50 ${b10.p50 ?? 0} · mean ${b10.mean ?? 0}</td></tr>
        <tr><td>60s 桶（comment）</td><td>max ${b60.max ?? 0} · p90 ${b60.p90 ?? 0} · p50 ${b60.p50 ?? 0} · mean ${b60.mean ?? 0}</td></tr>
        <tr><td>阈值模式 / 加权均值</td><td>${escapeHtml(st.threshold_mode || '-')} / ${st.weighted_mean_10s ?? '-'}（阈值 ${st.threshold ?? '-'}）</td></tr>
        <tr><td>高光区间</td><td>检出 ${st.intervals_total ?? 0} 个，展示前 ${Math.min(ivs.length, TOP_N_HIGHLIGHTS)} 个</td></tr>
      </table>
    </div>
  </div>
</details>

<div class="footer">由 K-Recorder AI 弹幕分析生成。</div>
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
          if (!res.stats.llm_tags) {
            res.stats.llm_tags = { atmosphere: [], nicknames: [], concerns: [] };
          }
          res.stats.llm_tags.atmosphere = sanitizeTags(callRes.data.atmosphere_tags, 5, 15);
          res.stats.llm_tags.nicknames = sanitizeTags(callRes.data.fan_nicknames, 5, 15);
          res.stats.llm_tags.concerns = sanitizeTags(callRes.data.fan_concerns, 5, 15);
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
module.exports.sanitizeTags = sanitizeTags;
module.exports.pyRound = pyRound;
module.exports.isSystemEvent = isSystemEvent;
module.exports.percentile = percentile;
module.exports.TOP_N_HIGHLIGHTS = TOP_N_HIGHLIGHTS;
