const fs = require('fs');
const path = require('path');
const pool = require('../../../db/index');
const { getDanmakuJsonlPath } = require('../../utils/tool');

/**
 * DanmakuRecorder — 弹幕录制器
 *
 * 职责：
 * 1. 接收 Chrome Extension 推送的弹幕事件
 * 2. 将弹幕写入 VIDEO_DOWNLOAD_DIR/danmaku/[sessionId].jsonl（每行一条标准化事件）
 * 3. 管理 danmaku_capture_records 数据库记录
 * 4. 在录制结束时停止采集并标记状态
 */
class DanmakuRecorder {
  constructor() {
    // 活跃的采集会话：roomUrl -> { sessionId, captureId, fd, startedAt, eventCount, rawPath }
    this.activeSessions = new Map();
  }

  /**
   * 启动弹幕采集
   * 在录制会话启动时调用，创建 danmaku_capture_records 并打开 JSONL 文件
   *
   * JSONL 路径由 sessionId 唯一推导（v1.8.0 起集中扁平存放），调用方无需传目录。
   *
   * @param {Object} params
   * @param {number} params.sessionId - 录制会话 ID
   * @param {number} params.roomId - 房间 ID
   * @param {string} params.roomUrl - 房间 URL（直播间地址）
   * @param {string} params.platform - 平台（默认 kuaishou）
   * @param {number} [params.recordingStartedAt] - 录制（FFmpeg）启动时间戳（epoch ms），用于对齐视频时间轴
   * @returns {Promise<number|null>} capture_id 或 null（未启用时）
   */
  async startCapture({ sessionId, roomId, roomUrl, platform = 'kuaishou', recordingStartedAt }) {
    const enabled = await this._getSetting('kuaishou_danmaku_enabled', 'false');
    if (enabled !== 'true') {
      return null;
    }

    let rawPath;
    try {
      rawPath = getDanmakuJsonlPath(sessionId);
    } catch (err) {
      console.warn(`[DanmakuRecorder] 无法确定弹幕路径，跳过采集: ${err.message}`);
      return null;
    }

    // 确保集中目录存在
    const danmakuDir = path.dirname(rawPath);
    if (!fs.existsSync(danmakuDir)) {
      fs.mkdirSync(danmakuDir, { recursive: true });
    }

    try {
      // 创建数据库记录
      const result = await pool.query(
        `INSERT INTO danmaku_capture_records (session_id, room_id, platform, status, raw_path, started_at)
         VALUES ($1, $2, $3, 'recording', $4, NOW())
         RETURNING id`,
        [sessionId, roomId, platform, rawPath]
      );
      const captureId = result.rows[0].id;

      // 打开文件描述符（追加模式）
      const fd = fs.openSync(rawPath, 'a');

      const startedAt = recordingStartedAt || Date.now();
      // startedAt 优先使用录制（FFmpeg）启动时间，使 ts_ms 对齐视频时间轴
      this.activeSessions.set(roomUrl, {
        sessionId,
        captureId,
        fd,
        recordingStartedAt: startedAt,
        startedAt, // sessionStartMs 别名，供 _normalizeEvent 批量处理用
        eventCount: 0,
        rawPath,
      });

      console.log(`[DanmakuRecorder] 采集启动: capture_id=${captureId}, session=${sessionId}, file=${rawPath}`);
      return captureId;
    } catch (err) {
      console.error('[DanmakuRecorder] 启动采集失败:', err.message);
      return null;
    }
  }

  /**
   * 接收批量弹幕事件并写入 JSONL
   *
   * @param {string} roomUrl - 房间 URL
   * @param {Array} events - 标准化事件数组
   * @returns {{ written: number, error: string|null }}
   */
  writeBatch(roomUrl, events) {
    const session = this.activeSessions.get(roomUrl);
    if (!session) {
      return { written: 0, error: 'no_active_session' };
    }

    if (!Array.isArray(events) || events.length === 0) {
      return { written: 0, error: null };
    }

    let written = 0;
    const lines = [];
    const batchArrivalBase = Date.now();

    for (let i = 0; i < events.length; i++) {
      try {
        const event = events[i];
        // 为缺少合法时间戳的事件分配递增的到达时间，避免同批次全部相同
        const hasValidTs =
          (typeof event.ts_ms === 'number' && event.ts_ms > 0) ||
          (typeof event.ts_abs_ms === 'number' && event.ts_abs_ms > 0);
        if (!hasValidTs) {
          event._receivedAt = batchArrivalBase + i;
        }
        const record = this._normalizeEvent(event, session.startedAt);
        lines.push(JSON.stringify(record));
        written++;
      } catch (err) {
        // 单条事件解析失败不影响其他
      }
    }

    if (lines.length === 0) {
      return { written: 0, error: null };
    }

    try {
      const data = lines.join('\n') + '\n';
      fs.writeSync(session.fd, data);
      session.eventCount += written;
      return { written, error: null };
    } catch (err) {
      console.error('[DanmakuRecorder] 写入 JSONL 失败:', err.message);
      return { written: 0, error: err.message };
    }
  }

