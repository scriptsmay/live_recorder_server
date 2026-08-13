const fs = require('fs');
const path = require('path');
const pool = require('../db/index');
const DataService = require('./DataService');
const { getDanmakuJsonlPath, getDiscardedOrphanDanmakuDir, readJsonlLines } = require('../lib/utils/tool');

/**
 * OrphanDanmakuReconciler — 孤儿弹幕回填服务（ADR-012 方案 C 回填侧）
 *
 * 职责：把 `writeBatch` 落到孤儿文件的弹幕，按每条事件的绝对时间戳 `ts_abs_ms`
 * 逐条分桶到时间窗有重叠的历史 recording_sessions，并合并进各会话的正式 JSONL。
 *
 * 设计约束（对应 ADR-012 决策条款）：
 * - 逐条分桶而非整批就近吸附：一批可能跨多个会话（断流重连、手动停/起）
 * - `ts_ms` 必须按**目标会话**的 started_at 重算，否则整批 ASS 字幕会整体偏移
 * - 置信度 = 命中事件数 / 总事件数，低于阈值默认拒绝（除非 force）
 * - 去重：扫目标 JSONL 尾部 N 行建 Set，命中即跳过，保证重复 reconcile 幂等
 * - 匹配不到的事件回写孤儿文件，保留人工审阅的最坏兜底
 * - 时区正确性交给 DataService.getSessionsOverlappingWindow（SQL 侧取 epoch）
 *
 * 全程同步 fs（符合项目"保持轻量"原则，orphan 量级预计每天个位数）。
 */
class OrphanDanmakuReconciler {
  /**
   * 回填单条孤儿记录
   *
   * @param {number|string} orphanRecordId - danmaku_capture_records.id
   * @param {Object} [options]
   * @param {boolean} [options.dryRun=false] - 只预览分桶结果，不落盘、不改状态
   * @param {boolean} [options.force=false] - 忽略置信度阈值强制回填
   * @param {number} [options.toleranceMs] - 时间戳前后容差（缺省读 settings）
   * @param {number} [options.confidenceThreshold] - 自动匹配置信度阈值（缺省读 settings）
   * @returns {Promise<Object>} 结果摘要
   */
  async reconcile(orphanRecordId, options = {}) {
    // 原子占位：只有 status='orphan_pending' 才能抢占，防止并发重复回填
    const claimResult = await pool.query(
      `UPDATE danmaku_capture_records
       SET status = 'orphan_processing'
       WHERE id = $1 AND status = 'orphan_pending'
       RETURNING *`,
      [orphanRecordId]
    );
    if (claimResult.rowCount === 0) {
      // 抢占失败：可能 not_found、已处理或被其他并发请求抢走
      const orphan = await DataService.getDanmakuCaptureRecord(orphanRecordId);
      if (!orphan) {
        return { status: 'not_found', recordId: orphanRecordId };
      }
      if (orphan.status === 'orphan_processing') {
        return { status: 'in_progress', recordId: orphanRecordId };
      }
      if (orphan.status === 'orphan_associated' || orphan.status === 'orphan_discarded') {
        return { status: 'already_processed', recordId: orphanRecordId, currentStatus: orphan.status };
      }
      return { status: 'not_orphan', recordId: orphanRecordId, currentStatus: orphan.status };
    }
    const orphan = claimResult.rows[0];
    if (!orphan.raw_path || !fs.existsSync(orphan.raw_path)) {
      // 回退状态
      await pool.query(`UPDATE danmaku_capture_records SET status = 'orphan_pending' WHERE id = $1`, [orphan.id]);
      return { status: 'file_missing', recordId: orphanRecordId, rawPath: orphan.raw_path };
    }

    const toleranceMs =
      options.toleranceMs != null
        ? options.toleranceMs
        : parseInt(await DataService.getSetting('orphan_tolerance_ms', '120000'), 10);
    const confidenceThreshold =
      options.confidenceThreshold != null
        ? options.confidenceThreshold
        : parseFloat(await DataService.getSetting('orphan_confidence_threshold', '0.8'));
    const maxSessionMs = parseInt(await DataService.getSetting('orphan_max_session_ms', '28800000'), 10);
    const dedupScanLines = parseInt(await DataService.getSetting('orphan_dedup_scan_lines', '200'), 10);

    const events = this._readJsonl(orphan.raw_path);
    if (events.length === 0) {
      await this._releaseClaim(orphan.id);
      return { status: 'empty', recordId: orphanRecordId };
    }

    let tsMin = Number.POSITIVE_INFINITY;
    let tsMax = Number.NEGATIVE_INFINITY;
    for (const ev of events) {
      if (typeof ev.ts_abs_ms === 'number') {
        if (ev.ts_abs_ms < tsMin) {
          tsMin = ev.ts_abs_ms;
        }
        if (ev.ts_abs_ms > tsMax) {
          tsMax = ev.ts_abs_ms;
        }
      }
    }
    if (!Number.isFinite(tsMin) || !Number.isFinite(tsMax)) {
      await this._releaseClaim(orphan.id);
      return { status: 'no_timestamps', recordId: orphanRecordId };
    }

    const candidates = await DataService.getSessionsOverlappingWindow(
      orphan.room_url,
      tsMin - toleranceMs,
      tsMax + toleranceMs,
      maxSessionMs
    );

    // 逐条分桶
    const buckets = new Map(); // sessionId -> { session, events: [] }
    const unmatched = [];
    for (const ev of events) {
      const hit = candidates.find(
        (s) => ev.ts_abs_ms >= s.started_ms - toleranceMs && ev.ts_abs_ms <= s.ended_ms + toleranceMs
      );
      if (hit) {
        if (!buckets.has(hit.id)) {
          buckets.set(hit.id, { session: hit, events: [] });
        }
        buckets.get(hit.id).events.push(ev);
      } else {
        unmatched.push(ev);
      }
    }

    const confidence = 1 - unmatched.length / events.length;
    const summary = this._summarize(buckets, unmatched, confidence);

    if (buckets.size === 0) {
      await this._releaseClaim(orphan.id);
      return { status: 'no_match', recordId: orphanRecordId, ...summary };
    }
    if (confidence < confidenceThreshold && !options.force) {
      await this._releaseClaim(orphan.id);
      return { status: 'low_confidence', recordId: orphanRecordId, confidenceThreshold, ...summary };
    }
    if (options.dryRun) {
      await this._releaseClaim(orphan.id);
      return { status: 'preview', recordId: orphanRecordId, ...summary };
    }

    // 落盘：逐桶合并到目标会话 JSONL（ts_ms 按目标会话重算 + 去重）
    const applied = [];
    const associatedSessionIds = [];
    try {
      for (const [sessionId, bucket] of buckets) {
        const merged = this._mergeToSessionJsonl(sessionId, bucket.session.started_ms, bucket.events, dedupScanLines);
        applied.push({ session_id: sessionId, matched: bucket.events.length, ...merged });
        associatedSessionIds.push(sessionId);
      }
    } catch (err) {
      // 落盘中途失败：释放占位让下次重试（去重逻辑保证重跑幂等）
      await this._releaseClaim(orphan.id);
      throw err;
    }

    // 未匹配事件回写孤儿文件（保留 _meta 首行）；全部匹配则清空事件行
    this._rewriteOrphanFile(orphan, unmatched);

    // 更新 DB 记录状态
    const newStatus = unmatched.length > 0 ? 'orphan_pending' : 'orphan_associated';
    await pool.query(
      `UPDATE danmaku_capture_records
       SET status = $1,
           session_id = $2,
           event_count = $3,
           ended_at = COALESCE(ended_at, NOW())
       WHERE id = $4`,
      [newStatus, associatedSessionIds.length === 1 ? associatedSessionIds[0] : null, unmatched.length, orphan.id]
    );

    return {
      status: 'applied',
      recordId: orphanRecordId,
      confidence,
      applied,
      unmatched: unmatched.length,
      newStatus,
    };
  }

