jest.mock('../lib/core/auth-service', () => ({
  getSession: jest.fn(),
}));

const { getSession } = require('../lib/core/auth-service');
const { readToken, requireAuth } = require('../middleware/require-auth');

function createResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('require-auth middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AUTH_ENABLED;
    delete process.env.AUTH_COOKIE_NAME;
  });

  it('reads token from configured cookie first', () => {
    process.env.AUTH_COOKIE_NAME = 'krec';
    const req = {
      cookies: { krec: 'cookie-token' },
      headers: { authorization: 'Bearer header-token' },
    };

    expect(readToken(req)).toBe('cookie-token');
  });

  it('rejects malformed or missing sessions', async () => {
    getSession.mockResolvedValue(null);
    const req = { cookies: { auth_token: 'token' }, headers: {} };
    const res = createResponse();
    const next = jest.fn();

    await requireAuth()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('sets req.auth for valid sessions', async () => {
    getSession.mockResolvedValue({ username: 'admin', createdAt: 1 });
    const req = { cookies: { auth_token: 'token' }, headers: {} };
    const res = createResponse();
    const next = jest.fn();

    await requireAuth()(req, res, next);

    expect(req.auth).toEqual({ username: 'admin', createdAt: 1 });
    expect(next).toHaveBeenCalled();
  });
});
