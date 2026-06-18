const crypto = require('crypto');
const pool = require('../../db/index');
const { hashPassword } = require('./auth-service');

function generatePassword(length = 12) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(length))
    .map((value) => chars[value % chars.length])
    .join('');
}

async function ensureAdminCredentials() {
  if (process.env.AUTH_ENABLED === 'false') return;

  const res = await pool.query('SELECT COUNT(*)::int AS count FROM admin_users');
  if (res.rows[0].count > 0) return;

  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = generatePassword();
  const passwordHash = hashPassword(password);

  await pool.query('INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)', [username, passwordHash]);

  console.log('\n============================================================');
  console.log(' K-Recorder 首次启动：已自动创建管理员账号');
  console.log(` 用户名: ${username}`);
  console.log(` 密码: ${password}`);
  console.log(' 请妥善保管密码。忘记密码时可清空 admin_users 表后重启服务。');
  console.log('============================================================\n');
}

module.exports = { ensureAdminCredentials, generatePassword };
