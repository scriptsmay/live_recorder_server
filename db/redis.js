const redisService = require('../lib/utils/redis-service');

const client = {
  connect: () => redisService.connect(),
  get: (key) => redisService.get(key),
  set: (key, value, options) => redisService.set(key, value, options),
  setEx: (key, seconds, value) => redisService.setEx(key, seconds, value),
  del: (key) => redisService.del(key),
  exists: (key) => redisService.exists(key),
  keys: (pattern) => redisService.keys(pattern),
  incr: (key) => redisService.incr(key),
  decr: (key) => redisService.decr(key),
  expire: (key, seconds) => redisService.expire(key, seconds),
  ttl: (key) => redisService.ttl(key),
  ping: () => redisService.ping(),
  disconnect: () => redisService.disconnect(),
  // 列表操作
  lPush: (key, value) => redisService.lPush(key, value),
  rPop: (key) => redisService.rPop(key),
  lLen: (key) => redisService.lLen(key),
  lRange: (key, start, end) => redisService.lRange(key, start, end),
};

module.exports = client;
