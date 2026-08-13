const fs = require('fs');
const path = require('path');
const pool = require('../../../db/index');
const { getDanmakuJsonlPath, getOrphanDanmakuPath } = require('../../utils/tool');

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
   * 无活跃采集会话时不再静默丢弃（ADR-012）：落到孤儿弹幕文件并登记
   * `status='orphan_pending'` 记录，后续由 OrphanDanmakuReconciler 按时间戳回填。
   * 返回的 `error='no_active_session'` 仍然保留，路由层据此回 HTTP 409，
   * 让扩展保留自己的缓冲区——两端各留一份，任一侧失效都不丢数据。
   *
   * @param {string} roomUrl - 房间 URL
   * @param {Array} events - 标准化事件数组
   * @returns {Promise<{ written: number, error: string|null, orphan?: Object|null }>}
   */
  async writeBatch(roomUrl, events) {
    const session = this.activeSessions.get(roomUrl);
    if (!session) {
      const orphan = await this._writeOrphanBatch(roomUrl, events);
      return { written: 0, error: 'no_active_session', orphan };
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

  /**
   * 兜底写入：无活跃采集会话时把整批弹幕落到孤儿文件（ADR-012 方案 C 写入侧）
   *
   * 之所以在这里同时写文件 + 建 DB 记录：
   * - 文件保证"最坏兜底"—— 即使 DB 事务失败，数据仍能人工从磁盘恢复
   * - DB 记录承担索引 + 回填状态机 —— OrphanDanmakuReconciler 逐条按时间戳分桶
   *   到重叠的历史 recording_sessions，需要 room_url 和时间范围来一次 SQL 定位候选
   *
   * 首行 `_meta` 用于追溯（同一天同一房间的多批共享一个文件，各批的 `_meta`
   * 前缀虽然重复，但足以在人工审阅时看出批次分界）。
   *
   * 幂等/去重不在写入阶段处理，留给回填阶段（避免这里做数据库检查拖慢热路径）。
   *
   * @param {string} roomUrl - 房间 URL
   * @param {Array} events - 原始事件数组
   * @returns {Promise<Object|null>} 孤儿记录摘要 `{ id, raw_path, event_count, ts_min, ts_max }` 或 null（失败/未启用）
   * @private
   */
  async _writeOrphanBatch(roomUrl, events) {
    const enabled = await this._getSetting('kuaishou_danmaku_enabled', 'false');
    if (enabled !== 'true') {
      // 采集未启用时不需要落孤儿：扩展本不该向后端推
      return null;
    }
    if (!roomUrl || !Array.isArray(events) || events.length === 0) {
      return null;
    }

    // 标准化事件（sessionStartMs=0 让 ts_ms 保留绝对值，回填时会按目标 session 重算）
    const batchArrivalBase = Date.now();
    const records = [];
    let tsMin = Number.POSITIVE_INFINITY;
    let tsMax = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < events.length; i++) {
      try {
        const event = events[i];
        const hasValidTs =
          (typeof event.ts_ms === 'number' && event.ts_ms > 0) ||
          (typeof event.ts_abs_ms === 'number' && event.ts_abs_ms > 0);
        if (!hasValidTs) {
          event._receivedAt = batchArrivalBase + i;
        }
        const rec = this._normalizeEvent(event, 0);
        records.push(rec);
        if (rec.ts_abs_ms < tsMin) tsMin = rec.ts_abs_ms;
        if (rec.ts_abs_ms > tsMax) tsMax = rec.ts_abs_ms;
      } catch (_) {}
    }
    if (records.length === 0) {
      return null;
    }

    let rawPath;
    try {
      rawPath = getOrphanDanmakuPath(roomUrl, new Date(batchArrivalBase));
    } catch (err) {
      console.warn('[DanmakuRecorder] 生成孤儿弹幕路径失败:', err.message);
      return null;
    }

    try {
      const dir = path.dirname(rawPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // _meta 首行仅在新建文件时写入，避免重复
      const isNewFile = !fs.existsSync(rawPath);
      const lines = [];
      if (isNewFile) {
        lines.push(
          JSON.stringify({
            _meta: {
              room_url: roomUrl,
              received_at: batchArrivalBase,
              schema: 'orphan-v1',
            },
          })
        );
      }
      for (const rec of records) {
        lines.push(JSON.stringify(rec));
      }
      fs.appendFileSync(rawPath, lines.join('\n') + '\n');
    } catch (err) {
      console.error('[DanmakuRecorder] 写入孤儿弹幕文件失败:', err.message);
      return null;
    }

    // 建 DB 记录（失败不影响文件已落盘 —— 文件是最坏兜底）
    let orphanId = null;
    try {
      const startedAt = new Date(tsMin).toISOString();
      const endedAt = new Date(tsMax).toISOString();
      const result = await pool.query(
        `INSERT INTO danmaku_capture_records
           (session_id, room_id, room_url, platform, status, raw_path,
            event_count, started_at, ended_at)
         VALUES (NULL, NULL, $1, $2, 'orphan_pending', $3, $4, $5, $6)
         RETURNING id`,
        [roomUrl, 'kuaishou', rawPath, records.length, startedAt, endedAt]
      );
      orphanId = result.rows[0].id;
    } catch (err) {
      console.error('[DanmakuRecorder] 登记孤儿弹幕记录失败:', err.message);
    }

    console.warn(
      `[DanmakuRecorder] 无活跃采集，弹幕已落孤儿文件: room=${roomUrl} file=${rawPath} count=${records.length}`
    );

    return {
      id: orphanId,
      raw_path: rawPath,
      event_count: records.length,
      ts_min: tsMin,
      ts_max: tsMax,
    };
  }
}

module.exports = new DanmakuRecorder();
