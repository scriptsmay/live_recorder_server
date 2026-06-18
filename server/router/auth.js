const express = require('express');
const {
  getAuthConfig,
  getCookieOptions,
  newToken,
  validateCredentials,
  createSession,
  destroySession,
  getLockTtl,
  recordFailure,
  clearFailures,
} = require('../lib/core/auth-service');
const { requireAuth, readToken } = require('../middleware/require-auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const normalizedUsername = String(username || '').trim();
    const plainPassword = String(password || '');
    const { cookieName } = getAuthConfig();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const lockTtl = await getLockTtl(ip);
    if (lockTtl > 0) {
      return res.status(429).json({
        error: 'locked',
        retry_after: lockTtl,
      });
    }

    if (!normalizedUsername || !plainPassword) {
      return res.status(400).json({ error: 'bad_request' });
    }

    const ok = await validateCredentials(normalizedUsername, plainPassword);
    if (!ok) {
      const count = await recordFailure(ip);
      const { rateLimit } = getAuthConfig();
      if (count >= rateLimit) {
        const retryAfter = await getLockTtl(ip);
        res.setHeader('Retry-After', String(retryAfter || 0));
        return res.status(429).json({
          error: 'locked',
          retry_after: retryAfter || 0,
        });
      }

      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const token = newToken();
    const ttlSeconds = await createSession(token, normalizedUsername);
    await clearFailures(ip);

    res.cookie(cookieName, token, {
      ...getCookieOptions(),
      maxAge: ttlSeconds * 1000,
    });

    return res.json({
      status: 'ok',
      data: { username: normalizedUsername },
    });
  } catch (err) {
    console.error('[Auth] 登录失败:', err);
    return res.status(500).json({ error: 'login_failed' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const { cookieName } = getAuthConfig();
    const token = readToken(req);
    if (token) {
      await destroySession(token);
    }
    res.clearCookie(cookieName, getCookieOptions());
    return res.json({ status: 'ok', data: null });
  } catch (err) {
    console.error('[Auth] 登出失败:', err);
    return res.status(500).json({ error: 'logout_failed' });
  }
});

router.get('/me', requireAuth(), async (req, res) => {
  return res.json({
    status: 'ok',
    data: { username: req.auth.username },
  });
});

router.get('/lock-status', async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const retryAfter = await getLockTtl(ip);
  res.json({
    status: 'ok',
    data: {
      locked: retryAfter > 0,
      retry_after: retryAfter,
    },
  });
});

module.exports = router;
