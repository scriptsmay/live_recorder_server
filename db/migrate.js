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
