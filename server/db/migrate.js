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
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS recordings (
        id SERIAL PRIMARY KEY,
        room_url VARCHAR(512) REFERENCES rooms(room_url) ON DELETE CASCADE,
        file_path VARCHAR(1024) DEFAULT '',
        file_size BIGINT DEFAULT 0,
        duration_seconds INTEGER DEFAULT 0,
        started_at TIMESTAMP DEFAULT NOW(),
        ended_at TIMESTAMP,
        status VARCHAR(20) DEFAULT 'recording'
      )
    `);

    await client.query(`
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS segment_duration INTEGER DEFAULT 0
    `);

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
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      ALTER TABLE recordings ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES recording_sessions(id) ON DELETE SET NULL
    `);

    await client.query(`
      ALTER TABLE recordings ADD COLUMN IF NOT EXISTS segment_index INTEGER DEFAULT 0
    `);

    await client.query(`
      ALTER TABLE recordings ADD COLUMN IF NOT EXISTS is_hls_ready BOOLEAN DEFAULT FALSE
    `);
    await client.query(`
      ALTER TABLE recordings ADD COLUMN IF NOT EXISTS hls_playlist_path VARCHAR(1024) DEFAULT ''
    `);
    await client.query(`
      ALTER TABLE recordings ADD COLUMN IF NOT EXISTS hls_generated_at TIMESTAMP
    `);

    await client.query(`
      ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS caption VARCHAR(1024) DEFAULT ''
    `);

    await client.query(`
      ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP
    `);

    await client.query(`
      ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0
    `);

    await client.query(`
      ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS stream_url VARCHAR(1024) DEFAULT ''
    `);

    await client.query(`
      ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS output_path VARCHAR(1024) DEFAULT ''
    `);

    await client.query(`
      ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS cover_url VARCHAR(1024) DEFAULT ''
    `);

    await client.query(`
      ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS cover_path VARCHAR(1024) DEFAULT ''
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS upload_templates (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL DEFAULT '',
        room_url VARCHAR(512) REFERENCES rooms(room_url) ON DELETE SET NULL,
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
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`ALTER TABLE upload_templates DROP COLUMN IF EXISTS line`);
    await client.query(`ALTER TABLE upload_templates ADD COLUMN IF NOT EXISTS is_only_self INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE upload_templates ADD COLUMN IF NOT EXISTS cookies_path VARCHAR(1024) DEFAULT ''`);
    await client.query(`ALTER TABLE upload_templates ADD COLUMN IF NOT EXISTS dtime INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE upload_templates ADD COLUMN IF NOT EXISTS after_upload VARCHAR(20) DEFAULT 'none'`);

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
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE upload_records ADD COLUMN IF NOT EXISTS bv_id VARCHAR(50) DEFAULT ''`);
    await client.query(`ALTER TABLE upload_records ADD COLUMN IF NOT EXISTS upload_files TEXT DEFAULT '[]'`);

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

    await client.query(`ALTER TABLE replay_records ADD COLUMN IF NOT EXISTS poster TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE replay_records ADD COLUMN IF NOT EXISTS resolution VARCHAR(50) DEFAULT ''`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS replay_settings (
        key VARCHAR(255) NOT NULL,
        principal_id VARCHAR(128) NOT NULL DEFAULT '',
        value TEXT DEFAULT '',
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (key, principal_id)
      )
    `);

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
        created_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    // 添加唯一约束防止 recording_files / recordings 重复
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recording_files_file_path_key') THEN
          ALTER TABLE recording_files ADD CONSTRAINT recording_files_file_path_key UNIQUE (file_path);
        END IF;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recordings_file_path_key') THEN
          ALTER TABLE recordings ADD CONSTRAINT recordings_file_path_key UNIQUE (file_path);
        END IF;
      END $$;
    `);

    await client.query(`
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS notification_enabled BOOLEAN DEFAULT TRUE
    `);

    await client.query(`
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS monitoring_enabled BOOLEAN DEFAULT TRUE
    `);

    await client.query(`
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS upload_template_id INTEGER REFERENCES upload_templates(id) ON DELETE SET NULL
    `);

    await client.query(`
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS polling_enabled BOOLEAN DEFAULT FALSE
    `);

    await client.query(`
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS polling_platform VARCHAR(50) DEFAULT NULL
    `);

    await client.query(`
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS polling_interval INTEGER DEFAULT 60
    `);

    // 移除不再使用的字段
    await client.query(`ALTER TABLE rooms DROP COLUMN IF EXISTS last_polled_at`);
    await client.query(`ALTER TABLE rooms DROP COLUMN IF EXISTS last_live_status`);

    await client.query(`
      ALTER TABLE upload_templates DROP COLUMN IF EXISTS room_url
    `);

    await client.query(`
      ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS is_hls_ready BOOLEAN DEFAULT FALSE
    `);
    await client.query(`
      ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS hls_playlist_path VARCHAR(1024) DEFAULT ''
    `);
    await client.query(`
      ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS hls_generated_at TIMESTAMP
    `);

    // 添加 recordings 表缺少的字段到 recording_files 表
    await client.query(`
      ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP
    `);
    await client.query(`
      ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS segment_index INTEGER DEFAULT 0
    `);
    await client.query(`
      ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS duration_seconds INTEGER DEFAULT 0
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        key VARCHAR(255) UNIQUE NOT NULL,
        value TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

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
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // recording_files 弹幕相关字段
    await client.query(`
      ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS segment_start_ms INTEGER DEFAULT 0
    `);
    await client.query(`
      ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS segment_end_ms INTEGER DEFAULT 0
    `);
    // danmaku_ass_path 已迁移到弹幕文件系统的确定性路径，不再写入 recording_files
    // 保留列以兼容历史数据及 watchdog/RecorderService 中的引用，DROP 推迟到发布后 1 个月（见下方 deferred migration）
    await client.query(`
      ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS danmaku_ass_path VARCHAR(1024) DEFAULT ''
    `);

    await client.query(`
      ALTER TABLE danmaku_burn_records ADD COLUMN IF NOT EXISTS log_path VARCHAR(1024) DEFAULT ''
    `);

    // danmaku_burn_records 新增字段：会话级 ASS 路径和 JSONL 路径
    await client.query(`
      ALTER TABLE danmaku_burn_records ADD COLUMN IF NOT EXISTS session_ass_path VARCHAR(1024) DEFAULT ''
    `);
    await client.query(`
      ALTER TABLE danmaku_burn_records ADD COLUMN IF NOT EXISTS jsonl_path VARCHAR(1024) DEFAULT ''
    `);

    // ========== 弹幕 settings 清理 ==========
    // 清除 settings 表中已废弃的弹幕配置项（这些 key 已从前端设置页和默认值中移除）
    // 注意：danmaku_font_size / danmaku_opacity 等仍在使用的设置项不清理
    await client.query(`
      DELETE FROM settings WHERE key IN ('auto_burn_danmaku', 'prefer_danmaku_burned_video', 'danmaku_preserve_clean_video')
    `);

    // ========== 推迟执行：recording_files 弹幕字段 DROP ==========
    // 以下 migration 推迟到发布后至少 1 个月执行，确保无回滚需求后再取消注释
    // -- await client.query(`ALTER TABLE recording_files DROP COLUMN IF EXISTS danmaku_ass_path`);
    // -- 回滚 SQL（如需要，手动执行）：
    // -- ALTER TABLE recording_files ADD COLUMN danmaku_ass_path VARCHAR(1024) DEFAULT '';

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
      ['danmaku_burn_concurrency', '1'],
      ['danmaku_density_per_second', '20'],
      ['danmaku_font_family', 'Noto Sans CJK SC'],
      ['danmaku_font_size', '32'],
      ['danmaku_opacity', '1.0'],
      ['danmaku_outline_colour', '000000'],
      ['danmaku_outline_width', '2'],
      ['replay_enabled', 'true'],
      ['replay_work_dir', '/data/replay'],
      ['replay_queue_concurrency', '1'],
      ['replay_cron_enabled', 'false'],
      ['replay_cron_expr', '0 3 * * *'],
      ['replay_auto_upload', 'false'],
      ['replay_max_count_per_run', '1'],
    ];
    for (const [key, value] of defaultSettings) {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING`,
        [key, value]
      );
    }

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
