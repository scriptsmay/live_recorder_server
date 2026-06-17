jest.mock('../db/redis', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  ttl: jest.fn(),
}));

jest.mock('../db/index', () => ({
  query: jest.fn(),
}));

const redis = require('../db/redis');
const authService = require('../lib/core/auth-service');

describe('auth-service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AUTH_TOKEN_TTL_HOURS;
    delete process.env.AUTH_COOKIE_NAME;
    delete process.env.LOGIN_RATE_LIMIT;
    delete process.env.LOGIN_LOCKOUT_MIN;
    delete process.env.AUTH_COOKIE_SECURE;
  });

  it('hashes and verifies scrypt passwords safely', () => {
    const hash = authService.hashPassword('secret-pass');

    expect(hash).toMatch(/^scrypt\$/);
    expect(authService.verifyPassword('secret-pass', hash)).toBe(true);
    expect(authService.verifyPassword('wrong-pass', hash)).toBe(false);
    expect(authService.verifyPassword('secret-pass', 'scrypt$bad')).toBe(false);
  });

  it('stores sessions with configured ttl', async () => {
    process.env.AUTH_TOKEN_TTL_HOURS = '2';

    const ttl = await authService.createSession('token-1', 'admin');

    expect(ttl).toBe(7200);
    expect(redis.set).toHaveBeenCalledWith(
      'auth:session:token-1',
      expect.stringContaining('"username":"admin"'),
      { EX: 7200 },
    );
  });

  it('reports lock ttl only for active locks', async () => {
    redis.ttl.mockResolvedValueOnce(42).mockResolvedValueOnce(-1);

    await expect(authService.getLockTtl('127.0.0.1')).resolves.toBe(42);
    await expect(authService.getLockTtl('127.0.0.1')).resolves.toBe(0);
  });
});
