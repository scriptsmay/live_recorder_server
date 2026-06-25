const fs = require('fs');
const path = require('path');
const readline = require('readline');
const pool = require('../../../db/index');

/**
 * DanmakuAssGenerator — B站级弹幕 ASS 字幕生成器
 *
 * 将 danmaku.jsonl 转换为 ASS 格式字幕文件。
 * 核心特性：
 * - 像素级碰撞调度（替代固定轨道，全局弹幕池）
 * - 动态滚动时长（按文本长度自适应）
 * - 连续Y轴分配（stepY 步进，非离散轨道）
 * - 滚动弹幕（从右向左，\\move 标签）
 * - ASS 特殊字符转义
 * - 密度限制（每秒最大弹幕数）
 * - 5秒滑动窗口去重
 * - 分段裁剪（为每个视频分段生成独立 ASS）
 */
class DanmakuAssGenerator {
  constructor() {
    // B站级默认样式
    this.defaultStyle = {
      fontName: 'Source Han Sans SC Medium',
      fontSize: 38, // 1080p 默认字号
      outline: 2, // 描边宽度（像素），使用整数减少运动边缘闪烁
      outlineColour: '000000', // 描边颜色，6位 RGB hex
      shadow: 0, // 阴影，默认关闭避免移动时边缘闪烁
      alpha: 0x1f, // 透明度（0 = 完全不透明，0x1f 约等于 opacity=0.88）
      screenUsage: 0.6, // 屏幕占用比例，优先保证视频可观看性
      stepY: 44, // Y轴步进（像素），含字号+间距
      scrollSpeed: 150, // px / second，1080p 下比旧默认更稳
    };
  }

  /**
   * 从 JSONL 文件生成完整会话 ASS
   *
   * @param {Object} params
   * @param {string} params.jsonlPath - danmaku.jsonl 文件路径
   * @param {string} params.assPath - 输出 ASS 文件路径
   * @param {number} [params.videoWidth=1920] - 视频宽度
   * @param {number} [params.videoHeight=1080] - 视频高度
   * @param {number} [params.durationMs] - 视频总时长（用于截断，可选）
   * @param {number} [params.offsetMs=0] - 时间偏移（ms），正值=弹幕延迟，负值=弹幕提前
   * @param {Object} [params.styleOverrides] - 样式覆盖
   * @returns {Promise<{ success: boolean, eventCount: number, error: string|null }>}
   */
  async generateFromJsonl(params) {
    const {
      jsonlPath,
      assPath,
      videoWidth = 1920,
      videoHeight = 1080,
      durationMs = null,
      offsetMs = 0,
      styleOverrides = {},
    } = params;

    try {
      // 读取设置
      const style = await this._loadStyle(styleOverrides);

      // 读取并解析 JSONL
      const events = await this._readJsonl(jsonlPath);
      if (events.length === 0) {
        return { success: false, eventCount: 0, error: 'no_events' };
      }

      // 只处理评论弹幕，过滤纯颜色码文本如 #9DCFFF
      const comments = events.filter((e) => e.type === 'comment' && e.text && !this._isColorCode(e.text));
      if (comments.length === 0) {
        return { success: false, eventCount: 0, error: 'no_comments' };
      }

      // 按时间排序（去重需要有序）
      comments.sort((a, b) => a.ts_ms - b.ts_ms);

      // 5秒滑动窗口去重：相同内容只保留第一条
      const deduped = this._deduplicateByContent(comments, 5000);

      // 密度限制
      const densityLimit = await this._getSettingInt('danmaku_density_per_second', 15);
      const limited = this._applyDensityLimit(deduped, densityLimit);

      // 应用时间偏移
      if (offsetMs !== 0) {
        for (const c of limited) {
          c.ts_ms = Math.max(0, c.ts_ms + offsetMs);
        }
      }

      // 按时间排序
      limited.sort((a, b) => a.ts_ms - b.ts_ms);

      // 分配轨道并生成 ASS 事件
      const assEvents = this._generateAssEvents(limited, videoWidth, videoHeight, style, durationMs);

      // 写入 ASS 文件
      const assContent = this._buildAssFile(videoWidth, videoHeight, style, assEvents);
      fs.writeFileSync(assPath, assContent, 'utf-8');

      console.log(`[DanmakuAssGenerator] 生成完成: ${assPath}, ${assEvents.length}/${limited.length} 条弹幕`);
      return { success: true, eventCount: assEvents.length, error: null };
    } catch (err) {
      console.error('[DanmakuAssGenerator] 生成 ASS 失败:', err.message);
      return { success: false, eventCount: 0, error: err.message };
    }
  }