  /**
   * 批量回填所有 orphan_pending 记录
   *
   * @param {Object} [options] - 透传给 reconcile（dryRun / force / 容差等）
   * @returns {Promise<{ total: number, results: Array }>}
   */
  async reconcileAll(options = {}) {
    const records = await DataService.listOrphanDanmakuRecords({ status: 'orphan_pending', limit: 500 });
    const results = [];
    for (const rec of records) {
      try {
        results.push(await this.reconcile(rec.id, options));
      } catch (err) {
        results.push({ status: 'error', recordId: rec.id, error: err.message });
      }
    }
    return { total: records.length, results };
  }

  /**
   * 人工丢弃某条孤儿记录：文件移动到 _discarded/（不硬删），状态置 orphan_discarded
   *
   * @param {number|string} orphanRecordId
   * @returns {Promise<Object>}
   */
  async discard(orphanRecordId) {
    const orphan = await DataService.getDanmakuCaptureRecord(orphanRecordId);
    if (!orphan) {
      return { status: 'not_found', recordId: orphanRecordId };
    }
    if (!String(orphan.status || '').startsWith('orphan_')) {
      return { status: 'not_orphan', recordId: orphanRecordId, currentStatus: orphan.status };
    }

    let archivedPath = null;
    if (orphan.raw_path && fs.existsSync(orphan.raw_path)) {
      try {
        const dir = getDiscardedOrphanDanmakuDir();
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        archivedPath = path.join(dir, `${orphan.id}_${path.basename(orphan.raw_path)}`);
        fs.renameSync(orphan.raw_path, archivedPath);
      } catch (err) {
        // 跨设备 rename 失败时降级为复制 + 删除
        try {
          fs.copyFileSync(orphan.raw_path, archivedPath);
          fs.unlinkSync(orphan.raw_path);
        } catch (err2) {
          console.error('[OrphanReconciler] 归档孤儿文件失败:', err2.message);
          archivedPath = null;
        }
      }
    }

    await pool.query(
      `UPDATE danmaku_capture_records SET status = 'orphan_discarded', raw_path = COALESCE($1, raw_path) WHERE id = $2`,
      [archivedPath, orphan.id]
    );

    return { status: 'discarded', recordId: orphanRecordId, archivedPath };
  }

