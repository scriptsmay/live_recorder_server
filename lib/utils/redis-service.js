const { createClient } = require('redis');
require('../../config/env').applyEnvDefaults();

class RedisService {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connectPromise = null;
  }

  async connect() {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this._doConnect();
    return this.connectPromise;
  }

  async _doConnect() {
    if (this.isConnected) return;

    const host = process.env.REDIS_HOST;
    const port = process.env.REDIS_PORT || 6379;
    const password = process.env.REDIS_PASSWORD || '';
    const user = process.env.REDIS_USER || 'default';
    const db = parseInt(process.env.REDIS_DB, 10) || 1;

    const url =
      process.env.REDIS_URL ||
      (password
        ? `redis://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}`
        : `redis://${host}:${port}`);

    this.client = createClient({ url, database: db });

    this.client.on('error', (err) => {
      if (err.code === 'CONNECTION_BROKEN') return;
      console.error('[Redis] 错误:', err.message);
    });

    this.client.on('connect', () => {
      console.log('[Redis] 已连接');
      this.isConnected = true;
    });

    this.client.on('end', () => {
      console.log('[Redis] 连接已关闭');
      this.isConnected = false;
    });

    await this.client.connect();
    this.isConnected = true;
  }

  async get(key) {
    await this.connect();
    return this.client.get(key);
  }

  async set(key, value, options = {}) {
    await this.connect();
    return this.client.set(key, value, options);
  }

  async setEx(key, seconds, value) {
    await this.connect();
    return this.client.setEx(key, seconds, value);
  }

  async del(key) {
    await this.connect();
    return this.client.del(key);
  }

  async exists(key) {
    await this.connect();
    return this.client.exists(key);
  }

  async keys(pattern) {
    await this.connect();
    return this.client.keys(pattern);
  }

  async incr(key) {
    await this.connect();
    return this.client.incr(key);
  }

  async expire(key, seconds) {
    await this.connect();
    return this.client.expire(key, seconds);
  }

  async ping() {
    await this.connect();
    return this.client.ping();
  }

  async getClient() {
    await this.connect();
    return this.client;
  }

  async disconnect() {
    if (this.client) {
      await this.client.disconnect();
      this.isConnected = false;
    }
  }
}

const redisService = new RedisService();

module.exports = redisService;
