const pool = require('./index');
const ensureDatabase = require('./ensure-database');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
// 迁移事务包含 DROP TABLE / DROP COLUMN，需要 ACCESS EXCLUSIVE 锁。
// 滚动部署时旧实例的查询可能持锁，用 lock_timeout 快速失败 + 重试，
// 避免启动阶段无限期阻塞在等锁上。
const LOCK_TIMEOUT_MS = 5000;
// 40P01 死锁、55P03 拿不到锁（lock_timeout 触发）
const RETRYABLE_CODES = new Set(['40P01', '55P03']);

async function migrate() {
  await ensureDatabase();

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await runMigration();
    } catch (err) {
      lastError = err;
      if (err.code === '3D000' && attempt === 1) {
        try {
          await ensureDatabase();
          continue;
        } catch (createErr) {
          console.error('[DB] 自动建库失败:', createErr.message);
        }
      }
      if (RETRYABLE_CODES.has(err.code) && attempt < MAX_RETRIES) {
        console.warn(`[DB] 迁移锁冲突 ${err.code} (${attempt}/${MAX_RETRIES}), ${RETRY_DELAY_MS}ms 后重试...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

async function runMigration() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION admin_users_set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_admin_users_updated_at ON admin_users
    `);

    await client.query(`
      CREATE TRIGGER trg_admin_users_updated_at
      BEFORE UPDATE ON admin_users
      FOR EACH ROW
      EXECUTE FUNCTION admin_users_set_updated_at()
    `);

    // ========== rooms ==========

    await client.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        room_url VARCHAR(512) UNIQUE NOT NULL,
        room_name VARCHAR(255) DEFAULT '',
        status VARCHAR(20) DEFAULT 'idle',
        filename_template VARCHAR(255) DEFAULT '{room_name}_{datetime}',
        output_path VARCHAR(1024) DEFAULT '',
        ffmpeg_pid INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        segment_duration INTEGER DEFAULT 0,
        notification_enabled BOOLEAN DEFAULT TRUE,
        monitoring_enabled BOOLEAN DEFAULT TRUE,
        polling_enabled BOOLEAN DEFAULT FALSE,
        polling_platform VARCHAR(50) DEFAULT NULL,
        polling_interval INTEGER DEFAULT 60
      )
    `);

    // ========== recording_sessions ==========

    await client.query(`
      CREATE TABLE IF NOT EXISTS recording_sessions (
        id SERIAL PRIMARY KEY,
        room_url VARCHAR(512) REFERENCES rooms(room_url) ON DELETE CASCADE,
        started_at TIMESTAMP DEFAULT NOW(),
        ended_at TIMESTAMP,
        status VARCHAR(20) DEFAULT 'recording',
        total_segments INTEGER DEFAULT 0,
        total_size BIGINT DEFAULT 0,
        output_dir VARCHAR(1024) DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        caption VARCHAR(1024) DEFAULT '',
        deleted_at TIMESTAMP,
        retry_count INTEGER DEFAULT 0,
        stream_url VARCHAR(1024) DEFAULT '',
        output_path VARCHAR(1024) DEFAULT '',
        cover_url VARCHAR(1024) DEFAULT '',
        cover_path VARCHAR(1024) DEFAULT ''
      )
    `);

    // ========== upload_templates ==========

    await client.query(`
      CREATE TABLE IF NOT EXISTS upload_templates (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL DEFAULT '',
        title_template VARCHAR(1024) NOT NULL DEFAULT '{room_name} 直播录像 {date}',
        desc_template TEXT DEFAULT '',
        tid INTEGER DEFAULT 171,
        tags VARCHAR(1024) DEFAULT '',
        copyright INTEGER DEFAULT 2,
        source VARCHAR(1024) DEFAULT '',
        cover VARCHAR(1024) DEFAULT '',
        is_only_self INTEGER DEFAULT 0,
        cookies_path VARCHAR(1024) DEFAULT '',
        dtime INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        after_upload VARCHAR(20) DEFAULT 'none'
      )
    `);

    // rooms.upload_template_id 需要在 upload_templates 创建后才能添加 FK
    await client.query(`
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS upload_template_id INTEGER REFERENCES upload_templates(id) ON DELETE SET NULL
    `);

    // v1.9.0：投稿模板「使用直播间封面」开关（勾选后投稿优先取会话/回放侧封面，模板固定封面作兜底）
    await client.query(`
      ALTER TABLE upload_templates ADD COLUMN IF NOT EXISTS use_room_cover BOOLEAN DEFAULT false
    `);

    // v1.11.0：投稿后自动加入合集（Season → Section）模板配置
    // season_title 仅用于展示，归属与有效性以线上接口为准；写操作真正入参是 section_id
    await client.query(`
      ALTER TABLE upload_templates
        ADD COLUMN IF NOT EXISTS season_id BIGINT,
        ADD COLUMN IF NOT EXISTS season_title VARCHAR(255),
        ADD COLUMN IF NOT EXISTS section_id BIGINT,
        ADD COLUMN IF NOT EXISTS season_auto_add BOOLEAN NOT NULL DEFAULT false
    `);

    // ========== upload_records ==========

    await client.query(`
      CREATE TABLE IF NOT EXISTS upload_records (
        id SERIAL PRIMARY KEY,
        session_id INTEGER REFERENCES recording_sessions(id) ON DELETE SET NULL,
        template_id INTEGER REFERENCES upload_templates(id) ON DELETE SET NULL,
        room_url VARCHAR(512),
        title VARCHAR(512) DEFAULT '',
        status VARCHAR(20) DEFAULT 'pending',
        command TEXT DEFAULT '',
        output TEXT DEFAULT '',
        error_message TEXT DEFAULT '',
        file_count INTEGER DEFAULT 0,
        total_size BIGINT DEFAULT 0,
        bv_id VARCHAR(50) DEFAULT '',
        started_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        upload_files TEXT DEFAULT '[]'
      )
    `);

    // v1.11.0：投稿后加入合集的状态机（幂等占位 + 失败原因 + 尝试计数）
    // 仅描述合集追加结果，与投稿本身的 status 完全解耦，失败不回写 status
    // v1.13.3：season_pending_since 记录占位时刻，供重启续跑与就绪等待窗口计算；终态保留不清空
    await client.query(`
      ALTER TABLE upload_records
        ADD COLUMN IF NOT EXISTS season_id BIGINT,
        ADD COLUMN IF NOT EXISTS season_status VARCHAR(16) NOT NULL DEFAULT 'none',
        ADD COLUMN IF NOT EXISTS season_error TEXT,
        ADD COLUMN IF NOT EXISTS season_attempts SMALLINT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS season_added_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS season_pending_since TIMESTAMP
    `);

    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'upload_records_season_status_check') THEN
          ALTER TABLE upload_records ADD CONSTRAINT upload_records_season_status_check
            CHECK (season_status IN ('none', 'pending', 'added', 'failed', 'skipped'));
        END IF;
      END $$;
    `);

    // ========== biliup_accounts ==========
    // v1.11.0：biliup 账号登记（仅新增/查询/删除，无 UPDATE 路由）。
    // cookies_path 是模板既有字段的旁路引用，不改变模板语义；cookie 内容一律不入库。
    await client.query(`
      CREATE TABLE IF NOT EXISTS biliup_accounts (
        id SERIAL PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        cookies_path VARCHAR(1024) NOT NULL,
        uid BIGINT,
        nickname VARCHAR(128),
        login_status VARCHAR(16) NOT NULL DEFAULT 'unknown',
        last_checked_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // ========== replay_records ==========

    await client.query(`
      CREATE TABLE IF NOT EXISTS replay_records (
        id SERIAL PRIMARY KEY,
        principal_id VARCHAR(128) NOT NULL,
        principal_name VARCHAR(255) DEFAULT '',
        replay_id VARCHAR(128) DEFAULT '',
        play_url TEXT DEFAULT '',
        m3u8_url TEXT DEFAULT '',
        poster TEXT DEFAULT '',
        resolution VARCHAR(50) DEFAULT '',
        video_file_name VARCHAR(512) DEFAULT '',
        raw_file_path VARCHAR(1024) DEFAULT '',
        cut_file_paths TEXT DEFAULT '[]',
        fixed_file_paths TEXT DEFAULT '[]',
        final_file_paths TEXT DEFAULT '[]',
        file_size BIGINT DEFAULT 0,
        bv_id VARCHAR(50) DEFAULT '',
        status VARCHAR(50) DEFAULT 'pending',
        start_time TIMESTAMP,
        duration INTEGER DEFAULT 0,
        uploaded_at TIMESTAMP,
        backed_up_at TIMESTAMP,
        completed_at TIMESTAMP,
        error_message TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // v1.9.0：回放封面下载落盘路径（poster 列仍存 URL，投稿时优先用本地文件）
    await client.query(`
      ALTER TABLE replay_records ADD COLUMN IF NOT EXISTS poster_path VARCHAR(1024) DEFAULT ''
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_replay_records_principal_replay_id
      ON replay_records(principal_id, replay_id)
      WHERE replay_id IS NOT NULL AND replay_id <> ''
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_replay_records_principal ON replay_records(principal_id, status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_replay_records_replay_id ON replay_records(replay_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_replay_records_start_time ON replay_records(principal_id, start_time DESC)
    `);

    // ========== replay_settings ==========

    await client.query(`
      CREATE TABLE IF NOT EXISTS replay_settings (
        key VARCHAR(255) NOT NULL,
        principal_id VARCHAR(128) NOT NULL DEFAULT '',
        value TEXT DEFAULT '',
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (key, principal_id)
      )
    `);

    // ========== replay_upload_records ==========

    await client.query(`
      CREATE TABLE IF NOT EXISTS replay_upload_records (
        id SERIAL PRIMARY KEY,
        replay_record_id INTEGER REFERENCES replay_records(id) ON DELETE SET NULL,
        template_id INTEGER REFERENCES upload_templates(id) ON DELETE SET NULL,
        template_name VARCHAR(255) DEFAULT '',
        title VARCHAR(512) DEFAULT '',
        status VARCHAR(20) DEFAULT 'pending',
        command TEXT DEFAULT '',
        output TEXT DEFAULT '',
        error_message TEXT DEFAULT '',
        file_count INTEGER DEFAULT 0,
        total_size BIGINT DEFAULT 0,
        bv_id VARCHAR(50) DEFAULT '',
        upload_files TEXT DEFAULT '[]',
        started_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_replay_upload_record ON replay_upload_records(replay_record_id, status)
    `);

    // v1.11.1：回放投稿接入合集链路，列名与语义与 upload_records 的 season_* 完全一致，
    // 供 SeasonService 按来源表复用同一套编排；同样只描述合集结果，不回写投稿 status
    await client.query(`
      ALTER TABLE replay_upload_records
        ADD COLUMN IF NOT EXISTS season_id BIGINT,
        ADD COLUMN IF NOT EXISTS season_status VARCHAR(16) NOT NULL DEFAULT 'none',
        ADD COLUMN IF NOT EXISTS season_error TEXT,
        ADD COLUMN IF NOT EXISTS season_attempts SMALLINT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS season_added_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS season_pending_since TIMESTAMP
    `);

    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'replay_upload_records_season_status_check') THEN
          ALTER TABLE replay_upload_records ADD CONSTRAINT replay_upload_records_season_status_check
            CHECK (season_status IN ('none', 'pending', 'added', 'failed', 'skipped'));
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_replay_upload_one_uploading
        ON replay_upload_records(replay_record_id)
        WHERE replay_record_id IS NOT NULL AND status = 'uploading'
    `);

    // ========== recording_files ==========

    await client.query(`
      CREATE TABLE IF NOT EXISTS recording_files (
        id            SERIAL PRIMARY KEY,
        session_id    INTEGER REFERENCES recording_sessions(id) ON DELETE SET NULL,
        room_url      VARCHAR(512) REFERENCES rooms(room_url) ON DELETE SET NULL,
        file_path     VARCHAR(1024) NOT NULL,
        file_name     VARCHAR(512) DEFAULT '',
        file_size     BIGINT DEFAULT 0,
        status        VARCHAR(20) DEFAULT 'pending',
        started_at    TIMESTAMP DEFAULT NOW(),
        completed_at  TIMESTAMP,
        checked_at    TIMESTAMP DEFAULT NOW(),
        created_at    TIMESTAMP DEFAULT NOW(),
        ended_at TIMESTAMP,
        segment_index INTEGER DEFAULT 0,
        duration_seconds INTEGER DEFAULT 0,
        is_hls_ready BOOLEAN DEFAULT FALSE,
        hls_playlist_path VARCHAR(1024) DEFAULT '',
        hls_generated_at TIMESTAMP,
        hls_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        hls_deleted_at TIMESTAMP,
        segment_start_ms INTEGER DEFAULT 0,
        segment_end_ms INTEGER DEFAULT 0
      )
    `);

    // HLS 生命周期字段：先以 nullable 方式添加，确保历史 ready 记录能正确回填。
    await client.query(`ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS hls_status VARCHAR(20)`);
    await client.query(`ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS hls_deleted_at TIMESTAMP`);
    await client.query(`
      UPDATE recording_files
      SET hls_status = CASE
        WHEN is_hls_ready = TRUE
          AND hls_playlist_path IS NOT NULL
          AND hls_playlist_path != '' THEN 'ready'
        ELSE 'pending'
      END
      WHERE hls_status IS NULL
    `);
    await client.query(`ALTER TABLE recording_files ALTER COLUMN hls_status SET DEFAULT 'pending'`);
    await client.query(`ALTER TABLE recording_files ALTER COLUMN hls_status SET NOT NULL`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_recording_files_hls_cleanup
        ON recording_files(hls_status, hls_generated_at)
    `);
    // recordings 表已废弃，数据已迁移至 recording_files，清理残留
    await client.query(`DROP TABLE IF EXISTS recordings`);

    // file_path 唯一约束由文末 v1.12.0 软删除迁移段接管（部分唯一索引，仅约束未删除行）

    // ========== v1.8.0：弹幕压制遗留结构清理 ==========
    // 弹幕压制已于 v1.7.0 迁出至 danmaku-tool，以下列/表不再被任何代码写入或读取。
    // 生产存量（2026-08-11 实测）：recording_files.danmaku_ass_path 101 行非空、
    // danmaku_capture_records.ass_path 64 行非空、danmaku_burn_records 4 行、
    // danmaku_free_burn_records 0 行。DROP 会丢弃这些历史记录，已获用户确认。
    // 回滚：结构需从 pg_dump 备份恢复（v1.8.3 起回滚脚本已移除，DROP 已稳定运行多版本）。
    await client.query(`ALTER TABLE recording_files DROP COLUMN IF EXISTS danmaku_ass_path`);

    // ========== settings ==========

    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        key VARCHAR(255) UNIQUE NOT NULL,
        value TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // ========== transcode_records ==========

    await client.query(`
      CREATE TABLE IF NOT EXISTS transcode_records (
        id SERIAL PRIMARY KEY,
        session_id INTEGER,
        original_path VARCHAR(1024) NOT NULL,
        transcoded_path VARCHAR(1024) DEFAULT '',
        status VARCHAR(20) DEFAULT 'queued',
        enqueued_at TIMESTAMP DEFAULT NOW(),
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // original_path 唯一约束由文末 v1.12.0 软删除迁移段接管（部分唯一索引，仅约束未删除行）

    // ========== 弹幕相关表 ==========

    await client.query(`
      CREATE TABLE IF NOT EXISTS danmaku_capture_records (
        id SERIAL PRIMARY KEY,
        session_id INTEGER,
        room_id INTEGER,
        platform VARCHAR(50) DEFAULT 'kuaishou',
        status VARCHAR(20) DEFAULT 'recording',
        raw_path VARCHAR(1024) DEFAULT '',
        event_count INTEGER DEFAULT 0,
        started_at TIMESTAMP DEFAULT NOW(),
        ended_at TIMESTAMP,
        error TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // v1.8.0：ass_path 列已废弃（ASS 生成迁至 danmaku-tool）
    await client.query(`ALTER TABLE danmaku_capture_records DROP COLUMN IF EXISTS ass_path`);
    // v1.9.0：orphan 记录需要 room_url 来匹配历史会话（session_id=NULL 时无法通过 JOIN 拿 room_url）
    await client.query(`ALTER TABLE danmaku_capture_records ADD COLUMN IF NOT EXISTS room_url VARCHAR(512) DEFAULT ''`);

    // v1.8.0：弹幕压制记录表已迁至 danmaku-tool，本服务不再维护
    await client.query(`DROP TABLE IF EXISTS danmaku_burn_records`);

    // ========== v1.13.0：AI 弹幕分析（全库首个 JSONB 表）==========
    await client.query(`
      CREATE TABLE IF NOT EXISTS danmaku_analysis_records (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        highlights JSONB DEFAULT '[]',
        summary TEXT,
        model VARCHAR(100),
        llm_ok BOOLEAN DEFAULT false,
        llm_error TEXT,
        threshold_mode VARCHAR(50),
        stats JSONB,
        report_path VARCHAR(1024),
        elapsed_s NUMERIC(8,1),
        error TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // ========== 弹幕 settings 清理 ==========
    // 清除 settings 表中已废弃的弹幕配置项（这些 key 已从前端设置页和默认值中移除）
    // 注意：danmaku_font_size / danmaku_opacity 等仍在使用的设置项不清理
    await client.query(`
      DELETE FROM settings WHERE key IN ('auto_burn_danmaku', 'prefer_danmaku_burned_video', 'danmaku_preserve_clean_video')
    `);

    // v1.8.3：清除已下线的投稿/录制死配置项（已从默认值和前端设置页移除，后端无任何读取方）
    await client.query(`
      DELETE FROM settings WHERE key IN ('submit_api', 'lines', 'threads', 'pool2_size', 'max_resume_retries')
    `);

    const defaultSettings = [
      ['pool_size', '3'],
      ['watchdog_interval', '30'],
      ['watchdog_timeout', '60'],
      ['filtering_threshold', '10'],
      ['delay', '60'],
      ['max_upload_limit', '99'],
      // v1.13.4：自动投稿冷静期（秒），与 delay 取较大值生效，防止短暂断流续播后提前投稿
      ['auto_upload_grace_seconds', '180'],
      ['auto_transcode', 'true'],
      ['transcode_delete_originals', 'true'],
      ['transcode_concurrency', '3'],
      ['auto_generate_hls', 'true'],
      ['hls_enabled', 'true'],
      ['hls_segment_duration', '10'],
      ['hls_cleanup_days', '30'],
      ['log_retention_days', '30'],
      ['kuaishou_danmaku_enabled', 'false'],
      // v1.13.0 AI 弹幕分析（api_key 不进 settings，只走环境变量 AI_ANALYSIS_API_KEY；
      // base_url 默认空 = LLM 层降级为纯统计，部署者在设置页填入自己的 OpenAI 兼容端点后生效）
      ['ai_analysis_enabled', 'false'],
      ['ai_analysis_auto_enabled', 'false'],
      ['ai_analysis_notify_enabled', 'true'],
      ['ai_analysis_base_url', ''],
      ['ai_analysis_model', 'deepseek-v4.1-flash'],
      // v1.9.0 孤儿弹幕兜底采集与回填
      ['orphan_tolerance_ms', '120000'],
      ['orphan_confidence_threshold', '0.8'],
      ['orphan_max_session_ms', '28800000'],
      ['orphan_dedup_scan_lines', '200'],
      ['replay_enabled', 'true'],
      ['replay_work_dir', '/data/replay'],
      ['replay_queue_concurrency', '1'],
      ['replay_cron_enabled', 'false'],
      ['replay_cron_expr', '0 3 * * *'],
      ['replay_auto_upload', 'false'],
      ['replay_max_count_per_run', '1'],
      ['file_cleanup_enabled', 'false'],
      ['file_cleanup_empty_dirs_enabled', 'false'],
      ['file_cleanup_retention_days', '30'],
      ['file_cleanup_categories', ''],
      ['file_cleanup_watermark_warn', '80'],
      ['file_cleanup_watermark_critical', '90'],
      ['file_cleanup_suggestion_notify', 'false'],
      ['webhook_enabled', 'false'],
      ['webhook_url', ''],
      ['feishu_webhook_enabled', 'false'],
      ['feishu_webhook_url', ''],
      ['gotify_enabled', 'false'],
      ['gotify_server', ''],
      ['gotify_token', ''],
      ['gotify_priority', '5'],
    ];
    for (const [key, value] of defaultSettings) {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING`,
        [key, value]
      );
    }

    // 投稿记录合并查询性能索引
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_upload_records_started_at
        ON upload_records(started_at DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_replay_upload_records_started_at
        ON replay_upload_records(started_at DESC);
    `);

    // v1.13.4：自动投稿资格扫描索引（看门狗每 30s 轮询，避免全表扫描）
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_recording_sessions_auto_upload
        ON recording_sessions(status, ended_at);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_recording_sessions_room_status
        ON recording_sessions(room_url, status);
    `);

    // v1.8.0：弹幕自由压制记录表已迁至 danmaku-tool，本服务不再维护
    await client.query(`DROP TABLE IF EXISTS danmaku_free_burn_records`);

    // ========== 文件管理模块表 ==========

    await client.query(`
      CREATE TABLE IF NOT EXISTS managed_files (
        id SERIAL PRIMARY KEY,
        category VARCHAR(20) NOT NULL DEFAULT 'unknown',
        file_type VARCHAR(30) NOT NULL DEFAULT 'unknown',
        source_table VARCHAR(50) NOT NULL DEFAULT 'unknown',
        source_id INTEGER,
        group_id VARCHAR(100),
        file_path VARCHAR(1024) NOT NULL,
        file_name VARCHAR(512) NOT NULL DEFAULT '',
        extension VARCHAR(20),
        file_size BIGINT,
        mtime TIMESTAMP,
        exists_on_disk BOOLEAN DEFAULT true,
        status VARCHAR(20) DEFAULT 'active',
        safe_to_delete BOOLEAN DEFAULT false,
        delete_block_reason VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        deleted_at TIMESTAMP
      )
    `);

    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'managed_files_file_path_key') THEN
          ALTER TABLE managed_files ADD CONSTRAINT managed_files_file_path_key UNIQUE (file_path);
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_managed_files_category_type_status
        ON managed_files(category, file_type, status);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_managed_files_safe_size
        ON managed_files(safe_to_delete, file_size DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_managed_files_mtime
        ON managed_files(mtime DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_managed_files_source
        ON managed_files(source_table, source_id);
    `);

    // managed_files 核心列 NOT NULL 约束（H5 修复）
    await client.query(`UPDATE managed_files SET category = 'unknown' WHERE category IS NULL`);
    await client.query(`UPDATE managed_files SET file_type = 'unknown' WHERE file_type IS NULL`);
    await client.query(`UPDATE managed_files SET source_table = 'unknown' WHERE source_table IS NULL`);
    await client.query(`UPDATE managed_files SET file_name = '' WHERE file_name IS NULL`);
    await client.query(`ALTER TABLE managed_files ALTER COLUMN category SET NOT NULL`);
    await client.query(`ALTER TABLE managed_files ALTER COLUMN file_type SET NOT NULL`);
    await client.query(`ALTER TABLE managed_files ALTER COLUMN source_table SET NOT NULL`);
    await client.query(`ALTER TABLE managed_files ALTER COLUMN file_name SET NOT NULL`);

    // managed_files.updated_at 自动更新触发器（M14 修复）
    await client.query(`
      CREATE OR REPLACE FUNCTION managed_files_set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_managed_files_updated_at ON managed_files`);
    await client.query(`
      CREATE TRIGGER trg_managed_files_updated_at
      BEFORE UPDATE ON managed_files
      FOR EACH ROW
      EXECUTE FUNCTION managed_files_set_updated_at()
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS file_delete_audit_logs (
        id SERIAL PRIMARY KEY,
        file_id INTEGER,
        file_path VARCHAR(1024),
        file_size BIGINT,
        category VARCHAR(20),
        source_table VARCHAR(50),
        source_id INTEGER,
        operator VARCHAR(100),
        deleted_by VARCHAR(20),
        action VARCHAR(20),
        result VARCHAR(20),
        estimated_release_size BIGINT,
        actual_release_size BIGINT,
        delete_reason VARCHAR(20),
        recording_file_id INTEGER,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`
      ALTER TABLE file_delete_audit_logs
        ADD COLUMN IF NOT EXISTS delete_reason VARCHAR(20),
        ADD COLUMN IF NOT EXISTS recording_file_id INTEGER
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_file_delete_audit_logs_file_id
        ON file_delete_audit_logs(file_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_file_delete_audit_logs_created_at
        ON file_delete_audit_logs(created_at DESC);
    `);

    // ========== v1.12.0：关键业务表软删除（deleted_at）==========
    // 删除语义从物理 DELETE 改为打标记，业务查询默认过滤 deleted_at IS NULL；
    // 唯一约束降级为部分唯一索引，软删记录不再占用唯一键，可重建同名/同路径记录。
    // 例外：rooms.room_url 因两张表的外键依赖必须保留全表唯一约束（见下方注释），
    // 「软删后重建」走复活语义。恢复方式：手动 UPDATE ... SET deleted_at = NULL（不提供恢复 UI）。
    // recording_sessions / managed_files 此前已是同一惯例，不重复迁移；
    // admin_users / settings / replay_settings / file_delete_audit_logs 为配置与审计表，不纳入。
    // recording_files 的 missing 批量清理保留物理删除（看门狗僵尸行，见删除端点说明）。

    const softDeleteTables = [
      'rooms',
      'upload_templates',
      'upload_records',
      'replay_upload_records',
      'replay_records',
      'transcode_records',
      'recording_files',
      'biliup_accounts',
      'danmaku_capture_records',
      'danmaku_analysis_records',
    ];
    for (const table of softDeleteTables) {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`);
    }

    // v1.13.0：一场次一活跃分析记录（软删后可重算插入新行，同 biliup_accounts 惯例）
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_danmaku_analysis_session_active
        ON danmaku_analysis_records(session_id) WHERE deleted_at IS NULL
    `);

    // 存量库归一化：DROP 旧全表唯一约束（新建库的 CREATE TABLE 已不含 inline UNIQUE）
    // ⚠️ rooms.room_url 例外：recording_sessions.room_url 与 recording_files.room_url 两个外键
    // 都引用它，PostgreSQL 要求外键引用列保持全表唯一约束，部分唯一索引不满足——
    // 故 rooms 保留 rooms_room_url_key，「软删后重建」走复活语义（清 deleted_at + 应用新配置），
    // 由 upsertRoom / POST /rooms / getOrCreateRoom 的 revive 分支实现。
    await client.query(`ALTER TABLE biliup_accounts DROP CONSTRAINT IF EXISTS biliup_accounts_name_key`);
    await client.query(`ALTER TABLE biliup_accounts DROP CONSTRAINT IF EXISTS biliup_accounts_cookies_path_key`);
    await client.query(`ALTER TABLE recording_files DROP CONSTRAINT IF EXISTS recording_files_file_path_key`);
    await client.query(`ALTER TABLE transcode_records DROP CONSTRAINT IF EXISTS transcode_records_original_path_key`);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_biliup_accounts_name_active
        ON biliup_accounts(name) WHERE deleted_at IS NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_biliup_accounts_cookies_path_active
        ON biliup_accounts(cookies_path) WHERE deleted_at IS NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_recording_files_file_path_active
        ON recording_files(file_path) WHERE deleted_at IS NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_transcode_records_original_path_active
        ON transcode_records(original_path) WHERE deleted_at IS NULL
    `);

    // replay_records(principal_id, replay_id)：追加 deleted_at IS NULL。
    // 注意：ON CONFLICT 推断要求子句谓词与索引谓词逐字一致，写入侧已同步。
    await client.query(`DROP INDEX IF EXISTS idx_replay_records_principal_replay_id`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_replay_records_principal_replay_id
        ON replay_records(principal_id, replay_id)
        WHERE replay_id IS NOT NULL AND replay_id <> '' AND deleted_at IS NULL
    `);

    // 「同一回放仅一条 uploading」：同样排除软删行，
    // 否则软删的 uploading 记录会永久阻断同回放再次投稿。
    await client.query(`DROP INDEX IF EXISTS idx_replay_upload_one_uploading`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_replay_upload_one_uploading
        ON replay_upload_records(replay_record_id)
        WHERE replay_record_id IS NOT NULL AND status = 'uploading' AND deleted_at IS NULL
    `);

    await client.query('COMMIT');
    console.log('[DB] 数据库迁移完成');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] 数据库迁移失败:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = migrate;
