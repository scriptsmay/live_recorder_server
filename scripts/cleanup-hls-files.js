async function cleanupHLSFiles(env = 'development') {
  require('../config/env').initEnv({ mode: env });
  const pool = require('../db/index');
  try {
    console.log('Note: recordings table is deprecated, checking recording_files only');

    const { rows: rf } = await pool.query(
      'SELECT id, file_path FROM recording_files WHERE file_path LIKE $1 OR file_path LIKE $2',
      ['%/hls/%', '%/hls_%/%']
    );
    console.log('Found', rf.length, 'HLS files in recording_files table:');
    rf.forEach((r) => console.log('  -', r.file_path));

    if (rf.length > 0) {
      await pool.query('DELETE FROM recording_files WHERE file_path LIKE $1 OR file_path LIKE $2', [
        '%/hls/%',
        '%/hls_%/%',
      ]);
      console.log('Deleted', rf.length, 'records from recording_files table');
    }

    console.log('Cleanup completed!');
  } finally {
    await pool.end();
  }
}

cleanupHLSFiles().catch(console.error);
