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
    const exist = await pool.query('SELECT * FROM rooms WHERE room_url = $1', [roomUrl]);
    if (exist.rows.length > 0) {
      const room = exist.rows[0];
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
          await pool.query('UPDATE recording_files SET status = $1, file_size = 0 WHERE file_path = $2', [
            force ? 'deleted' : 'completed',
            fp,
          ]);
          console.log(`[清理] 已删除小文件: ${fp}`);
        }
      } catch (_) {}
    }
  }

  static async deleteRoom(roomId) {
    const room = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (room.rows.length === 0) {
      return { success: false, message: '直播间不存在' };
    }

    const r = room.rows[0];
    if (r.ffmpeg_pid) {
      try {
        process.kill(r.ffmpeg_pid, 'SIGTERM');
      } catch (_) {}
    }

    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    await pool.query('DELETE FROM recording_sessions WHERE room_url = $1', [r.room_url]);
    await redis.del(`active_task:${r.room_url}`).catch(() => {});

    return { success: true, message: '直播间已删除' };
  }
}

module.exports = RoomService;