  /**
   * 停止弹幕采集
   * 关闭文件描述符并更新数据库记录
   *
   * @param {string} roomUrl - 房间 URL
   * @returns {Promise<{ captureId: number|null, eventCount: number }>}
   */
  async stopCapture(roomUrl) {
    const session = this.activeSessions.get(roomUrl);
    if (!session) {
      return { captureId: null, eventCount: 0 };
    }

    // 关闭文件描述符
    try {
      fs.closeSync(session.fd);
    } catch (err) {
      console.warn('[DanmakuRecorder] 关闭文件描述符失败:', err.message);
    }

    // 更新数据库记录
    try {
      await pool.query(
        `UPDATE danmaku_capture_records
         SET status = 'completed', ended_at = NOW(), event_count = $1
         WHERE id = $2`,
        [session.eventCount, session.captureId]
      );
    } catch (err) {
      console.error('[DanmakuRecorder] 更新采集记录失败:', err.message);
    }

    console.log(`[DanmakuRecorder] 采集停止: capture_id=${session.captureId}, 共 ${session.eventCount} 条事件`);

    const captureId = session.captureId;
    const eventCount = session.eventCount;
    this.activeSessions.delete(roomUrl);

    return { captureId, eventCount };
  }

  /**
   * 标记采集失败
   *
   * @param {string} roomUrl - 房间 URL
   * @param {string} error - 错误信息
   */
  async failCapture(roomUrl, error) {
    const session = this.activeSessions.get(roomUrl);
    if (!session) return;

    try {
      fs.closeSync(session.fd);
    } catch (_) {}

    try {
      await pool.query(
        `UPDATE danmaku_capture_records
         SET status = 'failed', ended_at = NOW(), event_count = $1, error = $2
         WHERE id = $3`,
        [session.eventCount, error, session.captureId]
      );
    } catch (err) {
      console.error('[DanmakuRecorder] 标记采集失败:', err.message);
    }

    this.activeSessions.delete(roomUrl);
  }

  /**
   * 检查指定房间是否有活跃的弹幕采集
   *
   * @param {string} roomUrl - 房间 URL
   * @returns {boolean}
   */
  isCapturing(roomUrl) {
    return this.activeSessions.has(roomUrl);
  }

  /**
   * 获取活跃的采集信息
   *
   * @param {string} roomUrl - 房间 URL
   * @returns {Object|null}
   */
  getSession(roomUrl) {
    return this.activeSessions.get(roomUrl) || null;
  }

  /**
   * 获取所有活跃采集的统计信息
   *
   * @returns {Array}
   */
  getActiveStats() {
    const stats = [];
    for (const [roomUrl, session] of this.activeSessions) {
      stats.push({
        room_url: roomUrl,
        session_id: session.sessionId,
        capture_id: session.captureId,
        event_count: session.eventCount,
        started_at: session.startedAt,
        uptime_ms: Date.now() - session.startedAt,
      });
    }
    return stats;
  }

  /**
   * 标准化单条事件
   * 确保 ts_ms 基于录制启动时间的相对偏移，同时保留 ts_abs_ms 供下游对齐校验
   *
   * 时间戳优先级：
   * 1. event.ts_abs_ms — Extension 端捕获时记录的绝对时间戳（最优）
   * 2. event.ts_ms     — 相对或绝对时间戳（> 0 时视为合法）
   * 3. event._receivedAt — writeBatch 分配的到达时间戳（兜底）
   * 4. Date.now()       — 最终兜底
   *
   * 输出字段：
   * - ts_ms: 相对于录制启动时间的毫秒偏移（直接对齐视频时间轴）
   * - ts_abs_ms: 浏览器端原始绝对时间戳（epoch ms），用于跨时钟校验
   */
  _normalizeEvent(event, sessionStartMs) {
    let tsAbs;
    if (typeof event.ts_abs_ms === 'number' && event.ts_abs_ms > 0) {
      tsAbs = event.ts_abs_ms;
    } else if (typeof event.ts_ms === 'number' && event.ts_ms > 0) {
      tsAbs = event.ts_ms;
    } else if (typeof event._receivedAt === 'number' && event._receivedAt > 0) {
      tsAbs = event._receivedAt;
    } else {
      tsAbs = Date.now();
    }
    const tsRelative = sessionStartMs > 0 ? Math.max(0, tsAbs - sessionStartMs) : tsAbs;

    const record = {
      ts_ms: tsRelative,
      ts_abs_ms: tsAbs,
      type: event.type || 'unknown',
    };

    switch (event.type) {
      case 'comment':
        record.username = String(event.user || event.username || '').slice(0, 64);
        record.user_id = String(event.userId || event.user_id || '');
        record.text = String(event.text || '').slice(0, 512);
        break;
      case 'gift':
        record.username = String(event.user || event.username || '').slice(0, 64);
        record.user_id = String(event.userId || event.user_id || '');
        record.gift_name = String(event.giftName || '').slice(0, 64);
        record.count = Math.max(1, parseInt(event.count, 10) || 1);
        break;
      case 'like':
        record.count = parseInt(event.count, 10) || 0;
        break;
      default:
        record.raw = event.raw || event;
    }

    return record;
  }

  /**
   * 获取 settings 值
   */
  async _getSetting(key, defaultValue) {
    try {
      const result = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
      if (result.rows.length > 0) return result.rows[0].value;
    } catch (_) {}
    return defaultValue;
  }
}

module.exports = new DanmakuRecorder();
