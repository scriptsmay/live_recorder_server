/**
 * 统计层单测 — 算法口径基线 = 离线批量回算脚本 analyze.py（2026-10-16 批量 50 场实测验证）
 *
 * 基线场次的真实数据（50,015 行 / 347.8 条·分⁻¹ / 47.7% 重复…）依赖 NAS 上的原始 JSONL，
 * 本机不复制弹幕数据入库，因此这里用确定性合成 fixture 逐分支锁定同一套口径：
 * 双口径计数、三层降级、峰值补足、样本外扩桶、占位补位、pyRound、Counter 并列序。
 */

const svc = require('../server/services/DanmakuAnalysisService');
const { computeStats, serializeResult, renderHtml, buildPayload, pyRound, isSystemEvent, percentile } = svc;

const c = (ts, text, uid = 'u1', username = '观众') => ({ type: 'comment', ts_ms: ts, text, user_id: uid, username });
const g = (ts, name = '礼物#abc==', uid = 'u1') => ({
  type: 'gift',
  ts_ms: ts,
  gift_name: name,
  user_id: uid,
  username: '金主',
});
const sysStop = (ts) => ({ type: 'gift', ts_ms: ts, gift_name: '直播已停止', count: 60 });
const sysNoId = (ts, text) => ({ type: 'comment', ts_ms: ts, text, username: '未知' });

describe('基础工具（与 Python 口径对齐）', () => {
  test('pyRound：半数位取偶（JS Math.round 是半位进一，必须区分）', () => {
    expect(pyRound(0.5)).toBe(0);
    expect(pyRound(1.5)).toBe(2);
    expect(pyRound(2.5)).toBe(2);
    expect(pyRound(3.5)).toBe(4);
    expect(pyRound(-0.5)).toBe(0);
    expect(pyRound(43.5)).toBe(44);
    expect(pyRound(44.5)).toBe(44);
    expect(pyRound(347.84946, 1)).toBe(347.8);
    expect(pyRound(0.4773, 4)).toBe(0.4773);
  });

  test('percentile：nearest-rank 不插值', () => {
    const sorted = [1, 2, 3, 4];
    expect(percentile(sorted, 0.5)).toBe(2);
    expect(percentile(sorted, 0.9)).toBe(4);
    expect(percentile(sorted, 0.99)).toBe(4);
    expect(percentile([], 0.5)).toBe(0);
  });

  test('isSystemEvent：gift 命中系统名 或 无身份（第二支连 comment 也剔）', () => {
    expect(isSystemEvent(sysStop(1000))).toBe(true);
    expect(isSystemEvent(sysNoId(1000, '666'))).toBe(true);
    expect(isSystemEvent({ type: 'comment', ts_ms: 1, text: 'a', username: '' })).toBe(true);
    expect(isSystemEvent({ type: 'comment', ts_ms: 1, text: 'a', username: null })).toBe(true);
    // 无身份但带 user_id → 不算系统事件
    expect(isSystemEvent({ type: 'comment', ts_ms: 1, text: 'a', username: '未知', user_id: 'x' })).toBe(false);
    expect(isSystemEvent(g(1000))).toBe(false);
  });
});

