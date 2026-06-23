const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../db/index');
const redis = require('../db/redis');
const { resolveAndValidate } = require('../lib/utils/path-safety');

const DELETE_PLAN_TTL = 600; // 10 分钟
const EVENT_LOOP_YIELD_INTERVAL = 10;

/**
 * 文件管理服务
 *
 * 提供文件扫描、索引同步、安全校验、删除计划和执行删除等能力。
 */
class FileManageService {
  // ========== 扫描与索引 ==========

  /**
   * 扫描所有业务目录，组合 DB 记录和磁盘状态，upsert 到 managed_files。
   *
   * 复用 recording_files 表已有结果（不独立扫描 VIDEO_DOWNLOAD_DIR），
   * 避免与 scanRecordingFiles() 双扫描冲突。
   */
  static async scanAllFiles() {
    const results = { scanned: 0, created: 0, updated: 0, missing: 0, errors: [] };

    // 1. 录制文件 → recording_file
    await this._scanRecordingFiles(results);

    // 2. HLS 目录 → hls_directory
    await this._scanHlsDirectories(results);

    // 3. 回放文件 → replay_raw / replay_cut / replay_fixed / replay_final
    await this._scanReplayFiles(results);

    // 4. 弹幕压制输出 → danmaku_output
    await this._scanDanmakuOutputFiles(results);

    // 5. 弹幕归档 → danmaku_archive
    await this._scanDanmakuArchiveFiles(results);

    // 6. 刷新磁盘状态（stat 已索引文件）
    await this._refreshDiskStatus(results);

    console.log(
      `[FileManage] 扫描完成: scanned=${results.scanned}, created=${results.created}, updated=${results.updated}, missing=${results.missing}`
    );
    return results;
  }

  /** 扫描 recording_files → managed_files (category=recording, file_type=recording_file) */
  static async _scanRecordingFiles(results) {
    const { rows } = await pool.query(`
      SELECT rf.id AS source_id, rf.file_path, rf.file_name, rf.file_size, rf.status,
             rf.session_id, rf.room_url, rs.output_dir
      FROM recording_files rf
      LEFT JOIN recording_sessions rs ON rf.session_id = rs.id
      WHERE rf.status NOT IN ('deleted', 'missing')
    `);

    for (const row of rows) {
      results.scanned++;
      const ext = path.extname(row.file_path).toLowerCase().replace('.', '');
      try {
        await pool.query(
          `INSERT INTO managed_files (category, file_type, source_table, source_id, group_id,
            file_path, file_name, extension, file_size, status, safe_to_delete, delete_block_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (file_path) DO UPDATE SET
             file_name = EXCLUDED.file_name,
             extension = EXCLUDED.extension,
             file_size = EXCLUDED.file_size,
             status = CASE
               WHEN managed_files.status IN ('deleting', 'deleted') THEN managed_files.status
               ELSE EXCLUDED.status
             END,
             source_id = EXCLUDED.source_id,
             group_id = EXCLUDED.group_id,
             updated_at = NOW()`,
          [
            'recording',
            'recording_file',
            'recording_files',
            row.source_id,
            row.session_id ? String(row.session_id) : null,
            row.file_path,
            row.file_name,
            ext,
            row.file_size,
            row.status === 'completed' ? 'active' : row.status,
            row.status === 'completed' ? true : false,
            row.status !== 'completed' ? `recording_status_${row.status}` : null,
          ]
        );
        results.created++;
      } catch (err) {
        results.errors.push({ file: row.file_path, error: err.message });
      }
    }
  }

  /** 扫描 HLS 目录 → managed_files (category=recording, file_type=hls_directory) */
  static async _scanHlsDirectories(results) {
    const { rows } = await pool.query(`
      SELECT rf.session_id, MIN(rf.hls_playlist_path) AS hls_playlist_path
      FROM recording_files rf
      WHERE rf.is_hls_ready = true
        AND rf.hls_playlist_path IS NOT NULL AND rf.hls_playlist_path != ''
        AND rf.session_id IS NOT NULL
      GROUP BY rf.session_id
    `);

    for (const row of rows) {
      results.scanned++;
      const hlsDir = path.dirname(row.hls_playlist_path);
      try {
        await pool.query(
          `INSERT INTO managed_files (category, file_type, source_table, source_id, group_id,
            file_path, file_name, extension, status, safe_to_delete, delete_block_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (file_path) DO UPDATE SET
             group_id = EXCLUDED.group_id,
             updated_at = NOW()`,
          [
            'recording',
            'hls_directory',
            'recording_sessions',
            row.session_id,
            row.session_id ? String(row.session_id) : null,
            hlsDir,
            path.basename(hlsDir),
            '',
            'active',
            true,
            null,
          ]
        );
        results.created++;
      } catch (err) {
        results.errors.push({ file: hlsDir, error: err.message });
      }
    }
  }