  // ==================== 内部工具 ====================

  /**
   * 释放 reconcile 抢占：把 orphan_processing 回退为 orphan_pending。
   * 只在早退分支（empty / no_match / dryRun / 落盘失败）调用；成功路径由业务
   * UPDATE 直接切换到 orphan_associated 或 orphan_pending（含未匹配）。
   * @private
   */
  async _releaseClaim(id) {
    try {
      await pool.query(
        `UPDATE danmaku_capture_records
         SET status = 'orphan_pending'
         WHERE id = $1 AND status = 'orphan_processing'`,
        [id]
      );
    } catch (err) {
      console.error('[OrphanReconciler] 释放占位失败:', err.message);
    }
  }

  /**
   * 读取孤儿 JSONL，跳过 `_meta` 行、空行、畸形行与非对象行（null/数字/字符串）
   * @private
   */
  _readJsonl(filePath) {
    return readJsonlLines(filePath, { skipMeta: true });
  }

  /**
   * 合并一桶事件到目标会话 JSONL：按目标会话 started_ms 重算 ts_ms + 去重
   *
   * @param {number} sessionId
   * @param {number} sessionStartMs - 目标会话启动 epoch ms（来自 SQL，已处理时区）
   * @param {Array} events
   * @param {number} dedupScanLines - 去重时扫描目标文件尾部行数
   * @returns {{ written: number, skipped: number }}
   * @private
   */
  _mergeToSessionJsonl(sessionId, sessionStartMs, events, dedupScanLines) {
    const targetPath = getDanmakuJsonlPath(sessionId);
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const dedupSet = this._buildDedupSet(targetPath, dedupScanLines);

    const lines = [];
    let skipped = 0;
    for (const ev of events) {
      // ⚠️ ts_ms 必须按目标会话重算，否则整批字幕整体偏移（ADR-012 决策第 4 条）
      const rewritten = { ...ev };
      if (typeof ev.ts_abs_ms === 'number' && sessionStartMs > 0) {
        rewritten.ts_ms = Math.max(0, ev.ts_abs_ms - sessionStartMs);
      }
      const key = this._dedupKey(rewritten);
      if (dedupSet.has(key)) {
        skipped++;
        continue;
      }
      dedupSet.add(key);
      lines.push(JSON.stringify(rewritten));
    }

    if (lines.length > 0) {
      fs.appendFileSync(targetPath, lines.join('\n') + '\n');
    }
    return { written: lines.length, skipped };
  }

  /**
   * 扫描目标 JSONL 尾部 N 行构建去重集合
   * @private
   */
  _buildDedupSet(filePath, scanLines) {
    const set = new Set();
    const tailItems = readJsonlLines(filePath, {
      skipMeta: false,
      tailLines: scanLines || 200,
    });
    for (const obj of tailItems) {
      set.add(this._dedupKey(obj));
    }
    return set;
  }

  /**
   * 去重键：(ts_abs_ms, type, user_id, text)；like 降级到 (ts_abs_ms, type, count)
   * @private
   */
  _dedupKey(ev) {
    const abs = ev.ts_abs_ms != null ? ev.ts_abs_ms : ev.ts_ms;
    if (ev.type === 'like') {
      return `${abs}|like|${ev.count != null ? ev.count : ''}`;
    }
    return `${abs}|${ev.type || ''}|${ev.user_id || ''}|${ev.text || ''}`;
  }

  /**
   * 未匹配事件回写孤儿文件（重建：_meta 首行 + 剩余事件）
   * @private
   */
  _rewriteOrphanFile(orphan, unmatched) {
    try {
      const meta = {
        _meta: {
          room_url: orphan.room_url,
          received_at: orphan.created_at ? new Date(orphan.created_at).getTime() : Date.now(),
          schema: 'orphan-v1',
        },
      };
      const lines = [JSON.stringify(meta)];
      for (const ev of unmatched) lines.push(JSON.stringify(ev));
      // 全部匹配时仅保留 _meta，文件不删除（保留追溯痕迹，体积可忽略）
      fs.writeFileSync(orphan.raw_path, lines.join('\n') + '\n');
    } catch (err) {
      console.error('[OrphanReconciler] 回写孤儿文件失败:', err.message);
    }
  }

  /**
   * 汇总分桶结果供预览/低置信度返回
   * @private
   */
  _summarize(buckets, unmatched, confidence) {
    const bucketSummary = [];
    for (const [sessionId, bucket] of buckets) {
      bucketSummary.push({
        session_id: sessionId,
        matched: bucket.events.length,
        started_ms: bucket.session.started_ms,
        ended_ms: bucket.session.ended_ms,
        ended_at_inferred: bucket.session.ended_at_inferred,
      });
    }
    return {
      confidence,
      total_events: unmatched.length + bucketSummary.reduce((sum, b) => sum + b.matched, 0),
      unmatched: unmatched.length,
      buckets: bucketSummary,
    };
  }
}

module.exports = new OrphanDanmakuReconciler();