describe('computeStats：两条口径不混（统计 comment_all / 检测过滤后）', () => {
  // 桶 0：3 真实 + 2 无身份；桶 1：仅无身份；桶 2：1 真实 + 1「直播已停止」+ 1 礼物；桶 3：1 真实
  const events = [
    c(5000, '好的'),
    c(6000, '来了'),
    c(7000, '来了', 'u2'),
    sysNoId(7600, '无身份'),
    sysNoId(15000, '空桶'),
    c(25000, '哈哈'),
    sysStop(26000),
    g(27000, '礼物#a=='),
    c(35000, '哈'),
  ];
  const { stats, intervals } = computeStats('88', events, 2);

  test('总量/类型计数按 analyze.py 口径：comment_all 只数 comment 行，gift_system_filtered 含无身份行', () => {
    expect(stats.session_id).toBe('88');
    expect(stats.total_lines).toBe(9);
    expect(stats.parse_failures).toBe(2);
    expect(stats.type_counts).toEqual({ comment: 7, gift: 1, gift_system_filtered: 3, like: 0 });
    expect(stats.no_danmaku).toBe(false);
  });

  test('10s 桶统计口径含无身份行（max=4），检测口径剔除（加权 3/0/9/1）', () => {
    expect(stats.bucket_10s_comment).toEqual({ max: 4, p99: 4, p90: 4, p50: 1, mean: 1.8 });
    expect(stats.weighted_mean_10s).toBe(3.25);
    expect(stats.threshold).toBe(9);
    expect(stats.threshold_mode).toBe('fallback_top_buckets+top_up');
    expect(stats.series_10s).toEqual([3, 0, 9, 1]);
  });

  test('span/rate/dup/unique 与 Python round 逐位一致', () => {
    expect(stats.span_minutes).toBe(0.5);
    expect(stats.rate_per_min).toBe(14);
    expect(stats.unique_users).toBe(2);
    expect(stats.dup_text).toBe(1);
    expect(stats.dup_rate).toBe(0.1429);
    expect(stats.text_len_mean).toBe(2);
  });

  test('score=区间均值加权（非峰值）；第三层单桶成段不合并；补足按加权降序补未覆盖桶', () => {
    // 加权 3,0,9,1：×2.5=8.125 需连续≥2 桶（桶 2 两侧是 0/1）→ ×1.5 同样空 → 绝对峰值 9 检出单桶 [2]
    // 区间数 1 < 5 → 补足未覆盖桶 0、3、1
    expect(intervals.map((iv) => [iv.bucket_start, iv.bucket_end_last])).toEqual([
      [2, 2],
      [0, 0],
      [3, 3],
      [1, 1],
    ]);
    expect(intervals[0]).toMatchObject({ start_ms: 20000, end_ms: 30000, score: 9, peak_weighted: 9 });
    expect(intervals[1].samples).toEqual(['好的', '来了']);
  });

  test('高频词走统计口径（含无身份行文本），礼物只计数不解析名字', () => {
    expect(stats.top_phrases).toEqual([
      ['来了', 2],
      ['好的', 1],
      ['无身份', 1],
      ['空桶', 1],
      ['哈哈', 1],
      ['哈', 1],
    ]);
    expect(stats.top_gifts).toEqual([['礼物#a==', 1]]);
  });

  test('60s 桶统计口径同样含无身份行：7 条、均值 7', () => {
    expect(stats.bucket_60s_comment).toEqual({ max: 7, p90: 7, p50: 7, mean: 7 });
  });
});

describe('computeStats：三层降级 + 峰值补足', () => {
  test('全程高密度：均值×2.5 与 ×1.5 都检不出 → 绝对峰值+单桶补足', () => {
    const events = [];
    for (let b = 0; b < 4; b++) for (let i = 0; i < 5; i++) events.push(c(b * 10000 + 5000, 'aaaa', `d${b}_${i}`));
    for (let b = 4; b < 10; b++) for (let i = 0; i < 4; i++) events.push(c(b * 10000 + 5000, 'bbbb', `e${b}_${i}`));
    const { stats, intervals } = computeStats('dense', events, 0);
    expect(stats.weighted_mean_10s).toBe(4.4);
    expect(stats.threshold).toBe(5);
    // ×2.5=11、×1.5=6.6 均高于峰值 5 → 第三层阈值=绝对峰值 5（>= 含等号）：桶 0-3 连成一段
    expect(stats.threshold_mode).toBe('fallback_top_buckets+top_up');
    expect(intervals.map((iv) => [iv.bucket_start, iv.bucket_end_last, iv.score])).toEqual([
      [0, 3, 5],
      [4, 4, 4],
      [5, 5, 4],
      [6, 6, 4],
      [7, 7, 4],
    ]);
  });

  test('均值×1.5 检出（relaxed 档），随后触发峰值补足 +top_up', () => {
    // 加权 10,10,8,1,1,1,1,8,1,1,10,10 → 均值 5.17：×2.5=12.9 检不出 → ×1.5=7.75 检出 [0-2]/[10-11]
    const events = [];
    const add = (b, n, text) => {
      for (let i = 0; i < n; i++) events.push(c(b * 10000 + 5000, text, `u${b}_${i}`));
    };
    add(0, 10, 'a');
    add(1, 10, 'b');
    add(2, 8, 'c');
    for (let b = 3; b <= 6; b++) add(b, 1, 'd');
    add(7, 8, 'e');
    add(8, 1, 'f');
    add(9, 1, 'g');
    add(10, 10, 'h');
    add(11, 10, 'i');
    const { stats, intervals } = computeStats('topup', events, 0);
    expect(stats.weighted_mean_10s).toBe(5.17);
    expect(stats.threshold).toBe(7.75);
    expect(stats.threshold_mode).toBe('relaxed_mean_x_K+top_up');
    expect(stats.intervals_total).toBe(5);
    // 补足桶取加权降序未覆盖桶（7→8、3→1，并列 1 按桶序），单桶成段不合并
    expect(intervals.map((iv) => [iv.bucket_start, iv.bucket_end_last, iv.score])).toEqual([
      [10, 11, 10],
      [0, 2, 9.3],
      [7, 7, 8],
      [3, 3, 1],
      [4, 4, 1],
    ]);
  });

  test('第三层单桶段 + 补足补齐到 5 个区间', () => {
    const events = [];
    for (let i = 0; i < 10; i++) events.push(c(5000, 'x', `q${i}`));
    events.push(c(15000, 'y', 'r1'));
    events.push(c(25000, 'z', 's1'));
    const { stats, intervals } = computeStats('small', events, 0);
    // 加权 10,1,1 → 均值 4 ×2.5=10 需连续≥2桶（桶 0 右侧是 1）→ ×1.5=6 同样空 → 绝对峰值 10 检出单桶 [0]
    expect(stats.threshold_mode).toBe('fallback_top_buckets+top_up');
    expect(intervals.map((iv) => [iv.bucket_start, iv.score])).toEqual([
      [0, 10],
      [1, 1],
      [2, 1],
    ]);
  });
});