  /**
   * 为视频分段生成独立 ASS
   *
   * @param {Object} params
   * @param {string} params.jsonlPath - 会话级 danmaku.jsonl 路径
   * @param {string} params.outputDir - danmaku_segments/ 输出目录
   * @param {Array} params.segments - 分段列表 [{ id, segment_start_ms, segment_end_ms }]
   * @param {number} [params.videoWidth=1920]
   * @param {number} [params.videoHeight=1080]
   * @param {number} [params.offsetMs=0] - 时间偏移（ms）
   * @param {Object} [params.styleOverrides]
   * @param {Map<string, {startMs: number, endMs: number|null}>} [params.segmentTimes] - 分段时间覆盖（key: file_path）
   * @returns {Promise<Array<{ id: number, assPath: string, eventCount: number }>>}
   */
  async generateSegmentAss(params) {
    const {
      jsonlPath,
      outputDir,
      segments,
      videoWidth = 1920,
      videoHeight = 1080,
      offsetMs = 0,
      styleOverrides = {},
      segmentTimes = null,
    } = params;

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const style = await this._loadStyle(styleOverrides);
    const densityLimit = await this._getSettingInt('danmaku_density_per_second', 15);

    // 一次性读取所有事件
    const allEvents = await this._readJsonl(jsonlPath);
    const comments = allEvents.filter((e) => e.type === 'comment' && e.text && !this._isColorCode(e.text));

    // 应用时间偏移
    if (offsetMs !== 0) {
      for (const c of comments) {
        c.ts_ms = Math.max(0, c.ts_ms + offsetMs);
      }
    }

    // 按时间排序（去重需要有序）
    comments.sort((a, b) => a.ts_ms - b.ts_ms);

    const dedupWindowMs = 5000;

    const results = [];

    for (const seg of segments) {
      // 优先使用直接传入的分段时间（来自 tracker），其次使用数据库值
      let segStart = 0;
      let segEnd = Infinity;

      if (segmentTimes && seg.file_path && segmentTimes.has(seg.file_path)) {
        const times = segmentTimes.get(seg.file_path);
        segStart = times.startMs || 0;
        segEnd = times.endMs > 0 ? times.endMs : Infinity;
      } else {
        segStart = seg.segment_start_ms || 0;
        segEnd = seg.segment_end_ms > 0 ? seg.segment_end_ms : Infinity;
      }

      if (segStart === 0 && segEnd === Infinity) {
        console.warn(
          `[弹幕] ⚠ 分段 ${seg.id} (${seg.file_path}) 缺少时间信息，将包含所有弹幕 — 这会导致分段数据重复！`
        );
      }

      const segDuration = segEnd - segStart;

      // 筛选当前分段的弹幕
      const segComments = comments.filter((c) => c.ts_ms >= segStart && c.ts_ms < segEnd);

      // 归一化时间到分段 0 点
      const normalized = segComments.map((c) => ({
        ...c,
        ts_ms: c.ts_ms - segStart,
      }));

      // 5秒滑动窗口去重
      const deduped = this._deduplicateByContent(normalized, dedupWindowMs);

      const limited = this._applyDensityLimit(deduped, densityLimit);
      limited.sort((a, b) => a.ts_ms - b.ts_ms);

      const assEvents = this._generateAssEvents(limited, videoWidth, videoHeight, style, segDuration);
      const assPath = path.join(outputDir, `${seg.id}.ass`);
      const assContent = this._buildAssFile(videoWidth, videoHeight, style, assEvents);

      fs.writeFileSync(assPath, assContent, 'utf-8');

      results.push({
        id: seg.id,
        assPath,
        eventCount: assEvents.length,
      });

      console.log(`[DanmakuAssGenerator] 分段 ${seg.id}: ${assEvents.length} 条弹幕, 时段 ${segStart}-${segEnd}ms`);
    }

    return results;
  }

