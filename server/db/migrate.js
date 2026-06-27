const pool = require('./index');
const ensureDatabase = require('./ensure-database');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

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
      if (err.code === '40P01' && attempt < MAX_RETRIES) {
        console.warn(`[DB] 死锁检测 (${attempt}/${MAX_RETRIES}), ${RETRY_DELAY_MS}ms 后重试...`);
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
        segment_start_ms INTEGER DEFAULT 0,
        segment_end_ms INTEGER DEFAULT 0,
        danmaku_ass_path VARCHAR(1024) DEFAULT ''
      )
    `);
    // recordings 表已废弃，数据已迁移至 recording_files，清理残留
    await client.query(`DROP TABLE IF EXISTS recordings`);

    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recording_files_file_path_key') THEN
          ALTER TABLE recording_files ADD CONSTRAINT recording_files_file_path_key UNIQUE (file_path);
        END IF;
      END $$;
    `);

    // danmaku_ass_path 已迁移到弹幕文件系统的确定性路径，不再写入 recording_files
    // 保留列以兼容历史数据及 watchdog/RecorderService 中的引用，DROP 推迟到发布后 1 个月（见下方 deferred migration）

    // ========== 推迟执行：recording_files 弹幕字段 DROP ==========
    // 以下 migration 推迟到发布后至少 1 个月执行，确保无回滚需求后再取消注释
    // -- await client.query(`ALTER TABLE recording_files DROP COLUMN IF EXISTS danmaku_ass_path`);
    // -- 回滚 SQL（如需要，手动执行）：
    // -- ALTER TABLE recording_files ADD COLUMN danmaku_ass_path VARCHAR(1024) DEFAULT '';

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

    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transcode_records_original_path_key') THEN
          ALTER TABLE transcode_records ADD CONSTRAINT transcode_records_original_path_key UNIQUE (original_path);
        END IF;
      END $$;
    `);

    // ========== 弹幕相关表 ==========

    await client.query(`
      CREATE TABLE IF NOT EXISTS danmaku_capture_records (
        id SERIAL PRIMARY KEY,
        session_id INTEGER,
        room_id INTEGER,
        platform VARCHAR(50) DEFAULT 'kuaishou',
        status VARCHAR(20) DEFAULT 'recording',
        raw_path VARCHAR(1024) DEFAULT '',
        ass_path VARCHAR(1024) DEFAULT '',
        event_count INTEGER DEFAULT 0,
        started_at TIMESTAMP DEFAULT NOW(),
        ended_at TIMESTAMP,
        error TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // TODO: drop in v1.8.0 (danmaku burn moved to danmaku-tool)
    await client.query(`
      CREATE TABLE IF NOT EXISTS danmaku_burn_records (
        id SERIAL PRIMARY KEY,
        session_id INTEGER,
        recording_file_id INTEGER UNIQUE,
        segment_index INTEGER DEFAULT 0,
        segment_start_ms INTEGER DEFAULT 0,
        segment_end_ms INTEGER DEFAULT 0,
        input_path VARCHAR(1024) NOT NULL,
        ass_path VARCHAR(1024) NOT NULL,
        output_path VARCHAR(1024) DEFAULT '',
        status VARCHAR(20) DEFAULT 'queued',
        error TEXT DEFAULT '',
        log_path VARCHAR(1024) DEFAULT '',
        enqueued_at TIMESTAMP DEFAULT NOW(),
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        session_ass_path VARCHAR(1024) DEFAULT '',
        jsonl_path VARCHAR(1024) DEFAULT ''
      )
    `);

    // ========== 弹幕 settings 清理 ==========
    // 清除 settings 表中已废弃的弹幕配置项（这些 key 已从前端设置页和默认值中移除）
    // 注意：danmaku_font_size / danmaku_opacity 等仍在使用的设置项不清理
    await client.query(`
      DELETE FROM settings WHERE key IN ('auto_burn_danmaku', 'prefer_danmaku_burned_video', 'danmaku_preserve_clean_video')
    `);

    const defaultSettings = [
      ['pool_size', '3'],
      ['watchdog_interval', '30'],
      ['watchdog_timeout', '60'],
      ['filtering_threshold', '10'],
      ['delay', '60'],
      ['submit_api', ''],
      ['lines', ''],
      ['threads', '3'],
      ['pool2_size', '3'],
      ['max_upload_limit', '99'],
      ['max_resume_retries', '3'],
      ['auto_transcode', 'true'],
      ['transcode_delete_originals', 'true'],
      ['transcode_concurrency', '3'],
      ['auto_generate_hls', 'true'],
      ['hls_enabled', 'true'],
      ['hls_segment_duration', '10'],
      ['hls_cleanup_days', '30'],
      ['log_retention_days', '30'],
      ['kuaishou_danmaku_enabled', 'false'],
      ['replay_enabled', 'true'],
      ['replay_work_dir', '/data/replay'],
      ['replay_queue_concurrency', '1'],
      ['replay_cron_enabled', 'false'],
      ['replay_cron_expr', '0 3 * * *'],
      ['replay_auto_upload', 'false'],
      ['replay_max_count_per_run', '1'],
      ['file_cleanup_enabled', 'false'],
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

    // TODO: drop in v1.8.0 (free burn moved to independent tool)
    // 弹幕自由压制记录表
    await client.query(`
      CREATE TABLE IF NOT EXISTS danmaku_free_burn_records (
        id SERIAL PRIMARY KEY,
        source_type VARCHAR(20) NOT NULL,
        source_id INTEGER NOT NULL,
        danmaku_session_id INTEGER NOT NULL,
        video_path VARCHAR(1024) NOT NULL,
        jsonl_path VARCHAR(1024) NOT NULL,
        offset_ms INTEGER DEFAULT 0,
        manual_adjust_ms INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'pending',
        output_path VARCHAR(1024) DEFAULT '',
        error_message TEXT DEFAULT '',
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        log_path VARCHAR(1024) DEFAULT ''
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_free_burn_status ON danmaku_free_burn_records(status);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_free_burn_created ON danmaku_free_burn_records(created_at DESC);
    `);

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
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_file_delete_audit_logs_file_id
        ON file_delete_audit_logs(file_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_file_delete_audit_logs_created_at
        ON file_delete_audit_logs(created_at DESC);
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
