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
  expire: (key, seconds) => redisService.expire(key, seconds),
  disconnect: () => redisService.disconnect(),
};

module.exports = client;