  /**
   * 检查文本是否为纯颜色码（如 #9DCFFF、#FFF）
   * @param {string} text
   * @returns {boolean}
   */
  _isColorCode(text) {
    return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(text.trim());
  }

  /**
   * 从 JSONL 文件读取事件
   */
  async _readJsonl(jsonlPath) {
    if (!fs.existsSync(jsonlPath)) {
      throw new Error(`JSONL 文件不存在: ${jsonlPath}`);
    }

    const events = [];
    const stream = fs.createReadStream(jsonlPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch (_) {
        // 跳过格式错误的行
      }
    }

    return events;
  }

  /**
   * 应用密度限制：每秒最多 N 条弹幕
   */
  _applyDensityLimit(events, maxPerSecond) {
    if (maxPerSecond <= 0 || events.length === 0) return events;

    const result = [];
    let windowStart = 0;
    let windowCount = 0;

    for (const event of events) {
      const tsSec = Math.floor(event.ts_ms / 1000);
      if (tsSec !== windowStart) {
        windowStart = tsSec;
        windowCount = 0;
      }
      if (windowCount < maxPerSecond) {
        result.push(event);
        windowCount++;
      }
    }

    return result;
  }

  /**
   * 滑动窗口去重：相同内容的弹幕在 windowMs 内只保留第一条
   */
  _deduplicateByContent(events, windowMs) {
    if (events.length === 0) return events;

    const result = [];
    const lastSeen = new Map(); // text → lastTs_ms

    for (const event of events) {
      const prevTs = lastSeen.get(event.text);
      if (prevTs !== undefined && event.ts_ms - prevTs < windowMs) {
        // 5s 内重复，跳过
        continue;
      }
      lastSeen.set(event.text, event.ts_ms);
      result.push(event);
    }

    const removed = events.length - result.length;
    if (removed > 0) {
      console.log(`[DanmakuAssGenerator] 去重: ${removed} 条重复弹幕被过滤 (窗口 ${windowMs}ms)`);
    }

    return result;
  }

