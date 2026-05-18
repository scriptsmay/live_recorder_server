const pool = require('../../db/index');
const HuyaChecker = require('./HuyaChecker');

const CHECKERS = {
  huya: HuyaChecker,
};

class PollingManager {
  constructor() {
    this.timers = new Map();
    this.isRunning = false;
  }

  getChecker(platform) {
    const CheckerClass = CHECKERS[platform?.toLowerCase()];
    if (!CheckerClass) {
      console.warn(`[PollingManager] 不支持的平台: ${platform}`);
      return null;
    }
    return CheckerClass;
  }

  async loadPollingRooms() {
    try {
      const result = await pool.query(`
        SELECT id, room_url, room_name, polling_enabled, polling_platform,
               polling_interval, last_polled_at, last_live_status
        FROM rooms
        WHERE polling_enabled = true AND monitoring_enabled = true
      `);
      return result.rows;
    } catch (err) {
      console.error('[PollingManager] 加载轮询房间失败:', err.message);
      return [];
    }
  }

  async checkRoom(room) {
    const { id, room_url, polling_platform } = room;
    const CheckerClass = this.getChecker(polling_platform);

    if (!CheckerClass) {
      return;
    }

    const checker = new CheckerClass(room_url);

    try {
      const result = await checker.checkStatus();
      const now = new Date();

      const wasLive = room.last_live_status;
      const isLive = result.isLive;

      if (isLive && !wasLive) {
        console.log(`[PollingManager] 🟢 开播检测: ${room.room_name || room_url}`);
      } else if (!isLive && wasLive) {
        console.log(`[PollingManager] 🔴 下播检测: ${room.room_name || room_url}`);
      }

      await pool.query(
        `
        UPDATE rooms
        SET last_polled_at = $1,
            last_live_status = $2,
            room_name = COALESCE(NULLIF($3, ''), room_name)
        WHERE id = $4
      `,
        [now, isLive, result.roomName || null, id]
      );
    } catch (err) {
      console.error(`[PollingManager] 检查房间失败 (${room_url}):`, err.message);
    }
  }

  async pollRoom(room) {
    const jitter = Math.floor(Math.random() * 5000);
    await new Promise((resolve) => setTimeout(resolve, jitter));

    await this.checkRoom(room);
  }

  async startRoomPolling(room) {
    const roomKey = `room:${room.id}`;

    if (this.timers.has(roomKey)) {
      clearInterval(this.timers.get(roomKey));
    }

    await this.pollRoom(room);

    const intervalMs = (room.polling_interval || 60) * 1000;
    const timer = setInterval(() => {
      this.pollRoom(room).catch((err) => {
        console.error(`[PollingManager] 轮询异常 (${room.room_url}):`, err.message);
      });
    }, intervalMs);

    this.timers.set(roomKey, timer);
    console.log(`[PollingManager] 已启动轮询: ${room.room_name || room.room_url} (${room.polling_interval}s)`);
  }

  async stopRoomPolling(roomId) {
    const roomKey = `room:${roomId}`;
    if (this.timers.has(roomKey)) {
      clearInterval(this.timers.get(roomKey));
      this.timers.delete(roomKey);
      console.log(`[PollingManager] 已停止轮询: roomId=${roomId}`);
    }
  }

  async start() {
    if (this.isRunning) {
      console.log('[PollingManager] 已启动，跳过');
      return;
    }

    this.isRunning = true;
    console.log('[PollingManager] 启动中...');

    const rooms = await this.loadPollingRooms();
    console.log(`[PollingManager] 加载到 ${rooms.length} 个轮询房间`);

    for (const room of rooms) {
      await this.startRoomPolling(room);
    }

    console.log('[PollingManager] 启动完成');
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    console.log('[PollingManager] 停止中...');

    for (const [, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.isRunning = false;

    console.log('[PollingManager] 已停止');
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async reloadRoom(roomId) {
    const result = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (result.rows.length === 0) {
      await this.stopRoomPolling(roomId);
      return;
    }

    const room = result.rows[0];

    if (room.polling_enabled) {
      await this.startRoomPolling(room);
    } else {
      await this.stopRoomPolling(roomId);
    }
  }
}

const pollingManager = new PollingManager();

module.exports = pollingManager;
