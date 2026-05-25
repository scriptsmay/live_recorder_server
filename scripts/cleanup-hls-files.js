require('../config/env').initEnv({ mode: 'development' });
const pool = require('../db/index');

async function cleanupHLSFiles() {
  try {
    const { rows: recordings } = await pool.query(
      'SELECT id, file_path FROM recordings WHERE file_path LIKE $1 OR file_path LIKE $2',
      ['%/hls/%', '%/hls_%/%']
    );
    console.log('Found', recordings.length, 'HLS files in recordings table:');
    recordings.forEach(r => console.log('  -', r.file_path));

    if (recordings.length > 0) {
      await pool.query('DELETE FROM recordings WHERE file_path LIKE $1 OR file_path LIKE $2', ['%/hls/%', '%/hls_%/%']);
      console.log('Deleted', recordings.length, 'records from recordings table');
    }

    const { rows: rf } = await pool.query(
      'SELECT id, file_path FROM recording_files WHERE file_path LIKE $1 OR file_path LIKE $2',
      ['%/hls/%', '%/hls_%/%']
    );
    console.log('Found', rf.length, 'HLS files in recording_files table:');
    rf.forEach(r => console.log('  -', r.file_path));

    if (rf.length > 0) {
      await pool.query('DELETE FROM recording_files WHERE file_path LIKE $1 OR file_path LIKE $2', ['%/hls/%', '%/hls_%/%']);
      console.log('Deleted', rf.length, 'records from recording_files table');
    }

    console.log('Cleanup completed!');
  } finally {
    await pool.end();
  }
}

cleanupHLSFiles().catch(console.error);