  /** 扫描回放文件 → managed_files */
  static async _scanReplayFiles(results) {
    const { rows } = await pool.query(`
      SELECT id, principal_id, principal_name, raw_file_path, cut_file_paths,
             fixed_file_paths, final_file_paths, status
      FROM replay_records
      WHERE status NOT IN ('pending', 'cancelled')
    `);

    const pathFields = [
      { field: 'raw_file_path', fileType: 'replay_raw' },
      { field: 'cut_file_paths', fileType: 'replay_cut' },
      { field: 'fixed_file_paths', fileType: 'replay_fixed' },
      { field: 'final_file_paths', fileType: 'replay_final' },
    ];

    for (const row of rows) {
      for (const { field, fileType } of pathFields) {
        const raw = row[field];
        if (!raw) continue;

        const paths = this._parseJsonPaths(raw);
        for (const filePath of paths) {
          if (!filePath) continue;
          results.scanned++;
          const ext = path.extname(filePath).toLowerCase().replace('.', '');
          const safeToDelete = ['completed', 'uploaded', 'backed_up', 'failed'].includes(row.status);
          try {
            await pool.query(
              `INSERT INTO managed_files (category, file_type, source_table, source_id, group_id,
                file_path, file_name, extension, status, safe_to_delete, delete_block_reason)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT (file_path) DO UPDATE SET
                 file_name = EXCLUDED.file_name,
                 extension = EXCLUDED.extension,
                 safe_to_delete = EXCLUDED.safe_to_delete,
                 delete_block_reason = EXCLUDED.delete_block_reason,
                 updated_at = NOW()`,
              [
                'replay',
                fileType,
                'replay_records',
                row.id,
                row.principal_id,
                filePath,
                path.basename(filePath),
                ext,
                'active',
                safeToDelete,
                !safeToDelete ? `replay_status_${row.status}` : null,
              ]
            );
            results.created++;
          } catch (err) {
            results.errors.push({ file: filePath, error: err.message });
          }
        }
      }
    }
  }

  /** 扫描弹幕压制输出 → managed_files (category=danmaku, file_type=danmaku_output) */
  static async _scanDanmakuOutputFiles(results) {
    const { rows } = await pool.query(`
      SELECT dbr.id AS source_id, dbr.output_path, dbr.status, dbr.session_id
      FROM danmaku_burn_records dbr
      WHERE dbr.output_path IS NOT NULL AND dbr.output_path != ''
        AND dbr.status = 'completed'
    `);

    for (const row of rows) {
      results.scanned++;
      const ext = path.extname(row.output_path).toLowerCase().replace('.', '');
      try {
        await pool.query(
          `INSERT INTO managed_files (category, file_type, source_table, source_id, group_id,
            file_path, file_name, extension, status, safe_to_delete, delete_block_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (file_path) DO UPDATE SET
             safe_to_delete = EXCLUDED.safe_to_delete,
             updated_at = NOW()`,
          [
            'danmaku',
            'danmaku_output',
            'danmaku_burn_records',
            row.source_id,
            row.session_id ? String(row.session_id) : null,
            row.output_path,
            path.basename(row.output_path),
            ext,
            'active',
            true,
            null,
          ]
        );
        results.created++;
      } catch (err) {
        results.errors.push({ file: row.output_path, error: err.message });
      }
    }
  }

