const pool = require('./index');

async function migrate() {
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
