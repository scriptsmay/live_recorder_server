const fs = require('fs');
const path = require('path');
const pool = require('../db/index');
const redis = require('../db/redis');
const DataService = require('./DataService');
const { scanRecordingFiles } = require('../lib/core/scan-files');
const { normalizeRoomUrl } = require('../lib/utils/room-url');

class RoomService {
  static async getRoomByUrl(roomUrl) {
    return DataService.getRoomByUrl(normalizeRoomUrl(roomUrl));
  }

  static async upsertRoom(roomUrl, roomName) {
    roomUrl = normalizeRoomUrl(roomUrl);
    // v1.12.0：rooms.room_url 有外键依赖，保留全表唯一约束——软删行仍占用 URL。
    // 重新添加同名房间走复活语义：清 deleted_at 并应用新配置（保持房间 id 连续）。
    const exist = await pool.query('SELECT * FROM rooms WHERE room_url = $1', [roomUrl]);
    if (exist.rows.length > 0) {
      const room = exist.rows[0];
      if (room.deleted_at != null) {
        await pool.query('UPDATE rooms SET deleted_at = NULL, updated_at = NOW() WHERE id = $1', [room.id]);
        // 复活后清房间缓存，避免 TTL 内继续拿到软删前的旧配置
        await redis.del(`room:${roomUrl}`).catch(() => {});
        room.deleted_at = null;
      }
      if (roomName && room.room_name !== roomName) {
        await pool.query('UPDATE rooms SET room_name = $1, updated_at = NOW() WHERE id = $2', [roomName, room.id]);
        room.room_name = roomName;
      }
      return room;
    }
    const result = await pool.query(`INSERT INTO rooms (room_url, room_name) VALUES ($1, $2) RETURNING *`, [
      roomUrl,
      roomName || '',
    ]);
    return result.rows[0];
  }

  static async getOrCreate(roomUrl, roomName) {
    return this.upsertRoom(roomUrl, roomName);
  }

  static async pauseRecording(roomUrl) {
    const room = await this.getRoomByUrl(roomUrl);
    if (!room) {
      return { success: false, message: '直播间不存在' };
    }

    if (room.status === 'idle') {
      return { success: false, message: '直播间未在录制' };
    }

    if (room.ffmpeg_pid) {
      try {
        process.kill(room.ffmpeg_pid, 'SIGSTOP');
        await pool.query(`UPDATE rooms SET status = 'paused', updated_at = NOW() WHERE id = $1`, [room.id]);
        return { success: true, message: '录制已暂停' };
      } catch (err) {
        return { success: false, message: `暂停失败: ${err.message}` };
      }
    }

    await pool.query(`UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`, [
      room.id,
    ]);
    return { success: false, message: 'PID 不存在，状态已重置' };
  }

  static async resumeRecording(roomUrl) {
    const room = await this.getRoomByUrl(roomUrl);
    if (!room) {
      return { success: false, message: '直播间不存在' };
    }

    if (room.status !== 'paused') {
      return { success: false, message: '直播间未在暂停状态' };
    }

    if (room.ffmpeg_pid) {
      try {
        process.kill(room.ffmpeg_pid, 'SIGCONT');
        await pool.query(`UPDATE rooms SET status = 'recording', updated_at = NOW() WHERE id = $1`, [room.id]);
        return { success: true, message: '录制已恢复' };
      } catch (err) {
        return { success: false, message: `恢复失败: ${err.message}` };
      }
    }

    await pool.query(`UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`, [
      room.id,
    ]);
    return { success: false, message: 'PID 不存在，状态已重置' };
  }

  static async stopRecording(roomUrl, force = false) {
    const room = await this.getRoomByUrl(roomUrl);
    if (!room) {
      return { success: false, message: '直播间不存在' };
    }

    if (room.status === 'idle') {
      return { success: false, message: '直播间未在录制' };
    }

    if (room.ffmpeg_pid) {
      try {
        process.kill(room.ffmpeg_pid, 'SIGTERM');
      } catch (err) {
        console.log(`[停止] SIGTERM 失败 (PID=${room.ffmpeg_pid}):`, err.message);
      }
    }

    await pool.query(`UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`, [
      room.id,
    ]);
    await redis.del(`active_task:${roomUrl}`).catch(() => {});

    if (force && room.output_path) {
      try {
        await this.cleanupOutputFiles(room, force);
      } catch (err) {
        console.error(`[停止] 清理文件失败:`, err.message);
      }
    }

    setTimeout(() => {
      scanRecordingFiles(true).catch((err) => {
        console.error('[停止] 扫描文件失败:', err.message);
      });
    }, 2000);

    return { success: true, message: '录制已停止' };
  }

  static async cleanupOutputFiles(room, force = false) {
    const DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR;
    if (!room.output_path || !DOWNLOAD_DIR) return;

    const outDir = path.dirname(room.output_path);
    const baseName = path.basename(room.output_path);
    const ext = path.extname(baseName);
    const nameWithoutExt = baseName.replace(/\.[^.]+$/, '');

    let candidates = [];
    try {
      const files = fs.readdirSync(outDir);
      candidates = files
        .filter((f) => {
          if (!/\.(flv|mp4|ts)$/i.test(f)) return false;
          const prefix = nameWithoutExt.replace(/%[YmdHMS]/g, '.*');
          const regex = new RegExp('^' + prefix.replace(/\*/g, '.*') + '.*' + ext.replace(/\./g, '\\.') + '$');
          return regex.test(f);
        })
        .map((f) => path.join(outDir, f));
    } catch (_) {}

    for (const fp of candidates) {
      try {
        const stat = fs.statSync(fp);
        if (stat.size < 1024 * 1024 || force) {
          fs.unlinkSync(fp);
          // v1.12.0：仅更新未删除行——软删行与重建行可能同路径，避免误改新行状态
          await pool.query(
            'UPDATE recording_files SET status = $1, file_size = 0 WHERE file_path = $2 AND deleted_at IS NULL',
            [force ? 'deleted' : 'completed', fp]
          );
          console.log(`[清理] 已删除小文件: ${fp}`);
        }
      } catch (_) {}
    }
  }

  static async deleteRoom(roomId) {
    // v1.12.0：软删除。初查同样过滤软删行——二次删除返回不存在，
    // 避免拿着已软删房间残留的 ffmpeg_pid 去 kill 可能已被复用的 PID。
    const room = await pool.query('SELECT * FROM rooms WHERE id = $1 AND deleted_at IS NULL', [roomId]);
    if (room.rows.length === 0) {
      return { success: false, message: '直播间不存在' };
    }

    const r = room.rows[0];
    if (r.ffmpeg_pid) {
      try {
        process.kill(r.ffmpeg_pid, 'SIGTERM');
      } catch (_) {}
    }

    await pool.query('UPDATE rooms SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1', [roomId]);
    // 连带会话一并软删（原物理删除 + FK CASCADE 的行为等价替换）
    await pool.query('UPDATE recording_sessions SET deleted_at = NOW() WHERE room_url = $1 AND deleted_at IS NULL', [
      r.room_url,
    ]);
    // v1.12.0：房间缓存与活跃任务键一并失效——否则 TTL 内 getOrCreateRoom
    // 会拿到缓存的旧房间对象继续录制（软删前行不存在会撞 FK，软删后行仍在会静默复用）
    await redis.del(`room:${r.room_url}`).catch(() => {});
    await redis.del(`active_task:${r.room_url}`).catch(() => {});

    return { success: true, message: '直播间已删除' };
  }
}

module.exports = RoomService;