describe('computeStats：样本与高频词', () => {
  test('只有系统行的场次：comment_all 计了无身份行但检测口径全零（照抄 analyze.py，不特判）', () => {
    const { stats, intervals } = computeStats('zero', [sysStop(1000), sysNoId(2000, '开场')], 0);
    // 与 Python 一致的「意外」：type=='comment' 的无身份行仍进 comment 总量，no_danmaku 判 false；
    // span 非零但取整为 0 时 rate 仍按原始分钟数计算；全零加权下 top_up 照样补空桶成单桶区间。
    expect(stats.no_danmaku).toBe(false);
    expect(stats.type_counts).toEqual({ comment: 1, gift: 0, gift_system_filtered: 2, like: 0 });
    expect(stats.span_minutes).toBe(0);
    expect(stats.rate_per_min).toBe(60);
    expect(stats.bucket_10s_comment).toEqual({ max: 1, p99: 1, p90: 1, p50: 1, mean: 1 });
    expect(stats.weighted_mean_10s).toBe(0);
    expect(stats.threshold).toBe(0);
    expect(stats.threshold_mode).toBe('fallback_top_buckets+top_up');
    // 两条事件都落在桶 0（max bucket index = 0）→ series 只有一格；top_up 候选桶已被覆盖，停在 1 个区间
    expect(stats.series_10s).toEqual([0]);
    expect(intervals.map((iv) => [iv.bucket_start, iv.score])).toEqual([[0, 0]]);
  });

  test('完全无事件：no_danmaku=true、零区间', () => {
    const { stats, intervals } = computeStats('empty', [], 0);
    expect(stats.no_danmaku).toBe(true);
    expect(stats.intervals_total).toBe(0);
    expect(intervals).toEqual([]);
    expect(stats.series_10s).toEqual([]);
    expect(stats.rate_per_min).toBe(0);
  });

  test('top_phrases 并列按首次出现序（Counter.most_common 口径）', () => {
    const events = [
      c(1000, 'aa', 'u1'),
      c(1000, 'bb', 'u2'),
      c(1000, 'cc', 'u3'),
      c(1000, 'aa', 'u4'),
      c(1000, 'cc', 'u5'),
      c(1000, 'bb', 'u6'),
    ];
    const { stats } = computeStats('tie', events, 0);
    expect(stats.top_phrases).toEqual([
      ['aa', 2],
      ['bb', 2],
      ['cc', 2],
    ]);
  });

  test('pickSamples：外扩多读一个桶（hi+1），占位弹幕只在不足 20 条时补位', () => {
    const events = [
      c(5000, '重复'),
      c(6000, '重复'),
      c(15000, '甲'),
      c(25000, '乙'),
      c(26000, '[666]'),
      c(35000, '外扩桶弹幕'),
      c(45000, '不在范围'),
    ];
    const { intervals } = computeStats('samples', events, 0);
    // 桶 0 权重 2、桶 1/2/3 权重 1 → 加权 2,1,1,1，均值 1.25，阈值 3.125 → ×1.5=1.875 检出桶 0
    // 但区间数 <5 触发补足：单桶 [0] 之外补 1/2/3 —— 取第一个区间验证样本口径
    const iv = intervals.find((x) => x.bucket_start === 0);
    expect(iv).toBeDefined();
    expect(iv.samples).toEqual(['重复', '甲']);
    // 补足出来的单桶区间（桶 2）同样外扩读到桶 3（含占位 '[666]'），非占位不足 20 时第二遍补入
    const iv2 = intervals.find((x) => x.bucket_start === 2);
    expect(iv2.samples).toEqual(['乙', '外扩桶弹幕', '[666]']);
  });
});

