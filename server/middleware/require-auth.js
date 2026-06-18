const { getSession } = require('../lib/core/auth-service');

function readToken(req) {
  const cookieName = process.env.AUTH_COOKIE_NAME || 'auth_token';
  const fromCookie = req.cookies?.[cookieName];
  if (fromCookie) return fromCookie;

  const authHeader = req.headers.authorization;
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, '').trim();
  }

  return null;
}

function requireAuth() {
  return async (req, res, next) => {
    if (process.env.AUTH_ENABLED === 'false') return next();

    const token = readToken(req);
    if (!token) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    let session;
    try {
      session = await getSession(token);
    } catch {
      return res.status(401).json({ error: 'unauthorized' });
    }

    if (!session || typeof session !== 'object' || !session.username) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    req.auth = {
      username: session.username,
      createdAt: session.createdAt,
    };

    return next();
  };
}

module.exports = { requireAuth, readToken };
