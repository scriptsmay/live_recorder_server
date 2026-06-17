const crypto = require('crypto');
const redis = require('../../db/redis');
const pool = require('../../db/index');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    SCRYPT_PARAMS.keylen,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

function verifyPassword(plain, stored) {
  try {
    if (!plain || !stored) return false;
    const parts = stored.split('$');
    if (parts.length !== 7 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, keylen, saltB64, hashB64] = parts;
    const params = {
      N: parsePositiveInt(N, SCRYPT_PARAMS.N),
      r: parsePositiveInt(r, SCRYPT_PARAMS.r),
      p: parsePositiveInt(p, SCRYPT_PARAMS.p),
    };
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(plain, salt, parsePositiveInt(keylen, SCRYPT_PARAMS.keylen), params);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function getAuthConfig() {
  return {
    ttlSeconds: parsePositiveInt(process.env.AUTH_TOKEN_TTL_HOURS, 24) * 3600,
    cookieName: process.env.AUTH_COOKIE_NAME || 'auth_token',
    rateLimit: parsePositiveInt(process.env.LOGIN_RATE_LIMIT, 5),
    lockoutSeconds: parsePositiveInt(process.env.LOGIN_LOCKOUT_MIN, 5) * 60,
  };
}

function getCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: process.env.AUTH_COOKIE_SECURE === 'true',
  };
}

async function validateCredentials(username, plainPassword) {
  const res = await pool.query('SELECT password_hash FROM admin_users WHERE username = $1', [username]);
  if (res.rows.length === 0) return false;
  return verifyPassword(plainPassword, res.rows[0].password_hash);
}

async function createSession(token, username) {
  const { ttlSeconds } = getAuthConfig();
  await redis.set(
    `auth:session:${token}`,
    JSON.stringify({ username, createdAt: Date.now() }),
    { EX: ttlSeconds },
  );
  return ttlSeconds;
}

async function destroySession(token) {
  if (!token) return;
  await redis.del(`auth:session:${token}`);
}

async function getSession(token) {
  if (!token) return null;
  const value = await redis.get(`auth:session:${token}`);
  if (!value) return null;
  return JSON.parse(value);
}

async function getLockTtl(ip) {
  if (typeof redis.ttl !== 'function') return 0;
  const ttl = await redis.ttl(`auth:lock:${ip}`);
  return ttl > 0 ? ttl : 0;
}

async function recordFailure(ip) {
  const { rateLimit, lockoutSeconds } = getAuthConfig();
  const key = `auth:fail:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 60);
  }
  if (count >= rateLimit) {
    await redis.set(`auth:lock:${ip}`, '1', { EX: lockoutSeconds });
    await redis.del(key);
  }
  return count;
}

async function clearFailures(ip) {
  await redis.del(`auth:fail:${ip}`);
}

module.exports = {
  hashPassword,
  verifyPassword,
  newToken,
  getAuthConfig,
  getCookieOptions,
  validateCredentials,
  createSession,
  destroySession,
  getSession,
  getLockTtl,
  recordFailure,
  clearFailures,
};
