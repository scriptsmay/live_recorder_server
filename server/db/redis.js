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
  // 集合操作
  sAdd: (key, value) => redisService.sAdd(key, value),
  sRem: (key, value) => redisService.sRem(key, value),
  sIsMember: (key, value) => redisService.sIsMember(key, value),
  // 发布订阅
  publish: (channel, message) => redisService.publish(channel, message),
};

module.exports = client;
