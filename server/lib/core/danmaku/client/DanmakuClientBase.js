/**
 * DanmakuClientBase — 弹幕客户端平台无关骨架（v1.10.0）
 *
 * 对齐 biliup 的 Platform trait 分层：连接/注册/心跳/重连/生命周期全部在这里，
 * 平台子类只实现协议差异：
 *   - getConnectionInfo(): 返回传输方式（ws/tcp）、端点列表（按序兜底）、注册包、心跳配置
 *   - decode(chunk): 把一帧原始数据解成标准化事件数组（comment/gift），并可用
 *     _markHeartbeatAck() 上报心跳响应
 *
 * 设计约束（v1.10.0 计划）：
 * - 指数退避重连 1s 起封顶 60s；每次重连重新执行 getConnectionInfo（平台可刷新 token/uid）
 * - 心跳超时检测：连续多个周期未收到 ack 主动断开重连（由平台声明 ackTimeoutMs 时启用）
 * - 任何异常只影响弹幕采集自身（JSONL 缺失 + 告警日志），绝不向上层抛出
 * - 事件回调 onEvent 由宿主（DanmakuRecorder）注入，攒批在宿主侧统一处理
 */
const net = require('net');
const WebSocket = require('ws');

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

class DanmakuClientBase {
  /**
   * @param {Object} opts
   * @param {string} opts.platform - 平台名（huya/bilibili/douyu/douyin）
   * @param {string} opts.roomUrl - 房间 URL（平台子类自行解析房间标识）
   * @param {Function} [opts.onEvent] - 事件回调 (event) => void
   * @param {Object} [opts.logger] - createModuleLogger 实例或 console
   */
  constructor({ platform, roomUrl, onEvent, logger }) {
    this.platform = platform;
    this.roomUrl = roomUrl;
    this.onEvent = onEvent;
    this.log = logger || console;
    this.destroyed = false;
    this.connected = false;
    this.socket = null;
    this.attempt = 0; // 连续失败次数（决定退避）
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.lastAckAt = 0;
    this.stats = {
      startedAt: null,
      connectCount: 0,
      reconnectCount: 0,
      eventsReceived: 0,
      lastEventAt: null,
    };
  }

  // ============================================================
  // 平台子类钩子
  // ============================================================

  /**
   * 返回连接信息。每次（重）连接都会重新调用。
   * @returns {Promise<{
   *   transport: 'ws'|'tcp',
   *   endpoints: Array<string|{host: string, port: number}>,  // 按序尝试，首个成功即用
   *   headers?: Object,                                       // ws 握手头
   *   registration: Buffer[],                                 // 连接后按序发送的注册包
   *   heartbeat: { data: Buffer, intervalMs: number, ackTimeoutMs: number|null }
   * }>}
   */
  async getConnectionInfo() {
    throw new Error(`[${this.platform}] getConnectionInfo not implemented`);
  }

  /**
   * 解码一帧原始数据为标准化事件数组。
   * 事件契约（与 DanmakuRecorder._normalizeEvent 对齐）：
   *   comment: { ts_abs_ms, type: 'comment', user, userId, text }
   *   gift:    { ts_abs_ms, type: 'gift', user, userId, giftName, count }
   * 心跳响应请在 decode 内调用 this._markHeartbeatAck()。
   * @param {Buffer} chunk
   * @returns {Array<Object>} 事件数组（无事件返回 []）
   */
  // eslint-disable-next-line no-unused-vars
  decode(chunk) {
    throw new Error(`[${this.platform}] decode not implemented`);
  }

  // ============================================================
  // 生命周期
  // ============================================================

  start() {
    if (this.destroyed) {
      this.log.warn(`[${this.platform}] start() on destroyed client, ignore`);
      return;
    }
    if (this.stats.startedAt) {
      return; // 已启动
    }
    this.stats.startedAt = Date.now();
    this.lastAckAt = Date.now();
    this._connect();
  }

  /**
   * 销毁客户端：停心跳/重连定时器、关连接。幂等，之后所有操作均为 no-op。
   * @param {string} [reason]
   */
  destroy(reason) {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._stopHeartbeat();
    this._closeSocket();
    this.log.important(`[${this.platform}] 客户端销毁: room=${this.roomUrl}${reason ? ` (${reason})` : ''}`);
  }

  _markHeartbeatAck() {
    this.lastAckAt = Date.now();
  }

  // ============================================================
  // 连接与重连
  // ============================================================

  _connect() {
    if (this.destroyed) return;
    this._connectAttempt().catch((err) => {
      this.log.warn(`[${this.platform}] 连接失败: room=${this.roomUrl} err=${err.message}`);
      this._scheduleReconnect();
    });
  }

