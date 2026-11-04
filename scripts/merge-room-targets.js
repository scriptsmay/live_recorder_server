/**
 * 合并小红书「一次性直播间房间」到稳定个人主页目标（ADR-021）。
 *
 * 历史数据中，同一个主播可能同时存在：
 *   - 个人主页目标：https://www.xiaohongshu.com/user/profile/{user_id}
 *   - 单场直播间房间：https://www.xiaohongshu.com/livestream/{room_id}
 * 后者在规范化时可能已丢失 ?host_id=，无法自动反推主播。确认二者属于同一主播后，
 * 用本脚本把场次房间的会话/文件改挂到主页目标，再软删场次房间。
 *
 * 用法:
 *   node scripts/merge-room-targets.js <targetRoomId> <sourceRoomId> [sourceRoomId...] [--dry-run]
 *
 * 示例:
 *   NODE_ENV=development node scripts/merge-room-targets.js 26 25 --dry-run
 *   NODE_ENV=development node scripts/merge-room-targets.js 26 25
 *
 * 行为:
 *   1. 校验目标与来源房间存在、未软删、平台为 xiaohongshu；
 *   2. 将 recording_sessions / recording_files 的 room_url 改挂到目标；
 *   3. 同步 danmaku_capture_records.room_url（无外键）；
 *   4. 把来源房间的 live_room_id / live_url / host_user_id 合并到目标；
 *   5. 软删来源房间（不物理删除，不删除磁盘文件）；
 *   6. 清理双方 Redis 房间缓存。
 *
 * 注意：本脚本会修改数据库。先加 --dry-run 核对将要执行的操作。
 */

const env = process.env.NODE_ENV || 'development';
require('../server/config/env').initEnv({ mode: env });

const pool = require('../server/db/index');
const redis = require('../server/db/redis');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const ids = args.filter((a) => !a.startsWith('--')).map((a) => parseInt(a, 10));

  if (ids.length < 2 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    console.error('用法: node scripts/merge-room-targets.js <targetRoomId> <sourceRoomId...> [--dry-run]');
    process.exit(1);
  }

  const [targetId, ...sourceIds] = ids;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const targetRes = await client.query('SELECT * FROM rooms WHERE id = $1 AND deleted_at IS NULL', [targetId]);
    const target = targetRes.rows[0];
    if (!target) throw new Error(`目标房间 ${targetId} 不存在或已删除`);

    const sourceRes = await client.query(
      'SELECT * FROM rooms WHERE id = ANY($1::int[]) AND deleted_at IS NULL ORDER BY id',
      [sourceIds]
    );
    const sources = sourceRes.rows;
    if (sources.length !== sourceIds.length) {
      const found = new Set(sources.map((r) => r.id));
      const missing = sourceIds.filter((id) => !found.has(id));
      throw new Error(`来源房间不存在或已删除: ${missing.join(', ')}`);
    }

    if (target.polling_platform !== 'xiaohongshu') {
      throw new Error(`目标房间 ${target.id} 平台为 ${target.polling_platform || '未知'}，本脚本仅处理小红书`);
    }
    for (const room of sources) {
      if (room.polling_platform !== 'xiaohongshu') {
        throw new Error(`来源房间 ${room.id} 平台为 ${room.polling_platform || '未知'}，本脚本仅处理小红书`);
      }
      if (room.room_url === target.room_url) {
        throw new Error(`来源房间 ${room.id} 与目标 URL 相同，无需合并`);
      }
    }

    console.log(`\n${dryRun ? '[DRY-RUN] ' : ''}目标房间: ${target.id} ${target.room_url}`);
    console.log(`来源房间: ${sources.map((r) => `${r.id} ${r.room_url}`).join(' | ')}\n`);

    let mergedSessions = 0;
    let mergedFiles = 0;
    let mergedDanmaku = 0;

    for (const source of sources) {
      const sessionRes = await client.query(`UPDATE recording_sessions SET room_url = $1 WHERE room_url = $2`, [
        target.room_url,
        source.room_url,
      ]);
      const fileRes = await client.query(`UPDATE recording_files SET room_url = $1 WHERE room_url = $2`, [
        target.room_url,
        source.room_url,
      ]);
      const danmakuRes = await client.query(`UPDATE danmaku_capture_records SET room_url = $1 WHERE room_url = $2`, [
        target.room_url,
        source.room_url,
      ]);

      mergedSessions += sessionRes.rowCount || 0;
      mergedFiles += fileRes.rowCount || 0;
      mergedDanmaku += danmakuRes.rowCount || 0;

      // 来源若仍处于录制中，才把当前场次合并到目标；已结束的场次不得写成「进行中」。
      const sourceActive = ['recording', 'paused'].includes(source.status);
      const mergedHostUserId = target.host_user_id || source.host_user_id || '';
      const mergedLiveRoomId = sourceActive ? source.live_room_id || '' : '';
      const mergedLiveUrl = sourceActive ? source.live_url || source.room_url : '';

      await client.query(
        `UPDATE rooms
         SET host_user_id = $1,
             live_room_id = CASE WHEN $2 <> '' THEN $2 ELSE live_room_id END,
             live_url = CASE WHEN $3 <> '' THEN $3 ELSE live_url END,
             updated_at = NOW()
         WHERE id = $4`,
        [mergedHostUserId, mergedLiveRoomId, mergedLiveUrl, target.id]
      );
      target.host_user_id = mergedHostUserId;
      if (mergedLiveRoomId) target.live_room_id = mergedLiveRoomId;
      if (mergedLiveUrl) target.live_url = mergedLiveUrl;

      await client.query(`UPDATE rooms SET deleted_at = NOW(), status = 'idle', updated_at = NOW() WHERE id = $1`, [
        source.id,
      ]);

      console.log(
        `来源 ${source.id}: sessions=${sessionRes.rowCount || 0}, files=${fileRes.rowCount || 0}, danmaku=${danmakuRes.rowCount || 0} → 已软删`
      );
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log(`\n[DRY-RUN] 已回滚，未修改数据库。`);
    } else {
      await client.query('COMMIT');
      await redis.del(`room:${target.room_url}`).catch(() => {});
      for (const source of sources) {
        await redis.del(`room:${source.room_url}`).catch(() => {});
        await redis.del(`active_task:${source.room_url}`).catch(() => {});
      }
      console.log(`\n合并完成：sessions=${mergedSessions}, files=${mergedFiles}, danmaku=${mergedDanmaku}`);
      console.log(`目标房间 ${target.id} 已接管全部历史；来源房间已软删。`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n合并失败:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => {});
    // Redis 客户端可能维持长连接；CLI 脚本显式退出，避免命令一直悬挂。
    process.exit(process.exitCode || 0);
  }
}

main();
