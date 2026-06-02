const fs = require('fs');
const path = require('path');
const readline = require('readline');
const pool = require('../../../db/index');

/**
 * DanmakuAssGenerator — 弹幕 ASS 字幕生成器
 *
 * 将 danmaku.jsonl 转换为 ASS 格式字幕文件。
 * 支持：
 * - 滚动弹幕（从右向左）
 * - 顶部/底部固定弹幕
 * - ASS 特殊字符转义
 * - 密度限制（每秒最大弹幕数）
 * - 轨道分配（避免同轨重叠）
 * - 分段裁剪（为每个视频分段生成独立 ASS）
 */
class DanmakuAssGenerator {
  constructor() {
    // 默认样式配置
    this.defaultStyle = {
      fontName: 'Noto Sans CJK SC',
      fontSize: 32, // 1080p 默认字号
      outline: 2, // 描边
      shadow: 0, // 阴影
      alpha: 0x4d, // 透明度 (~30% 透明，即 70% 不透明)
      scrollDuration: 10000, // 滚动时长 10s
      fixedDuration: 5000, // 固定时长 5s
      screenUsage: 0.65, // 屏幕占用比例 65%
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

      // 只处理评论弹幕（第一版）
      const comments = events.filter((e) => e.type === 'comment' && e.text);
      if (comments.length === 0) {
        return { success: false, eventCount: 0, error: 'no_comments' };
      }

      // 密度限制
      const densityLimit = await this._getSettingInt('danmaku_density_per_second', 20);
      const limited = this._applyDensityLimit(comments, densityLimit);

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
    } = params;

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const style = await this._loadStyle(styleOverrides);
    const densityLimit = await this._getSettingInt('danmaku_density_per_second', 20);

    // 一次性读取所有事件
    const allEvents = await this._readJsonl(jsonlPath);
    const comments = allEvents.filter((e) => e.type === 'comment' && e.text);

    // 应用时间偏移
    if (offsetMs !== 0) {
      for (const c of comments) {
        c.ts_ms = Math.max(0, c.ts_ms + offsetMs);
      }
    }

    const results = [];

    for (const seg of segments) {
      const segStart = seg.segment_start_ms || 0;
      const segEnd = seg.segment_end_ms > 0 ? seg.segment_end_ms : Infinity;

      if (segStart === 0 && segEnd === Infinity) {
        console.warn(`[弹幕] 分段 ${seg.id} 缺少时间信息，将包含所有弹幕`);
      }

      const segDuration = segEnd - segStart;

      // 筛选当前分段的弹幕
      const segComments = comments.filter((c) => c.ts_ms >= segStart && c.ts_ms < segEnd);

      // 归一化时间到分段 0 点
      const normalized = segComments.map((c) => ({
        ...c,
        ts_ms: c.ts_ms - segStart,
      }));

      const limited = this._applyDensityLimit(normalized, densityLimit);
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
   * 生成 ASS 事件数组（含轨道分配）
   */
  _generateAssEvents(comments, videoWidth, videoHeight, style, durationMs) {
    const fontSize = this._scaleFontSize(style.fontSize, videoHeight);
    const lineHeight = fontSize + 4; // 行高 = 字号 + 4px 间距
    const maxTracks = Math.floor((videoHeight * style.screenUsage) / lineHeight);

    // 轨道占用记录：每条轨道记录最后一条弹幕的结束时间
    const trackEndTimes = new Array(maxTracks).fill(-1);

    // 滚动弹幕：从视频右侧外到左侧外

    const events = [];

    for (const comment of comments) {
      if (durationMs && comment.ts_ms >= durationMs) break;

      const text = this._escapeAssText(comment.text);
      if (!text || !text.trim()) continue;

      // 限制弹幕长度
      if (text.length > 80) continue;

      const startMs = comment.ts_ms;
      const endMs = startMs + style.scrollDuration;

      // 寻找可用轨道
      let assignedTrack = -1;
      for (let i = 0; i < maxTracks; i++) {
        if (trackEndTimes[i] <= startMs) {
          assignedTrack = i;
          break;
        }
      }

      if (assignedTrack === -1) {
        // 所有轨道都占，丢弃这条弹幕
        continue;
      }

      trackEndTimes[assignedTrack] = endMs;

      // 计算起止坐标
      const y = assignedTrack * lineHeight + lineHeight;
      const startX = videoWidth + 200;
      const endX = -400;

      const startTime = this._msToAssTime(startMs);
      const endTime = this._msToAssTime(endMs);

      // ASS Dialogue 行
      // 使用 \move 标签实现滚动效果
      const styleName = 'Scroll';
      const dialogue = `Dialogue: 0,${startTime},${endTime},${styleName},,0,0,0,,{\\move(${startX},${y},${endX},${y})}${text}`;
      events.push(dialogue);
    }

    return events;
  }

  /**
   * 构建完整的 ASS 文件内容
   */
  _buildAssFile(videoWidth, videoHeight, style, events) {
    const fontSize = this._scaleFontSize(style.fontSize, videoHeight);
    const alphaHex = style.alpha.toString(16).padStart(2, '0').toUpperCase();

    return `[Script Info]
Title: Danmaku Subtitle
ScriptType: v4.00+
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Scroll,${style.fontName},${fontSize},&H${alphaHex}FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${style.outline},${style.shadow},2,10,10,5,1

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