  async _connectAttempt() {
    const info = await this.getConnectionInfo();
    const transport = info.transport === 'tcp' ? 'tcp' : 'ws';

    let lastErr = null;
    for (const endpoint of info.endpoints) {
      try {
        this.socket =
          transport === 'tcp'
            ? await this._connectTcp(endpoint)
            : await this._connectWs(endpoint, info.headers || {});
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        this.log.warn(`[${this.platform}] 端点连接失败: ${typeof endpoint === 'string' ? endpoint : `${endpoint.host}:${endpoint.port}`} err=${err.message}`);
      }
    }
    if (lastErr) {
      throw lastErr;
    }

    // 连接成功：重置退避
    if (this.attempt > 0) {
      this.stats.reconnectCount++;
    }
    this.attempt = 0;
    this.connected = true;
    this.stats.connectCount++;
    this.lastAckAt = Date.now();
    this.log.important(
      `[${this.platform}] 弹幕连接建立: room=${this.roomUrl} transport=${transport} connects=${this.stats.connectCount}`
    );

    // 注册包
    for (const reg of info.registration || []) {
      this._write(reg);
    }

    // 心跳
    this._startHeartbeat(info.heartbeat);
  }

  _connectWs(url, headers) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const settle = (fn, arg) => {
        ws.removeListener('open', onOpen);
        ws.removeListener('error', onError);
        fn(arg);
      };
      const onOpen = () => settle(resolve, ws);
      const onError = (err) => settle(reject, err);
      ws.on('open', onOpen);
      ws.on('error', onError);
    }).then((ws) => {
      ws.on('message', (data) => {
        this._onData(Buffer.isBuffer(data) ? data : Buffer.from(data));
      });
      ws.on('close', () => this._onConnectionLost('ws close'));
      ws.on('error', (err) => {
        this.log.warn(`[${this.platform}] ws 错误: ${err.message}`);
      });
      return ws;
    });
  }

  _connectTcp({ host, port }) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      const onError = (err) => {
        socket.destroy();
        reject(err);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        resolve(socket);
      });
    }).then((socket) => {
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('close', () => this._onConnectionLost('tcp close'));
      socket.on('error', (err) => {
        this.log.warn(`[${this.platform}] tcp 错误: ${err.message}`);
      });
      return socket;
    });
  }

  _write(data) {
    if (!this.socket) return;
    try {
      if (typeof data === 'string') {
        this.socket.send ? this.socket.send(data) : this.socket.write(data);
      } else if (this.socket.send && this.socket.readyState !== undefined) {
        // ws
        this.socket.send(data, { binary: true });
      } else {
        // net.Socket
        this.socket.write(data);
      }
    } catch (err) {
      this.log.warn(`[${this.platform}] 发送失败: ${err.message}`);
    }
  }

  _closeSocket() {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    try {
      if (typeof socket.close === 'function') {
        socket.close();
      } else {
        socket.destroy();
      }
    } catch (_) {}
  }

  _onConnectionLost(reason) {
    if (this.destroyed) return;
    if (!this.connected) return; // 重连流程中重复触发
    this.connected = false;
    this._stopHeartbeat();
    this.log.warn(`[${this.platform}] 连接断开: room=${this.roomUrl} reason=${reason}`);
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.destroyed) return;
    this.attempt++;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (this.attempt - 1));
    this.log.warn(
      `[${this.platform}] ${delay}ms 后重连(第 ${this.attempt} 次): room=${this.roomUrl}`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  // ============================================================
  // 心跳
  // ============================================================

  _startHeartbeat(heartbeat) {
    this._stopHeartbeat();
    if (!heartbeat || !heartbeat.data || !heartbeat.intervalMs) return;
    const { data, intervalMs, ackTimeoutMs } = heartbeat;
    this.heartbeatTimer = setInterval(() => {
      if (this.destroyed || !this.connected) return;
      // ack 超时检测：超过容许窗口未收到心跳响应 → 主动断开触发重连
      if (ackTimeoutMs && Date.now() - this.lastAckAt > ackTimeoutMs) {
        this.log.warn(`[${this.platform}] 心跳响应超时(${Math.round((Date.now() - this.lastAckAt) / 1000)}s 无 ack)，主动重连`);
        this._onConnectionLost('heartbeat timeout');
        return;
      }
      this._write(data);
    }, intervalMs);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ============================================================
  // 数据分发
  // ============================================================

  _onData(chunk) {
    if (this.destroyed) return;
    let events;
    try {
      events = this.decode(chunk);
    } catch (err) {
      // 单帧解码失败不影响连接与其他帧（协议变更/脏数据容错）
      this.log.warn(`[${this.platform}] 帧解码失败(忽略): ${err.message}`);
      return;
    }
    if (!Array.isArray(events) || events.length === 0) return;
    for (const event of events) {
      this.stats.eventsReceived++;
      this.stats.lastEventAt = Date.now();
      if (typeof this.onEvent === 'function') {
        try {
          this.onEvent(event);
        } catch (err) {
          this.log.warn(`[${this.platform}] 事件回调异常(忽略): ${err.message}`);
        }
      }
    }
  }
}

module.exports = { DanmakuClientBase, RECONNECT_BASE_MS, RECONNECT_MAX_MS };
