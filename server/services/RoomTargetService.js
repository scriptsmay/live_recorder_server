'use strict';

const pool = require('../db/index');
const { normalizeRoomUrl } = require('../lib/utils/room-url');
const { detectPlatform } = require('../lib/utils/platform-detector');
const { parseXiaohongshuIdentity, buildXiaohongshuProfileUrl } = require('../lib/utils/room-identity');

/**
 * 录制目标解析（ADR-021 Phase 1）。
 *
 * `rooms` 表示稳定的「录制目标」，`recording_sessions` 表示一次直播场次。
 * 小红书以 `host_user_id` 作为目标身份：直播间地址每场变化时，通过
 * `(polling_platform, host_user_id)` 归并到同一条 rooms 记录，并把本场的
 * `live_room_id` / `live_url` 写在房间上。
 *
 * 其他平台保持原有语义：规范化 URL 即身份。
 */
class RoomTargetService {
  /**
   * 解析（必要时创建）稳定的录制目标。
   *
   * @param {Object} params
   * @param {string} params.roomUrl - 原始 / 规范化房间地址
   * @param {string} [params.platform] - 平台；缺省按 URL 探测
   * @param {string} [params.hostUserId] - 小红书主播 user_id（优先于 URL 解析结果）
   * @param {string} [params.liveRoomId] - 小红书本场 room_id
   * @param {string} [params.roomName] - 房间名（仅新建或原名为空时使用）
   * @returns {Promise<Object>} rooms 行
   */
  static async resolve({ roomUrl, platform, hostUserId, liveRoomId, roomName } = {}) {
    const normalizedUrl = normalizeRoomUrl(roomUrl) || roomUrl;
    const resolvedPlatform = platform || detectPlatform(normalizedUrl) || null;
    const identity = resolvedPlatform === 'xiaohongshu' ? parseXiaohongshuIdentity(roomUrl) : null;

    const finalHostUserId = hostUserId || identity?.hostUserId || '';
    // live_room_id / live_url 是小红书场次字段；其他平台即使误传也不写，
    // 避免把小红书地址结构塞进别的平台房间。
    const finalLiveRoomId = resolvedPlatform === 'xiaohongshu' ? liveRoomId || identity?.liveRoomId || '' : '';
    const liveUrl = finalLiveRoomId
      ? identity?.liveUrl || `https://www.xiaohongshu.com/livestream/${finalLiveRoomId}`
      : '';

    // 目标身份：小红书有 user_id 时始终落到个人主页，保证跨场次稳定；
    // 无 user_id（旧直播间链接）退化为规范化 URL，维持一次性目标语义。
    const targetUrl =
      resolvedPlatform === 'xiaohongshu' && finalHostUserId
        ? buildXiaohongshuProfileUrl(finalHostUserId)
        : normalizedUrl;

    let room = null;

    if (resolvedPlatform === 'xiaohongshu' && finalHostUserId) {
      room = await this._findByHostUserId(finalHostUserId, true);
      if (!room) room = await this._findByHostUserId(finalHostUserId, false);
    }
    // 扩展手动录制 / webRequest 链路可能拿不到 host_user_id，但能给出直播间地址。
    // 若已有主播目标记录了同一个 live_room_id，优先归并到它，避免把请求落到
    // 历史遗留的「单场直播间」房间上（同一场直播出现两条房间记录）。
    if (!room && resolvedPlatform === 'xiaohongshu' && !finalHostUserId && finalLiveRoomId) {
      room = await this._findByLiveRoomId(finalLiveRoomId);
    }
    if (!room && targetUrl) {
      room = await this._findByRoomUrl(targetUrl);
    }

    if (!room) {
      room = await this._insertTarget({
        roomUrl: targetUrl,
        roomName,
        platform: resolvedPlatform,
        hostUserId: finalHostUserId,
        liveRoomId: finalLiveRoomId,
        liveUrl,
      });
    }

    return this._applyTargetState(room, {
      roomName,
      platform: resolvedPlatform,
      hostUserId: finalHostUserId,
      liveRoomId: finalLiveRoomId,
      liveUrl,
    });
  }