  /** 扫描弹幕归档 → managed_files (category=danmaku, file_type=danmaku_archive) */
  static async _scanDanmakuArchiveFiles(results) {
    const { rows } = await pool.query(`
      SELECT dcr.id AS source_id, dcr.raw_path, dcr.session_id, dcr.status
      FROM danmaku_capture_records dcr
      WHERE dcr.raw_path IS NOT NULL AND dcr.raw_path != ''
    `);

    for (const row of rows) {
      results.scanned++;
      const ext = path.extname(row.raw_path).toLowerCase().replace('.', '');
      try {
        await pool.query(
          `INSERT INTO managed_files (category, file_type, source_table, source_id, group_id,
            file_path, file_name, extension, status, safe_to_delete, delete_block_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (file_path) DO UPDATE SET
             status = EXCLUDED.status,
             updated_at = NOW()`,
          [
            'danmaku',
            'danmaku_archive',
            'danmaku_capture_records',
            row.source_id,
            row.session_id ? String(row.session_id) : null,
            row.raw_path,
            path.basename(row.raw_path),
            ext,
            'active',
            false, // 弹幕归档默认不可清理
            'danmaku_archive_protected',
          ]
        );
        results.created++;
      } catch (err) {
        results.errors.push({ file: row.raw_path, error: err.message });
      }
    }
  }

  /** 刷新已索引文件的磁盘状态 */
  static async _refreshDiskStatus(results) {
    const { rows } = await pool.query(`
      SELECT id, file_path, file_type FROM managed_files
      WHERE status NOT IN ('deleting', 'deleted', 'missing')
    `);

    let idx = 0;
    for (const row of rows) {
      idx++;
      try {
        const stat = await fs.promises.stat(row.file_path);
        await pool.query(
          `UPDATE managed_files SET file_size = $1, mtime = $2, exists_on_disk = true, updated_at = NOW()
           WHERE id = $3`,
          [stat.size, stat.mtime, row.id]
        );
        results.updated++;
      } catch (err) {
        if (err.code === 'ENOENT') {
          await pool.query(
            `UPDATE managed_files SET exists_on_disk = false, status = 'missing', updated_at = NOW()
             WHERE id = $1`,
            [row.id]
          );
          results.missing++;
        }
      }
      if (idx % EVENT_LOOP_YIELD_INTERVAL === 0) {
        await new Promise((r) => setImmediate(r));
      }
    }
  }

  // ========== 查询 ==========

  /** 按 category 聚合空间占用 */
  static async getFileSummary() {
    const { rows } = await pool.query(`
      SELECT category,
             COUNT(*) AS file_count,
             COALESCE(SUM(file_size), 0) AS total_size
      FROM managed_files
      WHERE status NOT IN ('deleted', 'missing')
      GROUP BY category
    `);

    const categoryMap = {
      recording: { type: 'recording', root: process.env.VIDEO_DOWNLOAD_DIR || '/data/video_downloads' },
      replay: { type: 'replay', root: process.env.REPLAY_WORK_DIR || '/data/replay' },
      danmaku: { type: 'danmaku', root: process.env.DANMAKU_OUTPUT_DIR || '/data/danmaku_output' },
      orphan: { type: 'orphan', root: null },
    };

    const groups = rows.map((r) => ({
      ...(categoryMap[r.category] || { type: r.category, root: null }),
      size: Number(r.total_size),
      file_count: Number(r.file_count),
    }));

    const totalSize = groups.reduce((sum, g) => sum + g.size, 0);
    const safeToDeleteResult = await pool.query(`
      SELECT COALESCE(SUM(file_size), 0) AS safe_size
      FROM managed_files
      WHERE safe_to_delete = true AND status NOT IN ('deleted', 'missing')
    `);

    return {
      total_size: totalSize,
      safe_to_delete_size: Number(safeToDeleteResult.rows[0].safe_size),
      groups,
    };
  }