  /**
   * 生成 ASS 事件数组（B站级像素级碰撞调度）
   *
   * 核心升级（对比旧版轨道分配）：
   * 1. 全局弹幕池调度：维护 active 列表，每条新弹幕与所有活跃弹幕做碰撞检测
   * 2. 连续Y轴分配：Y 以 stepY 步进扫描，而非离散轨道
   * 3. 动态滚动时长：根据文本长度自适应，短文本更快通过
   */
  _generateAssEvents(comments, videoWidth, videoHeight, style, durationMs) {
    const fontSize = this._scaleFontSize(style.fontSize, videoHeight);
    const stepY = style.stepY || 42;
    const maxY = videoHeight * style.screenUsage;

    // 全局活跃弹幕池：记录每条弹幕的 { start, end, y }
    const active = [];
    const events = [];

    for (const comment of comments) {
      if (durationMs && comment.ts_ms >= durationMs) break;

      // 清理已过期的弹幕（释放轨道）
      const currentTime = comment.ts_ms;
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i].end <= currentTime) {
          active.splice(i, 1);
        }
      }

      const text = this._escapeAssText(comment.text);
      if (!text || !text.trim() || text.length > 80) continue;

      const startMs = comment.ts_ms;

      const textWidth = this._estimateTextWidth(comment.text, fontSize);

      // 使用配置的滚动时长，或按文本宽度动态计算。长弹幕需要更远的离屏终点。
      const duration = style.scrollDuration || this._calcDuration(videoWidth, textWidth, style, fontSize);
      const endMs = startMs + duration;

      // 像素级碰撞检测：找一个不与任何活跃弹幕冲突的 Y
      const y = this._findY(active, startMs, endMs, stepY, maxY);
      if (y === null) continue; // 屏幕满了，丢弃

      active.push({ start: startMs, end: endMs, y });

      // 滚动坐标：从右侧屏幕外到左侧屏幕外
      const padding = Math.max(80, Math.round(fontSize * 2));
      const startX = videoWidth + padding;
      const endX = -textWidth - padding;

      const startTime = this._msToAssTime(startMs);
      const endTime = this._msToAssTime(endMs);

      const dialogue = `Dialogue: 0,${startTime},${endTime},Scroll,,0,0,0,,{\\move(${startX},${y},${endX},${y})}${text}`;
      events.push(dialogue);
    }

    return events;
  }

  /**
   * B站级 Y轴碰撞检测
   *
   * 从 Y=40 开始，以 stepY 为步长向下扫描，
   * 找到一个不与任何活跃弹幕在时间+空间上冲突的位置。
   *
   * @param {Array<{start:number, end:number, y:number}>} active - 当前活跃弹幕池
   * @param {number} start - 候选弹幕起始时间 ms
   * @param {number} end - 候选弹幕结束时间 ms
   * @param {number} stepY - Y轴步进
   * @param {number} maxY - 最大 Y（屏幕高度 * screenUsage）
   * @returns {number|null} 可用 Y 坐标，或 null（屏幕满）
   */
  _findY(active, start, end, stepY, maxY) {
    for (let y = 40; y < maxY; y += stepY) {
      let conflict = false;

      for (const d of active) {
        // 时间重叠：两条弹幕在时间轴上有交集
        const timeOverlap = start < d.end && end > d.start;
        // Y轴重叠：两条弹幕在垂直方向上距离小于 stepY
        const yOverlap = Math.abs(y - d.y) < stepY;

        if (timeOverlap && yOverlap) {
          conflict = true;
          break;
        }
      }

      if (!conflict) return y;
    }

    return null;
  }

  /**
   * 动态滚动时长（B站核心）
   * 这里调整弹幕速度
   *
   * 根据文本长度计算弹幕在屏幕上的存活时间。
   * 短文本快速通过，长文本停留更久，模拟B站体验。
   *
   * @param {string} text - 弹幕文本（已转义）
   * @returns {number} 持续时长 ms
   */
  _calcDuration(videoWidth, textWidthOrText, style = {}, fontSize = this.defaultStyle.fontSize) {
    const textWidth =
      typeof textWidthOrText === 'number'
        ? textWidthOrText
        : this._estimateTextWidth(String(textWidthOrText || ''), fontSize);
    const padding = Math.max(80, Math.round(fontSize * 2));
    const speed = style.scrollSpeed || this.defaultStyle.scrollSpeed;
    const distance = videoWidth + textWidth + padding * 2;
    const duration = (distance / speed) * 1000;

    // 1080p 横向移动要避免每帧位移过大；同时给长弹幕上限，避免长时间占轨。
    const minDuration = 12000;
    const maxDuration = 20000;
    return Math.round(Math.min(maxDuration, Math.max(minDuration, duration)));
  }

  /**
   * 估算文本宽度，用于离屏距离和滚动时长计算。
   */
  _estimateTextWidth(text, fontSize) {
    if (!text) return fontSize;

    let width = 0;
    for (const char of String(text)) {
      const code = char.codePointAt(0);
      if (/\s/.test(char)) {
        width += fontSize * 0.35;
      } else if (code <= 0x007f) {
        width += fontSize * 0.55;
      } else if (
        (code >= 0x1100 && code <= 0x11ff) ||
        (code >= 0x2e80 && code <= 0x9fff) ||
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xff00 && code <= 0xffef)
      ) {
        width += fontSize;
      } else {
        width += fontSize * 0.9;
      }
    }

    return Math.max(fontSize, Math.ceil(width));
  }

  /**
   * 构建完整的 ASS 文件内容（B站风格）
   */
  _buildAssFile(videoWidth, videoHeight, style, events) {
    const fontSize = this._scaleFontSize(style.fontSize, videoHeight);
    const alphaHex = style.alpha.toString(16).padStart(2, '0').toUpperCase();
    const outlineAss = this._rgbToAssColour(style.outlineColour);

    return `[Script Info]
Title: Bilibili Danmaku
ScriptType: v4.00+
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Scroll,${style.fontName},${fontSize},&H${alphaHex}FFFFFF,&H000000FF,${outlineAss},&H80000000,-1,0,0,0,100,100,0,0,1,${style.outline},${style.shadow},2,20,20,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
  }

  /**
   * 毫秒转 ASS 时间格式 (H:MM:SS.CC)
   */
  _msToAssTime(ms) {
    const totalCs = Math.floor(ms / 10); // centiseconds
    const cs = totalCs % 100;
    const totalSec = Math.floor(totalCs / 100);
    const sec = totalSec % 60;
    const totalMin = Math.floor(totalSec / 60);
    const min = totalMin % 60;
    const hr = Math.floor(totalMin / 60);
    return `${hr}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  /**
   * 转义 ASS 特殊字符
   */
  _escapeAssText(text) {
    if (!text) return '';
    return text
      .replace(/\\/g, '\\\\')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\n/g, '\\N')
      .replace(/\r/g, '');
  }

  /**
   * 根据视频高度缩放字号
   */
  _scaleFontSize(baseFontSize, videoHeight) {
    if (videoHeight >= 1080) return baseFontSize;
    if (videoHeight >= 720) return Math.round(baseFontSize * 0.75);
    if (videoHeight >= 480) return Math.round(baseFontSize * 0.6);
    return Math.round(baseFontSize * 0.5);
  }

  /**
   * 将 6 位 RGB hex 字符串转换为 ASS 色彩格式（&H00BBGGRR）
   * @param {string} rgbHex - 如 "FF0000"（红）或 "000000"（黑）
   * @returns {string} ASS 格式，如 "&H000000FF"
   */
  _rgbToAssColour(rgbHex) {
    const hex = String(rgbHex || '000000')
      .replace(/^#/, '')
      .padStart(6, '0')
      .slice(0, 6);
    const r = hex.substring(0, 2);
    const g = hex.substring(2, 4);
    const b = hex.substring(4, 6);
    return `&H00${b}${g}${r}`.toUpperCase();
  }

  /**
   * 加载样式配置（从数据库 settings + 覆盖）
   */
  async _loadStyle(overrides = {}) {
    const style = { ...this.defaultStyle };

    try {
      const fontFamily = await this._getSetting('danmaku_font_family');
      if (fontFamily) style.fontName = fontFamily;

      const fontSize = await this._getSettingInt('danmaku_font_size', 0);
      if (fontSize > 0) style.fontSize = fontSize;

      const opacity = await this._getSettingFloat('danmaku_opacity', 0);
      if (opacity > 0) {
        // opacity 是 0-1 的不透明度，alpha 是透明度
        style.alpha = Math.round((1 - opacity) * 255);
      }

      const outlineColour = await this._getSetting('danmaku_outline_colour');
      if (outlineColour) style.outlineColour = outlineColour.replace(/^#/, '');

      const outlineWidth = await this._getSettingInt('danmaku_outline_width', -1);
      if (outlineWidth >= 0) style.outline = outlineWidth;
    } catch (_) {}

    return { ...style, ...overrides };
  }

  async _getSetting(key) {
    try {
      const result = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
      return result.rows.length > 0 ? result.rows[0].value : null;
    } catch (_) {
      return null;
    }
  }

  async _getSettingInt(key, defaultValue) {
    const val = await this._getSetting(key);
    if (val === null) return defaultValue;
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  async _getSettingFloat(key, defaultValue) {
    const val = await this._getSetting(key);
    if (val === null) return defaultValue;
    const parsed = parseFloat(val);
    return isNaN(parsed) ? defaultValue : parsed;
  }
}

module.exports = new DanmakuAssGenerator();
