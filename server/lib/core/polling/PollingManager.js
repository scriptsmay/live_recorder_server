const pool = require('../../../db/index');
const redis = require('../../../db/redis');
const CHECKERS = require('./checkers');
const RecorderService = require('../../../services/RecorderService');
const notify = require('../notify');
const { detectPlatform } = require('../../utils/platform-detector');

function redactStreamUrl(url) {
  if (!url) return url;
  return url.replace(/([?&](txSecret|hwSecret|wsSecret|stat|token|sign|sig)=)[^&]+/gi, '$1<redacted>');
}

/**
 * 轮询管理器类
 * 负责管理直播间的状态轮询、开播检测和自动录制功能
 */
class PollingManager {
  /**
   * 构造函数
   * 初始化轮询管理器的内部状态
   */
  constructor() {
    this.timers = new Map();
    this.isRunning = false;
    this.roomLiveStatus = new Map();
    this.roomPollingMeta = new Map();
    this._totalRooms = 0;
  }

  _setRoomPollingMeta(room) {
    this.roomPollingMeta.set(room.id, {
      platform: room.polling_platform || 'unknown',
      roomName: room.room_name || '',
      roomUrl: room.room_url,
    });
  }

  /**
   * 获取轮询概览快照。
   *
   * 该方法只读取内存状态，不在 Dashboard 请求路径里访问 DB 或 Redis。
   *
   * @returns {Object} 轮询概览数据
   */
  getPollingSnapshot() {
    const platformBreakdown = {};
    let currentlyLive = 0;

    for (const [roomId, meta] of this.roomPollingMeta) {
      const platform = meta.platform || 'unknown';
      if (!platformBreakdown[platform]) {
        platformBreakdown[platform] = { total: 0, live: 0 };
      }

      platformBreakdown[platform].total += 1;

      if (this.roomLiveStatus.get(roomId) === true) {
        currentlyLive += 1;
        platformBreakdown[platform].live += 1;
      }
    }

    return {
      total_polled: this.roomPollingMeta.size,
      total_rooms: this._totalRooms || this.roomPollingMeta.size,
      currently_live: currentlyLive,
      platform_breakdown: platformBreakdown,
    };
  }

  /**
   * 获取指定平台的直播间状态检查器类
   * @param {string} platform - 直播平台名称（如 'huya'）
   * @returns {Function|null} 返回对应平台的检查器类构造函数，如果平台不支持则返回 null
   */
  getChecker(platform) {
    const CheckerClass = CHECKERS[platform?.toLowerCase()];
    if (!CheckerClass) {
      console.warn(`[PollingManager] 不支持的平台: ${platform}`);
      return null;
    }
    return CheckerClass;
  }

  /**
   * 从检查结果中提取直播流地址
   * 优先使用已提取的流地址，如果没有则尝试通过平台特定的检查器重新提取
   * @param {string} room_url - 直播间URL
   * @param {Object} checkResult - 直播间状态检查结果对象
   * @param {string} [checkResult.streamUrl] - 已提取的流地址
   * @param {Object} [checkResult.streamInfo] - 流信息对象（用于二次提取）
   * @returns {Promise<string|null>} 返回提取到的流地址，如果无法提取则返回 null
   */
  async _extractStreamUrl(room_url, checkResult) {
    if (checkResult.streamUrl) {
      return checkResult.streamUrl;
    }

    if (checkResult.streamInfo) {
      const detectedPlatform = detectPlatform(room_url);
      const CheckerClass = CHECKERS[detectedPlatform];
      if (CheckerClass) {
        const checker = new CheckerClass(room_url);
        const status = await checker.checkStatus();
        return status.streamUrl;
      }
    }

    return null;
  }