  /**
   * 分页筛选文件列表
   * @param {object} filters - type, category, status, room_id, session_id, replay_record_id, ext, min_size, start_date, end_date, safe_to_delete, exists_on_disk
   * @param {object} pagination - page (default 1), limit (default 50, max 200), sort (default 'file_size DESC')
   */
  static async getFileList(filters = {}, pagination = {}) {
    const page = Math.max(1, parseInt(pagination.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(pagination.limit) || 50));
    const sort = pagination.sort || 'file_size DESC';
    const offset = (page - 1) * limit;

    const conditions = ["status NOT IN ('deleted')"];
    const params = [];
    let paramIdx = 0;

    if (filters.type) {
      paramIdx++;
      conditions.push(`file_type = $${paramIdx}`);
      params.push(filters.type);
    }
    if (filters.category) {
      paramIdx++;
      conditions.push(`category = $${paramIdx}`);
      params.push(filters.category);
    }
    if (filters.status) {
      paramIdx++;
      conditions.push(`status = $${paramIdx}`);
      params.push(filters.status);
    }
    if (filters.exists_on_disk !== undefined) {
      paramIdx++;
      conditions.push(`exists_on_disk = $${paramIdx}`);
      params.push(filters.exists_on_disk === 'true' || filters.exists_on_disk === true);
    }
    if (filters.safe_to_delete !== undefined) {
      paramIdx++;
      conditions.push(`safe_to_delete = $${paramIdx}`);
      params.push(filters.safe_to_delete === 'true' || filters.safe_to_delete === true);
    }
    if (filters.ext) {
      paramIdx++;
      conditions.push(`extension = $${paramIdx}`);
      params.push(filters.ext.replace('.', ''));
    }
    if (filters.min_size) {
      paramIdx++;
      conditions.push(`file_size >= $${paramIdx}`);
      params.push(BigInt(filters.min_size));
    }
    if (filters.start_date) {
      paramIdx++;
      conditions.push(`mtime >= $${paramIdx}`);
      params.push(filters.start_date);
    }
    if (filters.end_date) {
      paramIdx++;
      conditions.push(`mtime <= $${paramIdx}`);
      params.push(filters.end_date);
    }
    // older_than_days: 直接拼接 SQL interval，不使用参数化（days 已 parseInt 校验）
    if (filters.older_than_days) {
      const days = parseInt(filters.older_than_days, 10);
      if (!isNaN(days) && days > 0) {
        conditions.push(`mtime <= NOW() - INTERVAL '${days} days'`);
      }
    }
    // group_id 用于按 session / principal 筛选
    if (filters.session_id) {
      paramIdx++;
      conditions.push(`group_id = $${paramIdx}`);
      params.push(String(filters.session_id));
    }

    const whereClause = conditions.join(' AND ');

    // 白名单排序字段，防止 SQL 注入
    const allowedSorts = ['file_size', 'mtime', 'file_name', 'created_at', 'category', 'file_type', 'status'];
    const [sortField, sortDir] = sort.split(' ');
    const safeSortField = allowedSorts.includes(sortField) ? sortField : 'file_size';
    const safeSortDir = sortDir?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    paramIdx++;
    const limitParam = paramIdx;
    params.push(limit);
    paramIdx++;
    const offsetParam = paramIdx;
    params.push(offset);

    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM managed_files WHERE ${whereClause}`,
      params.slice(0, paramIdx - 2)
    );

    const dataResult = await pool.query(
      `SELECT id, category, file_type, source_table, source_id, group_id,
              file_path, file_name, extension, file_size, mtime,
              exists_on_disk, status, safe_to_delete, delete_block_reason,
              created_at, updated_at
       FROM managed_files
       WHERE ${whereClause}
       ORDER BY ${safeSortField} ${safeSortDir}
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      params
    );

