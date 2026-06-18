require('../server/config/env').initEnv({ mode: 'development' });
const pool = require('../server/db/index');

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
        DELETE FROM replay_upload_records
        WHERE replay_record_id IN (
          SELECT id FROM replay_records
          WHERE principal_id = '3xhpa8nk4a7xdg6'
        )
      `);

    const result = await client.query(`
        DELETE FROM replay_records
        WHERE principal_id = '3xhpa8nk4a7xdg6'
        RETURNING id, replay_id, status
      `);

    await client.query('COMMIT');
    console.log(`deleted replay_records: ${result.rowCount}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
