const pool = require('../../../db/index');
const redis = require('../../../db/redis');
const HuyaChecker = require('./HuyaChecker');
const RecorderService = require('../../../services/RecorderService');
const notify = require('../notify');
const { detectPlatform } = require('../../../lib/utils/platform-detector');

const CHECKERS = {
  huya: HuyaChecker,
};

class PollingManager {
  constructor() {
    this.timers = new Map();
    this.isRunning = false;
    this.roomLiveStatus = new Map();
  }

  getChecker(platform) {
    const CheckerClass = CHECKERS[platform?.toLowerCase()];
    if (!CheckerClass) {
      console.warn(`[PollingManager] 不支持的平台: ${platform}`);
      return null;
    }
    return CheckerClass;
  }

  async _extractStreamUrl(room_url, checkResult) {
    if (checkResult.streamUrl) {
      return checkResult.streamUrl;
    }

    if (checkResult.streamInfo) {
      const detectedPlatform = detectPlatform(room_url);
      if (detectedPlatform === 'huya') {
        const huyaChecker = new HuyaChecker(room_url);
        return huyaChecker.buildStreamUrlFromStreamInfo(checkResult.streamInfo, { useAntiCodeSign: false });
      }
    }

    return null;
  }

  async loadPollingRooms() {
    try {
      const result = await pool.query(`
        SELECT id, room_url, room_name, polling_enabled, polling_platform,
               polling_interval, monitoring_enabled, notification_enabled, status
        FROM rooms
        WHERE polling_enabled = true
      `);
      for (const room of result.rows) {
        try {
          const cached = await redis.get(`polling:live_status:${room.id}`);
          if (cached) {
            const parsed = JSON.parse(cached);
            this.roomLiveStatus.set(room.id, parsed.isLive || false);
          }
        } catch (_) {}
      }
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

      const wasLive = this.roomLiveStatus.get(id) || false;
      const isLive = result.isLive;

      console.log(
        `[PollingManager] 状态检查: ${room.room_name || room_url} wasLive=${wasLive} isLive=${isLive} roomStatus=${room.status}`
      );

      // 开播条件：isLive=true 且 (wasLive=false 或 当前不在录制中)
      const shouldStartRecording = isLive && (!wasLive || room.status !== 'recording');

      if (shouldStartRecording) {
        console.log(`[PollingManager] 🟢 开播检测: ${room.room_name || room_url}`);

        if (room.notification_enabled !== false) {
          notify.liveStart(room.room_name || room_url, room_url).catch((err) => {
            console.error('[PollingManager] 开播通知失败:', err.message);
          });
        }
      } else if (!isLive && wasLive) {
        console.log(`[PollingManager] 🔴 下播检测: ${room.room_name || room_url}`);

        if (room.notification_enabled !== false) {
          notify.liveEnd(room.room_name || room_url, room_url).catch((err) => {
            console.error('[PollingManager] 下播通知失败:', err.message);
          });
        }
      }

      if (!room.room_name && result.roomName) {
        await pool.query(`UPDATE rooms SET room_name = $1 WHERE id = $2`, [result.roomName, id]);
        room.room_name = result.roomName;
      }

      const statusTtl = (room.polling_interval || 60) * 2;
      await redis
        .setEx(
          `polling:live_status:${id}`,
          statusTtl,
          JSON.stringify({
            isLive,
            lastPolledAt: now.toISOString(),
          })
        )
        .catch(() => {});

      this.roomLiveStatus.set(id, isLive);

      // 启动录制前，先查询最新的房间状态
      const freshRoom = await pool.query('SELECT status, ffmpeg_pid FROM rooms WHERE id = $1', [id]);
      const currentStatus = freshRoom.rows[0]?.status;

      // 检查是否有录制冷却期（录制失败后等待一段时间再重新启动）
      const cooldownKey = `polling:recording_cooldown:${id}`;
      const cooldown = await redis.get(cooldownKey).catch(() => null);
      if (cooldown) {
        console.log(`[PollingManager] 录制冷却期，跳过: ${room.room_name || room_url}`);
        return;
      }

      console.log(`[PollingManager] 数据库状态: ${room.room_name || room_url} currentStatus=${currentStatus}`);

      // 启动录制条件：isLive=true 且 当前不在录制中 且 有流地址
      if (isLive && currentStatus !== 'recording' && (result.streamUrl || result.streamInfo)) {
        await this._tryStartRecording(room, result);
      } else if (currentStatus === 'recording') {
        console.log(`[PollingManager] 房间已在录制中，跳过: ${room.room_name || room_url}`);
      }
    } catch (err) {
      console.error(`[PollingManager] 检查房间失败 (${room_url}):`, err.message);
    }
  }

  async _tryStartRecording(room, checkResult) {
    const { id, room_url, room_name } = room;

    try {
      // 在启动录制前，再次检查房间是否已经在录制中
      const freshRoom = await pool.query('SELECT status, ffmpeg_pid FROM rooms WHERE id = $1', [id]);
      if (freshRoom.rows.length > 0) {
        const currentStatus = freshRoom.rows[0].status;
        if (currentStatus === 'recording') {
          console.log(`[PollingManager] 房间已在录制中，跳过: ${room_name || room_url}`);
          return;
        }
      }

      let streamUrl = await this._extractStreamUrl(room_url, checkResult);

      if (!streamUrl) {
        console.warn(`[PollingManager] 无法提取直播流地址，跳过录制: ${room_name || room_url}`);
        return;
      }

      console.log(`[PollingManager] 准备启动录制: ${room_name || room_url}`);

      const recordResult = await RecorderService.startRecording({
        url: streamUrl,
        title: room_name || checkResult.roomTitle || '',
        caption: '',
        room_url: room_url,
      });

      if (!recordResult.error) {
        console.log(`[PollingManager] ✅ 启动录制成功: ${room_name || room_url}, 会话ID: ${recordResult.sessionId}`);
      } else {
        console.error(`[PollingManager] ❌ 启动录制失败: [${recordResult.code}] ${recordResult.message}`);
      }
    } catch (err) {
      console.error(`[PollingManager] ❌ 启动录制异常 (${room_url}):`, err.message);
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

    if (!this.roomLiveStatus.has(room.id)) {
      try {
        const cached = await redis.get(`polling:live_status:${room.id}`);
        if (cached) {
          const parsed = JSON.parse(cached);
          this.roomLiveStatus.set(room.id, parsed.isLive || false);
        }
      } catch (_) {}
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