  /**
   * 从数据库加载所有启用轮询的房间
   * 同时从Redis缓存中恢复房间的直播状态
   * @returns {Promise<Array>} 返回房间数组，每个房间包含id、room_url、room_name、polling_enabled等字段
   */
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
      this._totalRooms = result.rows.length;
      return result.rows;
    } catch (err) {
      console.error('[PollingManager] 加载轮询房间失败:', err.message);
      this._totalRooms = 0;
      return [];
    }
  }

  /**
   * 检查单个房间的直播状态
   * 执行状态检测、通知发送、录制启动等核心逻辑
   * @param {Object} room - 房间对象
   * @param {number} room.id - 房间ID
   * @param {string} room.room_url - 房间URL
   * @param {string} room.polling_platform - 轮询平台名称
   * @param {string} [room.room_name] - 房间名称
   * @param {boolean} [room.notification_enabled] - 是否启用通知
   * @param {number} [room.polling_interval] - 轮询间隔（秒）
   * @param {string} [room.status] - 房间当前状态
   * @returns {Promise<void>}
   */
  async checkRoom(room) {
    const { id, room_url, polling_platform } = room;
    const CheckerClass = this.getChecker(polling_platform);

    if (!CheckerClass) {
      return;
    }

    const checker = new CheckerClass(room_url);

    try {
      const result = await checker.checkStatus();
      if (result.error) {
        console.warn(`[PollingManager] 状态检查返回错误，保留上一轮状态: ${result.error}`);
        return;
      }

      const now = new Date();

      const wasLive = this.roomLiveStatus.get(id) || false;
      const isLive = result.isLive;

      console.log(
        `[PollingManager] 状态检查: ${room.room_name} wasLive=${wasLive} isLive=${isLive} roomStatus=${room.status}`
      );

      if (isLive && !wasLive && room.notification_enabled !== false) {
        notify.liveStart(room.room_name || room_url, room_url).catch((err) => {
          console.error('[PollingManager] 开播通知失败:', err.message);
        });
      } else if (!isLive && wasLive && room.notification_enabled !== false) {
        notify.liveEnd(room.room_name || room_url, room_url).catch((err) => {
          console.error('[PollingManager] 下播通知失败:', err.message);
        });
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

      const freshRoom = await pool.query('SELECT status, ffmpeg_pid FROM rooms WHERE id = $1', [id]);
      const currentStatus = freshRoom.rows[0]?.status;

      const cooldownKey = `polling:recording_cooldown:${id}`;
      const cooldown = await redis.get(cooldownKey).catch(() => null);
      if (cooldown) {
        console.log(`[PollingManager] 录制冷却期，跳过: ${room.room_name || room_url}`);
        return;
      }

      const recordable = result.recordable !== false;
      if (isLive && recordable && currentStatus !== 'recording' && (result.streamUrl || result.streamInfo)) {
        console.log(`[PollingManager][streamUrl]: ${redactStreamUrl(result.streamUrl)}`);
        await this._tryStartRecording(room, result);
      } else if (currentStatus === 'recording') {
        console.log(`[PollingManager] 房间已在录制中，跳过: ${room.room_name || room_url}`);
      } else if (isLive && !recordable) {
        console.log(`[PollingManager] 房间已开播但不可录制，跳过: ${room.room_name || room_url}`);
      }
    } catch (err) {
      console.error(`[PollingManager] 检查房间失败 (${room_url}):`, err.message);
    }
  }

  /**
   * 尝试启动房间录制
   * 检查录制状态、提取流地址并调用录制服务开始录制
   * @param {Object} room - 房间对象
   * @param {number} room.id - 房间ID
   * @param {string} room.room_url - 房间URL
   * @param {string} [room.room_name] - 房间名称
   * @param {Object} checkResult - 直播间状态检查结果
   * @param {string} [checkResult.streamUrl] - 直播流地址
   * @param {string} [checkResult.roomTitle] - 房间标题
   * @returns {Promise<void>}
   */
  async _tryStartRecording(room, checkResult) {
    const { id, room_url, room_name } = room;

    try {
      const freshRoom = await pool.query('SELECT status, ffmpeg_pid FROM rooms WHERE id = $1', [id]);
      if (freshRoom.rows.length > 0) {
        const currentStatus = freshRoom.rows[0].status;
        if (currentStatus === 'recording') {
          console.log(`[PollingManager] 房间已在录制中，跳过: ${room_name || room_url}`);
          return;
        }
      }

      let streamUrl = checkResult.streamUrl;

      if (!streamUrl) {
        streamUrl = await this._extractStreamUrl(room_url, checkResult);
      }

      if (!streamUrl) {
        console.warn(`[PollingManager] 无法提取直播流地址，跳过录制: ${room_name || room_url}`);
        return;
      }

      console.log(`[PollingManager] 准备启动录制: ${room_name || room_url}`);

      const recordResult = await RecorderService.startRecording({
        url: streamUrl,
        title: room_name || checkResult.roomTitle || '',
        caption: checkResult.roomTitle || '',
        room_url: room_url,
        roomCover: checkResult.roomCover || '',
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

  /**
   * 执行单次房间轮询
   * 添加随机延迟以避免并发请求压力，然后检查房间状态
   * @param {Object} room - 房间对象
   * @returns {Promise<void>}
   */
  async pollRoom(room) {
    const jitter = Math.floor(Math.random() * 5000);
    await new Promise((resolve) => setTimeout(resolve, jitter));

    await this.checkRoom(room);
  }

  /**
   * 启动单个房间的定时轮询
   * 清除旧的定时器，恢复缓存状态，执行首次检查，然后设置周期性轮询
   * @param {Object} room - 房间对象
   * @param {number} room.id - 房间ID
   * @param {string} room.room_url - 房间URL
   * @param {string} [room.room_name] - 房间名称
   * @param {number} [room.polling_interval] - 轮询间隔（秒），默认60秒
   * @returns {Promise<void>}
   */
  async startRoomPolling(room) {
    const roomKey = `room:${room.id}`;

    if (this.timers.has(roomKey)) {
      clearInterval(this.timers.get(roomKey));
    }

    this._setRoomPollingMeta(room);

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

  /**
   * 停止指定房间的轮询
   * @param {number} roomId - 房间ID
   * @returns {Promise<void>}
   */
  async stopRoomPolling(roomId) {
    const roomKey = `room:${roomId}`;
    if (this.timers.has(roomKey)) {
      clearInterval(this.timers.get(roomKey));
      this.timers.delete(roomKey);
      console.log(`[PollingManager] 已停止轮询: roomId=${roomId}`);
    }
    this.roomPollingMeta.delete(roomId);
  }

  /**
   * 启动轮询管理器
   * 加载所有启用轮询的房间并执行首次状态检查
   * @returns {Promise<void>}
   */
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

    // console.log('[PollingManager] 启动完成');
  }

  /**
   * 停止轮询管理器
   * 清除所有房间的轮询定时器
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    console.log('[PollingManager] 停止中...');

    for (const [, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.roomPollingMeta.clear();
    this.isRunning = false;

    console.log('[PollingManager] 已停止');
  }

  /**
   * 重启轮询管理器
   * 先停止再启动，用于配置变更后的重新初始化
   * @returns {Promise<void>}
   */
  async restart() {
    await this.stop();
    await this.start();
  }

  /**
   * 重新加载指定房间的轮询配置
   * 根据房间的polling_enabled状态决定启动或停止轮询
   * @param {number} roomId - 房间ID
   * @returns {Promise<void>}
   */
  async reloadRoom(roomId) {
    const result = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (result.rows.length === 0) {
      await this.stopRoomPolling(roomId);
      return;
    }

    const room = result.rows[0];

    // 判断轮询平台是否支持，不支持则自动关闭轮询
    const checkerClass = this.getChecker(room.polling_platform);
    if (!checkerClass) {
      console.warn(
        `[PollingManager] 房间 ${room.room_name || room.room_url} 配置了不支持的平台 ${room.polling_platform}，已禁用轮询`
      );
      await pool.query('UPDATE rooms SET polling_enabled = false WHERE id = $1', [roomId]);
      await this.stopRoomPolling(roomId);
      return;
    }

    if (room.polling_enabled) {
      await this.startRoomPolling(room);
    } else {
      await this.stopRoomPolling(roomId);
    }
  }
}

const pollingManager = new PollingManager();

module.exports = pollingManager;