describe('buildPayload / serializeResult / renderHtml', () => {
  const mkIv = (startMs, extra = {}) => ({
    start_ms: startMs,
    end_ms: startMs + 10000,
    score: 9,
    peak_weighted: 10,
    bucket_start: startMs / 10000,
    bucket_end_last: startMs / 10000,
    samples: ['好', '冲'],
    label: '',
    reason: '',
    ...extra,
  });
  const baseStats = {
    span_minutes: 0.1,
    rate_per_min: 120,
    unique_users: 2,
    dup_rate: 0.4773,
    type_counts: { comment: 12, gift: 3, gift_system_filtered: 1, like: 0 },
    bucket_10s_comment: { max: 8, p99: 8, p90: 6, p50: 2, mean: 3.5 },
    weighted_mean_10s: 3,
    threshold: 7.5,
    threshold_mode: 'mean_x_K',
    intervals_total: 1,
    text_len_mean: 2,
    dup_text: 6,
    bucket_60s_comment: { max: 12, p90: 12, p50: 12, mean: 12 },
    top_phrases: [
      ['好', 5],
      ['冲', 2],
    ],
    top_gifts: [['礼物#a==', 3]],
    series_10s: [3, 8, 0],
    no_danmaku: false,
  };

  test('buildPayload：概览 + 前 8 高频词 + 序号对齐的高光列表', () => {
    const phrases = Array.from({ length: 15 }, (_, i) => [`w${i}`, 10 - i]);
    const payload = buildPayload({ ...baseStats, top_phrases: phrases }, [mkIv(0)]);
    expect(payload).toContain('【整场概览】');
    expect(payload).toContain('文本重复率 47.7%');
    expect(payload).toContain('w0×10、w1×9、w2×8、w3×7、w4×6、w5×5、w6×4、w7×3');
    expect(payload).not.toContain('w8×');
    expect(payload).toContain('【高光候选区间（共 1 个，按热度排序）】');
    expect(payload).toContain('1. 00:00:00（峰值加权 10）样本弹幕：');
    expect(payload).toContain('   好 | 冲');
  });

  test('serializeResult：8 个顶层键 + highlights 截前 10', () => {
    const intervals = Array.from({ length: 12 }, (_, i) => mkIv(i * 10000));
    const out = serializeResult({
      session_id: '7',
      stats: baseStats,
      summary: 's',
      llm_ok: true,
      llm_error: '',
      model: 'm',
      elapsed_s: 1.2,
      intervals,
    });
    expect(Object.keys(out)).toEqual([
      'session_id',
      'stats',
      'summary',
      'llm_ok',
      'llm_error',
      'model',
      'elapsed_s',
      'highlights',
    ]);
    expect(out.highlights).toHaveLength(10);
    expect(out.highlights[0]).toEqual({
      start_ms: 0,
      end_ms: 10000,
      score: 9,
      peak_weighted: 10,
      label: '',
      reason: '',
      samples: ['好', '冲'],
    });
  });

  test('renderHtml：自包含（零 JS 零外链）且动态文本全转义', () => {
    const html = renderHtml({
      session_id: '<script>alert(1)</script>',
      stats: baseStats,
      summary: '<img src=x onerror=alert(2)>',
      llm_ok: false,
      llm_error: "bad 'quote' & <tag>",
      model: 'm',
      elapsed_s: 1.2,
      intervals: [mkIv(0, { label: '<b>李 hui</b>', samples: ['<script>s</script>', "q'uote"] })],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&#39;');
    expect(html).toContain('LLM 层未成功');
    expect(html).toContain('本报告为纯统计结果');
    expect(html.match(/<script/g)).toBeNull();
  });
});
