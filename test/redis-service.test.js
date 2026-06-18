const redisService = require('../server/lib/utils/redis-service');

jest.mock('redis', () => {
  const mockClient = {
    connect: jest.fn().mockResolvedValue(),
    get: jest.fn().mockResolvedValue('test-value'),
    set: jest.fn().mockResolvedValue('OK'),
    setEx: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(1),
    keys: jest.fn().mockResolvedValue(['key1', 'key2']),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(60),
    disconnect: jest.fn().mockResolvedValue(),
    on: jest.fn(),
  };
  return {
    createClient: jest.fn().mockReturnValue(mockClient),
  };
});

describe('RedisService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redisService.isConnected = false;
    redisService.client = null;
    redisService.connectPromise = null;
  });

  describe('connection', () => {
    it('should connect to Redis', async () => {
      await redisService.connect();
      expect(redisService.isConnected).toBe(true);
    });

    it('should reuse existing connection', async () => {
      await redisService.connect();
      const client1 = await redisService.getClient();
      const client2 = await redisService.getClient();
      expect(client1).toBe(client2);
    });
  });

  describe('basic operations', () => {
    const testKey = 'test:redis:service:key';

    beforeEach(async () => {
      await redisService.connect();
    });

    it('should set and get value', async () => {
      await redisService.set(testKey, 'test-value');
      const value = await redisService.get(testKey);
      expect(value).toBe('test-value');
    });

    it('should set value with expiration', async () => {
      await redisService.setEx(testKey, 1, 'expiring-value');
      const value = await redisService.get(testKey);
      expect(value).toBe('test-value');
    });

    it('should delete key', async () => {
      await redisService.set(testKey, 'to-be-deleted');
      await redisService.del(testKey);
      expect(redisService.client.del).toHaveBeenCalledWith(testKey);
    });

    it('should check key existence', async () => {
      await redisService.set(testKey, 'exists');
      const exists = await redisService.exists(testKey);
      expect(exists).toBe(1);
    });

    it('should get ttl', async () => {
      const ttl = await redisService.ttl(testKey);
      expect(ttl).toBe(60);
      expect(redisService.client.ttl).toHaveBeenCalledWith(testKey);
    });
  });
});