    return {
      total: Number(countResult.rows[0].total),
      page,
      limit,
      data: dataResult.rows,
    };
  }

  /** 单文件详情 */
  static async getFileDetail(id) {
    const { rows } = await pool.query(`SELECT * FROM managed_files WHERE id = $1`, [id]);
    if (rows.length === 0) return null;

    const file = rows[0];

    // 活跃任务检查
    const activeTask = await this.isFileInActiveTask(file.file_path);

    // 审计日志
    const auditResult = await pool.query(
      `SELECT id, action, result, operator, deleted_by, created_at, error_message
       FROM file_delete_audit_logs WHERE file_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [id]
    );

    return {
      ...file,
      active_task: activeTask,
      recent_audits: auditResult.rows,
    };
  }

  // ========== 删除计划 ==========

  /**
   * 生成删除计划（dry-run）
   * @param {object} input - { file_ids?: number[], filters?: object }
   * @param {string} operator
   * @returns {object} { plan_id, expires_at, deletable_count, blocked_count, total_size, deletable[], blocked[] }
   */
  static async generateDeletePlan(input, operator = 'user') {
    let files;

    if (input.file_ids && input.file_ids.length > 0) {
      if (input.file_ids.length > 200) {
        throw new Error('file_ids 模式单次最多 200 个文件');
      }
      const ids = input.file_ids;
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await pool.query(
        `SELECT * FROM managed_files WHERE id IN (${placeholders}) AND status NOT IN ('deleted', 'deleting')`,
        ids
      );
      files = rows;
    } else if (input.filters) {
      // 清理规则模式：不设 200 条上限，使用 getFileList 的分页机制遍历全部
      // 先获取总数
      const countResult = await this.getFileList(input.filters, { page: 1, limit: 1 });
      const total = countResult.total;
      if (total === 0) {
        return {
          plan_id: crypto.randomUUID(),
          expires_at: new Date(Date.now() + DELETE_PLAN_TTL * 1000).toISOString(),
          deletable_count: 0,
          blocked_count: 0,
          total_size: 0,
          deletable: [],
          blocked: [],
        };
      }
      // 分批获取全部文件
      files = [];
      for (let p = 1; files.length < total; p++) {
        const result = await this.getFileList(input.filters, { page: p, limit: 500 });
        files.push(...result.data);
        if (result.data.length === 0 || files.length >= total) break;
      }
    } else {
      throw new Error('必须提供 file_ids 或 filters');
    }

    const deletable = [];
    const blocked = [];

    for (const file of files) {
      const validation = await this.validateFileSafety(file);
      if (validation.safe) {
        deletable.push({
          file_id: file.id,
          file_path: file.file_path,
          file_name: file.file_name,
          file_size: file.file_size,
          category: file.category,
          file_type: file.file_type,
          source_table: file.source_table,
          source_id: file.source_id,
        });
      } else {
        blocked.push({
          file_id: file.id,
          file_path: file.file_path,
          file_name: file.file_name,
          reason: validation.reason,
        });
      }
    }

    const totalSize = deletable.reduce((sum, f) => sum + Number(f.file_size || 0), 0);
    const planId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + DELETE_PLAN_TTL * 1000);

    const plan = {
      plan_id: planId,
      operator,
      created_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
      deletable,
      blocked,
      total_size: totalSize,
    };

    await redis.setEx(`file_delete_plan:${planId}`, DELETE_PLAN_TTL, JSON.stringify(plan));

    return {
      plan_id: planId,
      expires_at: expiresAt.toISOString(),
      deletable_count: deletable.length,
      blocked_count: blocked.length,
      total_size: totalSize,
      deletable,
      blocked,
    };
  }

  /**
   * 异步执行删除（批量删除）
   * 创建删除任务，立即返回 task_id，后台 worker 异步执行。
   * @param {string} planId
   * @param {string} operator
   * @returns {{ task_id: string, status: string }}
   */
  static async executeDelete(planId, operator = 'user') {
    const planJson = await redis.get(`file_delete_plan:${planId}`);
    if (!planJson) {
      throw new Error('删除计划不存在或已过期');
    }

    const plan = JSON.parse(planJson);
    const taskId = crypto.randomUUID();
    const totalCount = plan.deletable.length;

    // 将任务状态写入 Redis
    const task = {
      task_id: taskId,
      plan_id: planId,
      status: 'processing',
      total_count: totalCount,
      deleted_count: 0,
      blocked_count: plan.blocked.length,
      failed_count: 0,
      estimated_release_size: plan.total_size,
      actual_release_size: 0,
      operator,
      results: [],
      created_at: new Date().toISOString(),
    };
    await redis.setEx(`file_delete_task:${taskId}`, DELETE_PLAN_TTL * 3, JSON.stringify(task));

    // 后台异步执行（不 await，fire-and-forget）
    this._processDeleteTask(taskId, plan, operator).catch((err) => {
      console.error(`[FileManage] 删除任务 ${taskId} 异常:`, err);
    });

    return { task_id: taskId, status: 'processing' };
  }

  /** 查询删除任务进度 */
  static async getDeleteTaskStatus(taskId) {
    const taskJson = await redis.get(`file_delete_task:${taskId}`);
    if (!taskJson) return null;
    return JSON.parse(taskJson);
  }

  /**
   * 后台处理删除任务（内部方法）
   * 逐文件执行删除，实时更新 Redis 中的任务状态。
   */
  static async _processDeleteTask(taskId, plan, operator) {
    const task = JSON.parse(await redis.get(`file_delete_task:${taskId}`));

    for (let i = 0; i < plan.deletable.length; i++) {
      const item = plan.deletable[i];

      if (i > 0 && i % EVENT_LOOP_YIELD_INTERVAL === 0) {
        await new Promise((r) => setImmediate(r));
      }

      const result = await this._deleteSingleFile(item, operator);
      task.results.push(result);

      if (result.result === 'success' || result.result === 'success_noop') {
        task.deleted_count++;
        task.actual_release_size += result.actual_release_size;
      } else if (result.result === 'blocked') {
        task.blocked_count++;
      } else {
        task.failed_count++;
      }

      // 每处理一个文件就更新 Redis 状态（供轮询）
      await redis.setEx(`file_delete_task:${taskId}`, DELETE_PLAN_TTL * 3, JSON.stringify(task));
    }

    task.status = 'completed';
    await redis.setEx(`file_delete_task:${taskId}`, DELETE_PLAN_TTL * 3, JSON.stringify(task));

    // 清理删除计划
    await redis.del(`file_delete_plan:${plan.plan_id}`);
  }

  /**
   * 同步执行单文件删除
   * 单文件删除可同步执行，但仍需重新校验安全规则。
   * @param {object} fileRecord - managed_files 行
   * @param {string} operator
   * @returns {object} 单文件删除结果
   */
  static async executeSingleDelete(fileRecord, operator = 'user') {
    const item = {
      file_id: fileRecord.id,
      file_path: fileRecord.file_path,
      file_size: fileRecord.file_size,
      category: fileRecord.category,
      file_type: fileRecord.file_type,
      source_table: fileRecord.source_table,
      source_id: fileRecord.source_id,
    };
    return this._deleteSingleFile(item, operator);
  }

  /** 删除单个文件（内部方法） */
  static async _deleteSingleFile(item, operator) {
    const { file_id, file_path, file_size, category, file_type, source_table, source_id } = item;
    const result = { file_id, file_path, result: null, error: null, actual_release_size: 0 };

    // 获取 advisory lock
    await pool.query(`SELECT pg_advisory_lock($1)`, [file_id]);

    try {
      // 重新校验：读取最新状态
      const { rows } = await pool.query(`SELECT * FROM managed_files WHERE id = $1`, [file_id]);
      if (rows.length === 0) {
        result.result = 'blocked';
        result.error = 'file_record_not_found';
        return result;
      }

      const currentFile = rows[0];
      if (currentFile.status === 'deleted' || currentFile.status === 'deleting') {
        result.result = 'blocked';
        result.error = 'already_deleted_or_deleting';
        return result;
      }

      // 重新跑安全规则
      const validation = await this.validateFileSafety(currentFile);
      if (!validation.safe) {
        result.result = 'blocked';
        result.error = validation.reason;
        return result;
      }

      // 标记为 deleting
      await pool.query(`UPDATE managed_files SET status = 'deleting', updated_at = NOW() WHERE id = $1`, [file_id]);

      // unlink 文件（目录使用递归删除）
      let unlinkResult;
      try {
        const stat = await fs.promises.stat(file_path);
        if (stat.isDirectory()) {
          await fs.promises.rm(file_path, { recursive: true, force: true });
        } else {
          await fs.promises.unlink(file_path);
        }
        unlinkResult = 'success';
        result.actual_release_size = Number(file_size || 0);
      } catch (err) {
        if (err.code === 'ENOENT') {
          unlinkResult = 'success_noop';
          result.actual_release_size = 0;
        } else if (err.code === 'EBUSY' || err.code === 'EPERM') {
          // 回滚 deleting 状态
          await pool.query(`UPDATE managed_files SET status = 'active', updated_at = NOW() WHERE id = $1`, [file_id]);
          result.result = 'blocked';
          result.error = 'file_locked';
          // 审计日志
          await this._writeAuditLog({
            file_id,
            file_path,
            file_size,
            category,
            source_table,
            source_id,
            operator,
            deleted_by: 'user',
            action: 'delete',
            result: 'blocked',
            estimated_release_size: Number(file_size || 0),
            actual_release_size: 0,
            error_message: err.message,
          });
          return result;
        } else {
          // 回滚
          await pool.query(`UPDATE managed_files SET status = 'active', updated_at = NOW() WHERE id = $1`, [file_id]);
          throw err;
        }
      }

      // 事务：更新 managed_files + 源表 + 审计日志
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(
          `UPDATE managed_files SET status = 'deleted', exists_on_disk = false, deleted_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [file_id]
        );

        // 更新源业务表状态
        // 注意：HLS 目录的 source_table='recording_files' 但 source_id 是 session_id，
        // 不应直接用 source_id 更新 recording_files（会误标同 ID 的录制文件为 deleted）
        if (source_table === 'recording_files' && source_id && file_type !== 'hls_directory') {
          await client.query(`UPDATE recording_files SET status = 'deleted' WHERE id = $1`, [source_id]);
        }

        await client.query(
          `INSERT INTO file_delete_audit_logs
            (file_id, file_path, file_size, category, source_table, source_id,
             operator, deleted_by, action, result, estimated_release_size, actual_release_size)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            file_id,
            file_path,
            file_size,
            category,
            source_table,
            source_id,
            operator,
            'user',
            'delete',
            unlinkResult === 'success_noop' ? 'success_noop' : 'success',
            Number(file_size || 0),
            result.actual_release_size,
          ]
        );

        await client.query('COMMIT');
        result.result = unlinkResult === 'success_noop' ? 'success_noop' : 'success';
      } catch (err) {
        await client.query('ROLLBACK');
        result.result = 'failed';
        result.error = err.message;
      } finally {
        client.release();
      }
    } catch (err) {
      result.result = 'failed';
      result.error = err.message;
    } finally {
      await pool.query(`SELECT pg_advisory_unlock($1)`, [file_id]);
    }

    return result;
  }

  // ========== 安全校验 ==========

  /**
   * 校验文件是否可安全删除（8 条规则）
   * @param {object} fileRecord - managed_files 行
   * @returns {Promise<{safe: boolean, reason?: string}>}
   */
  static async validateFileSafety(fileRecord) {
    const { file_path, file_type, source_table, source_id } = fileRecord;

    // 1. 路径位于 allowlist 内
    const pathCheck = await resolveAndValidate(file_path);
    if (!pathCheck.valid) {
      return { safe: false, reason: pathCheck.reason };
    }

    // 2. 文件当前存在
    let stat;
    try {
      stat = await fs.promises.stat(file_path);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { safe: false, reason: 'file_not_found' };
      }
      return { safe: false, reason: `stat_error: ${err.message}` };
    }

    // 3. 不是目录
    if (stat.isDirectory()) {
      // HLS 目录作为聚合对象，允许目录级删除
      if (file_type !== 'hls_directory') {
        return { safe: false, reason: 'is_directory' };
      }
    }

    // 5. 不属于活跃任务
    const activeTask = await this.isFileInActiveTask(file_path);
    if (activeTask) {
      return { safe: false, reason: `active_task_${activeTask.type}` };
    }

    // 6. 不属于 recording 会话
    if (source_table === 'recording_files' && source_id) {
      const sessionCheck = await pool.query(
        `SELECT rs.status FROM recording_sessions rs
         JOIN recording_files rf ON rf.session_id = rs.id
         WHERE rf.id = $1 AND rs.status = 'recording'`,
        [source_id]
      );
      if (sessionCheck.rows.length > 0) {
        return { safe: false, reason: 'active_recording_session' };
      }
    }

    // 7. 不属于 Redis 队列中的待处理任务
    if (source_table === 'recording_files' && source_id) {
      const inQueue = await this._isFileInRedisQueue(file_path);
      if (inQueue) {
        return { safe: false, reason: 'in_processing_queue' };
      }
    }

    // 8. 业务记录已完成/失败/取消
    if (source_table === 'recording_files' && source_id) {
      const rfCheck = await pool.query(`SELECT status FROM recording_files WHERE id = $1`, [source_id]);
      if (rfCheck.rows.length > 0 && !['completed', 'interrupted'].includes(rfCheck.rows[0].status)) {
        return { safe: false, reason: `recording_status_${rfCheck.rows[0].status}` };
      }
    }

    if (source_table === 'replay_records' && source_id) {
      const rrCheck = await pool.query(`SELECT status FROM replay_records WHERE id = $1`, [source_id]);
      if (
        rrCheck.rows.length > 0 &&
        !['completed', 'uploaded', 'backed_up', 'failed', 'cancelled'].includes(rrCheck.rows[0].status)
      ) {
        return { safe: false, reason: `replay_status_${rrCheck.rows[0].status}` };
      }
    }

    if (source_table === 'danmaku_burn_records' && source_id) {
      const dbrCheck = await pool.query(`SELECT status FROM danmaku_burn_records WHERE id = $1`, [source_id]);
      if (dbrCheck.rows.length > 0 && !['completed', 'failed', 'skipped'].includes(dbrCheck.rows[0].status)) {
        return { safe: false, reason: `danmaku_burn_status_${dbrCheck.rows[0].status}` };
      }
    }

    return { safe: true };
  }

  /**
   * 检查文件是否属于活跃任务（录制/转码/压制/投稿）
   * @param {string} filePath - 文件路径
   * @returns {Promise<{type: string}|null>} 活跃任务类型或 null
   */
  static async isFileInActiveTask(filePath) {
    // 录制中：recording_sessions.status = 'recording' 的文件
    const recordingCheck = await pool.query(
      `SELECT rf.id FROM recording_files rf
       JOIN recording_sessions rs ON rf.session_id = rs.id
       WHERE rf.file_path = $1 AND rs.status = 'recording'`,
      [filePath]
    );
    if (recordingCheck.rows.length > 0) {
      return { type: 'recording' };
    }

    // 转码中
    const transcodeCheck = await pool.query(
      `SELECT id FROM transcode_records
       WHERE (original_path = $1 OR transcoded_path = $1) AND status IN ('queued', 'processing')`,
      [filePath]
    );
    if (transcodeCheck.rows.length > 0) {
      return { type: 'transcoding' };
    }

    // 弹幕压制中
    const burnCheck = await pool.query(
      `SELECT id FROM danmaku_burn_records
       WHERE (input_path = $1 OR output_path = $1) AND status IN ('queued', 'processing')`,
      [filePath]
    );
    if (burnCheck.rows.length > 0) {
      return { type: 'danmaku_burning' };
    }

    // 投稿中
    const uploadCheck = await pool.query(
      `SELECT id FROM upload_records WHERE status IN ('pending', 'uploading') AND upload_files::text LIKE $1`,
      [`%${filePath}%`]
    );
    if (uploadCheck.rows.length > 0) {
      return { type: 'uploading' };
    }

    return null;
  }

  // ========== 内部工具 ==========

  /**
   * 解析 JSON 字符串为路径数组
   * 回放记录的 cut_file_paths / fixed_file_paths / final_file_paths 是 JSON 字符串
   */
  static _parseJsonPaths(raw) {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((p) => p && typeof p === 'string');
      }
      return [raw]; // 降级：原始文本作为单个路径
    } catch {
      return [raw]; // JSON 解析失败，降级为原始文本
    }
  }

  /** 检查文件路径是否在 Redis 处理队列中 */
  static async _isFileInRedisQueue(filePath) {
    // 检查转码队列
    const transcodeQueue = await redis.lRange('transcode_queue', 0, -1);
    for (const item of transcodeQueue) {
      try {
        const parsed = JSON.parse(item);
        if (parsed.original_path === filePath || parsed.transcoded_path === filePath) return true;
      } catch {
        // 忽略解析错误
      }
    }

    // 检查弹幕压制队列
    const burnQueue = await redis.lRange('danmaku_burn_queue', 0, -1);
    for (const item of burnQueue) {
      try {
        const parsed = JSON.parse(item);
        if (parsed.input_path === filePath || parsed.output_path === filePath) return true;
      } catch {
        // 忽略解析错误
      }
    }

    return false;
  }

  /** 写审计日志 */
  static async _writeAuditLog(data) {
    await pool.query(
      `INSERT INTO file_delete_audit_logs
        (file_id, file_path, file_size, category, source_table, source_id,
         operator, deleted_by, action, result, estimated_release_size, actual_release_size, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        data.file_id,
        data.file_path,
        data.file_size,
        data.category,
        data.source_table,
        data.source_id,
        data.operator,
        data.deleted_by,
        data.action,
        data.result,
        data.estimated_release_size || 0,
        data.actual_release_size || 0,
        data.error_message || null,
      ]
    );
  }
}

module.exports = FileManageService;
