const pool = require('../../../db/index');
const HuyaChecker = require('./HuyaChecker');
const RecorderService = require('../../../services/RecorderService');
const notify = require('../notify');

const CHECKERS = {
  huya: HuyaChecker,
};

class PollingManager {
  constructor() {
    this.timers = new Map();
    this.isRunning = false;
  }

  static detectPlatformFromUrl(url) {
    const platformMap = {
      'huya.com': 'huya',
      'douyu.com': 'douyu',
      'live.bilibili.com': 'bilibili',
      'twitch.tv': 'twitch',
      'douyin.com': 'douyin',
      'twitcasting.tv': 'twitcasting',
    };

    for (const [domain, platform] of Object.entries(platformMap)) {
      const regex = new RegExp(`^(?:https?:\\/\\/)?.*?${domain}\\/(.+?)$`, 'i');
      if (regex.test(url)) {
        return platform;
      }
    }
    return null;
  }

  getChecker(platform) {
    const CheckerClass = CHECKERS[platform?.toLowerCase()];
    if (!CheckerClass) {
      console.warn(`[PollingManager] 不支持的平台: ${platform}`);
      return null;
    }
    return CheckerClass;
  }

  _extractHuyaStreamUrl(streamInfo) {
    if (!streamInfo || !streamInfo.streams || streamInfo.streams.length === 0) {
      return null;
    }

    try {
      // 尝试从 streams 中提取可用的直播流地址
      for (const stream of streamInfo.streams) {
        // 虎牙常见的直播流格式
        if (stream.sFlvUrl) {
          return stream.sFlvUrl;
        }
        if (stream.sHlsUrl) {
          return stream.sHlsUrl;
        }
        // 其他可能的字段名
        if (stream.url) {
          return stream.url;
        }
        if (stream.flv) {
          return stream.flv;
        }
        if (stream.hls) {
          return stream.hls;
        }
      }

      // 如果没找到，尝试从 bitRateInfo 或其他位置查找
      if (streamInfo.bitRateInfo && Array.isArray(streamInfo.bitRateInfo)) {
        for (const bitRate of streamInfo.bitRateInfo) {
          if (bitRate.url) {
            return bitRate.url;
          }
        }
      }

      return null;
    } catch (err) {
      console.error(`[PollingManager] 提取虎牙直播流地址失败:`, err.message);
      return null;
    }
  }

  async loadPollingRooms() {
    try {
      const result = await pool.query(`
        SELECT id, room_url, room_name, polling_enabled, polling_platform,
               polling_interval, last_polled_at, last_live_status,
               monitoring_enabled, notification_enabled
        FROM rooms
        WHERE polling_enabled = true
      `);
      return result.rows;
    } catch (err) {
      console.error('[PollingManager] 加载轮询房间失败:', err.message);
      return [];
    }
  }

  async checkRoom(room) {
    const { id, room_url, polling_platform, status, monitoring_enabled, notification_enabled } = room;
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

        // 发送开播通知
        if (notification_enabled !== false) {
          notify.liveStart(room.room_name || room_url, room_url).catch((err) => {
            console.error('[PollingManager] 开播通知失败:', err.message);
          });
        }

        // 如果房间空闲且监听已启用，则启动录制
        if (status === 'idle' && monitoring_enabled !== false) {
          try {
            // 尝试从 streamInfo 中提取真实的直播流地址
            let streamUrl = room_url;

            if (result.streamInfo && polling_platform === 'huya') {
              streamUrl = this._extractHuyaStreamUrl(result.streamInfo);
              console.log(
                `[PollingManager] 提取到虎牙直播流地址: ${streamUrl ? streamUrl.slice(0, 80) + '...' : '无'}`
              );
            }

            const recordResult = await RecorderService.startRecording({
              url: streamUrl,
              title: result.roomTitle || room.room_name || '',
              caption: '',
              room_url: room_url,
            });

            if (!recordResult.error) {
              console.log(
                `[PollingManager] ✅ 启动录制成功: ${room.room_name || room_url}, 会话ID: ${recordResult.sessionId}`
              );
            } else {
              console.error(`[PollingManager] ❌ 启动录制失败: ${recordResult.message || '未知错误'}`);
            }
          } catch (recErr) {
            console.error(`[PollingManager] ❌ 启动录制异常:`, recErr.message);
          }
        }
      } else if (!isLive && wasLive) {
        console.log(`[PollingManager] 🔴 下播检测: ${room.room_name || room_url}`);

        // 发送下播通知
        if (notification_enabled !== false) {
          notify.liveEnd(room.room_name || room_url, room_url).catch((err) => {
            console.error('[PollingManager] 下播通知失败:', err.message);
          });
        }
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