  /**
   * 下播 / 录制结束后清空当前场次，保留目标配置与历史会话。
   *
   * @param {number} roomId
   * @returns {Promise<void>}
   */
  static async clearLiveState(roomId) {
    if (!roomId) return;
    await pool.query(
      `UPDATE rooms
       SET live_room_id = '', live_url = '', updated_at = NOW()
       WHERE id = $1 AND (live_room_id <> '' OR live_url <> '')`,
      [roomId]
    );
  }

  static async _findByHostUserId(hostUserId, activeOnly) {
    const result = await pool.query(
      `SELECT * FROM rooms
       WHERE polling_platform = 'xiaohongshu' AND host_user_id = $1
         ${activeOnly ? 'AND deleted_at IS NULL' : ''}
       ORDER BY ${activeOnly ? 'id' : 'deleted_at NULLS LAST, id'}
       LIMIT 1`,
      [hostUserId]
    );
    return result.rows[0] || null;
  }

  /**
   * 按本场 live_room_id 找已绑定主播目标（host_user_id 非空）的房间。
   * 只认稳定目标，避免命中历史遗留的单场直播间记录。
   */
  static async _findByLiveRoomId(liveRoomId) {
    const result = await pool.query(
      `SELECT * FROM rooms
       WHERE polling_platform = 'xiaohongshu' AND live_room_id = $1
         AND host_user_id <> '' AND deleted_at IS NULL
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
      [liveRoomId]
    );
    return result.rows[0] || null;
  }

  static async _findByRoomUrl(roomUrl) {
    const result = await pool.query('SELECT * FROM rooms WHERE room_url = $1 LIMIT 1', [roomUrl]);
    return result.rows[0] || null;
  }

  static async _insertTarget({ roomUrl, roomName, platform, hostUserId, liveRoomId, liveUrl }) {
    try {
      const result = await pool.query(
        `INSERT INTO rooms (room_url, room_name, polling_platform, host_user_id, live_room_id, live_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [roomUrl, roomName || '', platform, hostUserId || '', liveRoomId || '', liveUrl || '']
      );
      return result.rows[0];
    } catch (err) {
      // 并发下唯一约束冲突：回到解析流程复用已存在的行。
      if (err && err.code === '23505') {
        return (
          (hostUserId ? await this._findByHostUserId(hostUserId, true) : null) || (await this._findByRoomUrl(roomUrl))
        );
      }
      throw err;
    }
  }

  static async _applyTargetState(room, { roomName, platform, hostUserId, liveRoomId, liveUrl }) {
    const sets = [];
    const values = [];

    const add = (column, value) => {
      sets.push(`${column} = $${values.length + 1}`);
      values.push(value);
    };

    // 暂停监听的房间不会真正开始录制，也就没有 finishSession 帮忙清场次字段。
    // 这类请求不应污染 live_room_id / live_url，否则「当前场次」会长期残留。
    const allowLiveState = room.monitoring_enabled !== false;

    if (room.deleted_at != null) add('deleted_at', null);
    if (hostUserId && room.host_user_id !== hostUserId) add('host_user_id', hostUserId);
    if (!room.polling_platform && platform) add('polling_platform', platform);
    if (roomName && !room.room_name) add('room_name', roomName);
    if (allowLiveState && liveRoomId && room.live_room_id !== liveRoomId) add('live_room_id', liveRoomId);
    if (allowLiveState && liveUrl && room.live_url !== liveUrl) add('live_url', liveUrl);

    if (sets.length === 0) return room;

    sets.push('updated_at = NOW()');
    values.push(room.id);
    const result = await pool.query(
      `UPDATE rooms SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    return result.rows[0] || { ...room };
  }
}

module.exports = RoomTargetService;
