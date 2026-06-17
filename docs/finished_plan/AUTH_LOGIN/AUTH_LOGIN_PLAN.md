# 前端登录认证开发计划

> 状态：已完成

## 背景与问题

当前 K-Recorder 的前端（Vue 3 SPA）所有 API 路由均无鉴权保护——任何能访问到 `3001` 端口（开发）或 `1123` 端口（生产）的客户端都能直接调用录制、投稿、转码、弹幕等写操作。

部署形态为内网 / 本地 HTTP，单人使用，但：
- 局域网内其他设备/家人误触风险
- 若 DDNS / FRP 等方式公网暴露，无任何防护
- `AGENTS.md` 已提到 `monitoring_enabled`、`notification_enabled` 等开关，但身份维度没有

需求：前端加一个简单的「用户名 + 密码」登录页，未登录访问任意页面都跳转到 `/login`。

---

## 目标

- 单管理员账号，凭据存 **PostgreSQL `admin_users` 表**（与项目其它业务表一致，复用现有 `pg` 连接池）
- 登录态用 **HttpOnly + SameSite=Strict Cookie** 携带 Token（`crypto.randomBytes` 生成的随机串）
- Token 存 Redis（`auth:session:{token}` → `{username, createdAt}`），TTL 24h
- 登录失败限流：同 IP 5 次/分钟失败 → 锁 5 分钟
- **首次启动自动初始化**：检测 `admin_users` 表为空时生成随机 12 字符密码 + scrypt 哈希 → 写入数据库 → 控制台巨幅高亮打印明文密码
- 现有所有非 `/api/auth/*` 路由全部走 `requireAuth()` 中间件
- 现有 Vue 前端接入登录页 + 路由守卫 + 顶栏用户菜单

**本方案已经处理的安全/边界细节**（实施时必须按此落实）：

- **密码哈希比较**：`crypto.scryptSync` 内部用 `timingSafeEqual` 比较；前置长度校验（`expected.length !== actual.length` 直接 false），整体 try-catch 兜底防 `TypeError: Buffers must have the same length` 导致进程崩溃
- **Session 反序列化防御**：`requireAuth` 中间件检查 `session && session.username` 任一缺失即 401，避免下游 `Cannot read properties of null` 崩溃
- **Cookie SameSite 边界**：生产同源部署用 `Strict`；开发期跨端口必须配置 Vite `server.proxy` 将 `/api` 代理到后端，浏览器才会同源携带 Cookie（详见 Phase 4.0 部署边界说明）
- **前端首屏体验**：不阻塞 `app.mount`，改为 `auth.ready=false` 时渲染全局 Loading；网络慢时只多转圈不白屏
- **退出登录清理**：后端 `clearCookie` 显式带与 `set` 一致的 `path` / `httpOnly` / `sameSite` / `secure` 参数；前端 `auth.logout()` 同步清 Pinia 状态，防止守卫死循环
- **限流 Key TTL 规范化**：`auth:fail:{ip}` 固定 `60s`（与 `LOGIN_RATE_LIMIT` 的"次/分钟"语义对齐）；`auth:lock:{ip}` TTL = `LOGIN_LOCKOUT_MIN * 60`
- **HLS 提示**：`docs/AUTH.md` 标注 `/hls/*` 仍可匿名播放，公网暴露时此路径仍可被拉取，防范流量盗刷

**不做**：
- 多用户、用户管理、改密 UI（单管理员场景下不必要，DB 改密一行 SQL 即可）
- 找回密码（自托管后台，密码在数据库里，运维直接清表重启即可）
- CSRF Token（`SameSite=Strict` 已挡掉跨站伪造场景）
- 滑动验证码 / 邮件 / 2FA（内网单人）
- 改写现有 API 签名 / 字段（只做"加鉴权"，不动业务）


- 找回密码（自托管后台，密码在数据库里，运维直接清表重启即可）
- CSRF Token（`SameSite=Strict` 已挡掉跨站伪造场景）
- 滑动验证码 / 邮件 / 2FA（内网单人）
- 改写现有 API 签名 / 字段（只做"加鉴权"，不动业务）

---

## 关键设计决策

| 决策点 | 选型 | 理由 |
| --- | --- | --- |
| 凭据存储 | PostgreSQL `admin_users` 表（id / username / password_hash / created_at / updated_at） | 与现有业务表一致；不污染 `.env`；容器彻底只读；后续可平滑加"个人中心改密" |
| 密码哈希 | Node `crypto.scrypt`（盐 + 64 字节） | 内置，零依赖；bcrypt/argon2 需要装包 |
| Token | `crypto.randomBytes(32).toString('base64url')`（无状态）+ Redis 存会话 | 主动失效/登出靠 Redis 删 key；不像纯 JWT 退不出 |
| Token 载体 | HttpOnly + SameSite=Strict + path=/ Cookie（key `auth_token`） | 防 XSS 一勺端走；纯 HTTP 部署 `secure=false`；**开发期必须走 Vite proxy 让前后端同源**（详见 Phase 4.0） |
| 密码比较 | `crypto.scryptSync` → `crypto.timingSafeEqual` + 长度前置校验 + try-catch | 防 `TypeError: Buffers must have the same length` 崩溃 |
| Session 校验 | `requireAuth` 显式校验 `session && session.username` | 防 Redis 数据损坏导致下游 `Cannot read properties of null` |
| 前端首屏 | 不阻塞 `app.mount`，App.vue 渲染 Loading；守卫内部再兜底 fetchMe | 网络慢时只转圈不白屏 |
| 登录态恢复 | 前端 `GET /api/auth/me` 启动时拉一次 | 比前端持久化 user 信息更安全 |
| 限流实现 | Redis 计数器 + TTL | 复用现有 Redis 客户端 |
| 鉴权失败处理 | 401 + `{ error: 'unauthorized' }` → 前端统一跳 `/login?redirect=...` | api.ts 拦截 401 |
| 鉴权位置 | Express 中间件 `requireAuth()` 包住所有业务 router | 集中放行点 |
| 首次启动 | 检测 `admin_users` 表为空 → 生成密码 → 写库 → 控制台打印明文 | 不修改宿主文件；fail-fast |
| 部署假设 | 纯内网/本地 HTTP | 限流宽松；`secure=false` 可接受 |

---

## 数据库表设计

迁移文件（`db/migrate.js` 启动时自动执行）中新增：

```sql
CREATE TABLE IF NOT EXISTS admin_users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ★ 触发器：UPDATE 时自动刷新 updated_at
-- （PG 的 DEFAULT CURRENT_TIMESTAMP 只在 INSERT 时生效，UPDATE 时需要显式触发器）
CREATE OR REPLACE FUNCTION admin_users_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admin_users_updated_at ON admin_users;
CREATE TRIGGER trg_admin_users_updated_at
    BEFORE UPDATE ON admin_users
    FOR EACH ROW
    EXECUTE FUNCTION admin_users_set_updated_at();
```

迁移写法建议（沿用项目现有迁移脚本风格）：
- 在 `db/migrate.js` 的 `CREATE_TABLES` 数组里追加一项
- 复用 `IF NOT EXISTS` 幂等
- 跑迁移时输出 `admin_users 表已就绪`
- 触发器用 `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS` 实现幂等（已存在的库执行迁移不会失败）

**为什么选 PostgreSQL 表而不是 `.env` 文件**：
1. **环境变量精简**——`.env` 里不再有 `ADMIN_PASSWORD_HASH` 这种"敏感 + 频繁变动"的项，配置和秘密分离
2. **容器只读**——Node.js 进程不再尝试修改宿主机文件，符合 Cloud Native / Docker 无状态容器最佳实践（与项目里 `biliup`、Redis、PG 全部跑容器内的设计保持一致）
3. **后续可扩展**——未来加"个人中心-改密" UI 时，后端只需 `UPDATE admin_users SET password_hash = ...`，不需要再从文件系统到数据库的重构

**忘记密码时的应急方式**（写进 `docs/AUTH.md`）：
> 进入容器或宿主机数据库，执行 `DELETE FROM admin_users;` 清空该表，然后重启服务。系统检测到表为空，会在控制台重新生成并打印一组全新的默认初始密码。

---

## 环境变量

新增项（`.env.example` + 用户 `.env`）：

```bash
# 登录鉴权
ADMIN_USERNAME=admin                       # 用户名，默认 admin；首次启动后此变量可废弃（凭据已在库里）
AUTH_TOKEN_TTL_HOURS=24                    # Token 有效期（小时）
AUTH_COOKIE_NAME=auth_token                # Cookie 名
LOGIN_RATE_LIMIT=5                         # 5 次失败/分钟/IP
LOGIN_LOCKOUT_MIN=5                        # 锁定 5 分钟
AUTH_ENABLED=true                          # 总开关（开发环境可临时关）
```

**注意**：相比原计划废弃了 `ADMIN_PASSWORD_HASH`——密码哈希不再落环境变量。

哈希格式：`scrypt$N$r$p$keylen$saltBase64$hashBase64`（存到一个字符串）。

---

## 现状：当前架构摸排

| 模块 | 文件 | 角色 |
| --- | --- | --- |
| 启动编排 | `app.js` | 注册中间件、挂路由、启 HTTP |
| 启动生命周期 | `lib/core/lifecycle.js` | `bootstrap()` 内含 DB 迁移、Redis 连接、轮询启动 |
| 路由总入口 | `router/index.js` | 8 个子 router 全部 `app.use` 挂载 |
| 路由 SPA 回退 | `router/spa.js` | `/frontend/*` 静态资源 + history 路由回退 + 老路径重定向 |
| Redis 客户端 | `db/redis.js` | `redis` 包的 `createClient`，`getRedis()` 工厂 |
| DB 池 | `db/index.js` | `pg.Pool`，`getPool()` 工厂 |
| 迁移脚本 | `db/migrate.js` | 启动时跑建表，CREATE_TABLES 数组 |
| 环境变量 | `config/env.js` | `dotenv` 加载 + `initEnv()` |
| 访问日志 | `middleware/access-log.js` | morgan 中间件 |
| 前端入口 | `frontend/src/main.ts` | Vue 挂载 + Pinia + Router 初始化 |
| 前端 router | `frontend/src/router/index.ts` | `createRouter` 路由表 |
| API 客户端 | `frontend/src/utils/api.ts` | `request()` / `api.get()` 等 |
| Pinia stores | `frontend/src/stores/` | `app.ts` / `danmaku-toolbox.ts` / `replay-toolbox.ts` |
| 顶栏组件 | `frontend/src/components/` | （含 `Layout.vue` 等公共布局） |

**关键观察**：
- 路由 `router/index.js` 是单一挂载点 → 加中间件最干净
- 已有 Redis 客户端 → 复用做 session + 限流
- 已有 `db/migrate.js` 迁移机制 → 新表沿用同款风格
- 前端 `api.ts` 已有 `request()` 包装 → 注入 401 拦截点极方便
- 前端有顶栏组件 → 嵌入用户菜单是局部改动

---

## 实施方案（6 个阶段）

### Phase 1：后端核心（依赖：0）

**1.1 迁移新增 `admin_users` 表**（改 `db/migrate.js`）

在 `CREATE_TABLES` 数组里追加：

```js
{
  name: 'admin_users',
  sql: `
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `,
},
```

**1.2 新增 `lib/core/auth-service.js`**

```js
// 核心 API（不绑 express）
const crypto = require('crypto');
const { getRedis } = require('../../db/redis');
const { getPool } = require('../../db/index');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${SCRYPT_PARAMS.keylen}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(plain, stored) {
  try {
    const parts = stored.split('$');
    if (parts.length !== 7 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, keylen, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(plain, salt, parseInt(keylen, 10), {
      N: parseInt(N, 10), r: parseInt(r, 10), p: parseInt(p, 10),
    });
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function newToken() { return crypto.randomBytes(32).toString('base64url'); }

async function validateCredentials(username, plainPassword) {
  const pool = getPool();
  const res = await pool.query(
    'SELECT password_hash FROM admin_users WHERE username = $1',
    [username],
  );
  if (res.rows.length === 0) return false;
  return verifyPassword(plainPassword, res.rows[0].password_hash);
}

async function createSession(token, username) {
  const ttl = parseInt(process.env.AUTH_TOKEN_TTL_HOURS || '24', 10) * 3600;
  const r = getRedis();
  await r.set(
    `auth:session:${token}`,
    JSON.stringify({ username, createdAt: Date.now() }),
    { EX: ttl },
  );
  return ttl;
}

async function destroySession(token) { await getRedis().del(`auth:session:${token}`); }

async function getSession(token) {
  const v = await getRedis().get(`auth:session:${token}`);
  return v ? JSON.parse(v) : null;
}

async function isLocked(ip) {
  const ttl = await getRedis().ttl(`auth:lock:${ip}`);
  return ttl > 0 ? ttl : 0;
}

async function recordFailure(ip) {
  const key = `auth:fail:${ip}`;
  const r = getRedis();
  const count = await r.incr(key);
  // 60s 窗口固定，与 LOGIN_RATE_LIMIT（次/分钟）语义对齐
  if (count === 1) await r.expire(key, 60);
  if (count >= parseInt(process.env.LOGIN_RATE_LIMIT || '5', 10)) {
    const lockMin = parseInt(process.env.LOGIN_LOCKOUT_MIN || '5', 10);
    // auth:lock:{ip} TTL = LOGIN_LOCKOUT_MIN * 60
    await r.set(`auth:lock:${ip}`, '1', { EX: lockMin * 60 });
    await r.del(key);
  }
  return count;
}

async function clearFailures(ip) { await getRedis().del(`auth:fail:${ip}`); }

module.exports = {
  hashPassword, verifyPassword, newToken,
  validateCredentials, createSession, destroySession, getSession,
  isLocked, recordFailure, clearFailures,
};
```

**1.3 新增 `middleware/require-auth.js`**

```js
const { getSession } = require('../lib/core/auth-service');
const { getRedis } = require('../db/redis');

function readToken(req) {
  const cookieName = process.env.AUTH_COOKIE_NAME || 'auth_token';
  const fromCookie = req.cookies && req.cookies[cookieName];
  if (fromCookie) return fromCookie;
  const auth = req.headers['authorization'];
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return null;
}

function requireAuth() {
  return async (req, res, next) => {
    if (process.env.AUTH_ENABLED === 'false') return next();
    const token = readToken(req);
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    let session = null;
    try {
      session = await getSession(token);
    } catch (e) {
      // Redis 异常 / JSON.parse 异常 → 一律 401，绝不让崩溃冒泡
      return res.status(401).json({ error: 'unauthorized' });
    }
    // 防御性校验：session 必须存在且带 username（防 Redis 数据损坏/被污染导致下游 Cannot read properties of null）
    if (!session || typeof session !== 'object' || !session.username) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    req.auth = { username: session.username, createdAt: session.createdAt };
    next();
  };
}

module.exports = { requireAuth, readToken };
```

**1.4 新增 `router/auth.js`**

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `POST` | `/api/auth/login` | 限流 → 验用户名密码（查 DB）→ 创建 session → set Cookie → 返回 `{ username }` |
| `POST` | `/api/auth/logout` | 读 token → `destroySession` → clear Cookie → 200 |
| `GET`  | `/api/auth/me` | `requireAuth`（仅本接口）→ 返回 `{ username }` |

**关键点**：
- 密码比较走 `crypto.timingSafeEqual`（在 `verifyPassword` 内部；前置 `expected.length !== actual.length` 判 false + 外层 try-catch 防 `TypeError` 进程崩溃）
- 失败 5 次后返回 429 + `Retry-After` 头
- `me` 接口单独叠加 `requireAuth`（不靠全局守卫，避免无限递归）
- **Cookie 设置（login 成功）**：**统一封装 `getCookieOpts(req)` 函数**，保证 set 和 clear 用同一份参数（避免 set/clear 参数漂移导致 Cookie 残留）：

```js
// lib/core/auth-service.js 内或单独 cookie.js
function getCookieOpts(req) {
  const isProd = process.env.NODE_ENV === 'production';
  // 关键：不依赖 req.secure（反代后 req.secure 经常是 false，依赖它会让 set/clear 在不同请求上产生不同参数）
  // 直接看环境变量：公网部署时强制 secure=true（生产环境默认走 HTTPS）
  // 同时启用 app.set('trust proxy', 1) 让 req.ip / X-Forwarded-Proto 走反代头
  return {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: isProd,           // 生产环境强制 secure=true（公网部署必须走 HTTPS）
    maxAge: undefined,        // 显式在 set 时由调用方注入 ttl*1000
  };
}

// login 路由
const opts = getCookieOpts(req);
opts.maxAge = ttl * 1000;
res.cookie(process.env.AUTH_COOKIE_NAME || 'auth_token', token, opts);

// logout 路由（必须**复用同一个工厂**，不允许手写 path/sameSite 等）
res.clearCookie(process.env.AUTH_COOKIE_NAME || 'auth_token', getCookieOpts(req));
```

- **app.js 必须 `app.set('trust proxy', 1)`**：让反代后的 `req.secure` / `req.ip` 正确识别（不写这条会**让限流的 IP 错把反代 IP 当客户端 IP**，所有用户共享一个限流桶）。

- **`/api/auth/logout` 必须先 `destroySession` 再 `clearCookie`**：避免 token 残留、避免前端收不到 Set-Cookie 失效头。

**1.5 修改 `router/index.js`**

```js
// 顺序：authRouter 必须先于 requireAuth 中间件
app.use('/api/auth', authRouter);   // ← 新增
app.use(requireAuth());              // ← 新增，全局守卫
app.use('/api/rooms', roomsRouter);
app.use('/api/recording_files', recordingFilesRouter);
// ... 其余 router
```

### Phase 2：自动初始化（依赖：Phase 1）

**2.1 新增 `lib/core/auth-init.js`**

```js
const crypto = require('crypto');
const { getPool } = require('../../db/index');
const { hashPassword } = require('./auth-service');

function generatePassword(len = 12) {
  // 从 56 字符集取；剔除易混字符 (0/O/1/l/I)
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(len))
    .map((b) => chars[b % chars.length])
    .join('');
}

async function ensureAdminCredentials() {
  const pool = getPool();

  // 1. 检查表里是否已有管理员
  const checkRes = await pool.query('SELECT COUNT(*)::int AS cnt FROM admin_users');
  const count = checkRes.rows[0].cnt;

  if (count === 0) {
    // 2. 首次启动：生成默认账号
    const defaultUsername = process.env.ADMIN_USERNAME || 'admin';
    const plainPassword = generatePassword();
    const hash = hashPassword(plainPassword);

    // 3. 写库
    await pool.query(
      'INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)',
      [defaultUsername, hash],
    );

    // 4. 控制台巨幅高亮打印（Docker 容器日志可见）
    console.log('\n==================================================');
    console.log(' 🚀 K-Recorder 首次启动：已在数据库中自动创建管理员');
    console.log(`    用 户 名 : ${defaultUsername}`);
    console.log(`    明文密码 : ${plainPassword}`);
    console.log(' ==================================================');
    console.log(' 请妥善保管上方密码！如需修改，可直接 UPDATE 数据库。');
    console.log(' 应急重置：DELETE FROM admin_users; 后重启服务');
    console.log('==================================================\n');
  }
}

module.exports = { ensureAdminCredentials, generatePassword };
```

**2.2 修改 `lib/core/lifecycle.js`**

`bootstrap(app, port)` 中，**数据库迁移之后、HTTP listen 之前**调用 `ensureAdminCredentials()`：

```js
async function bootstrap(app, port) {
  // 1. 初始化数据库连接池、Redis
  await initDB();
  await initRedis();

  // 2. 执行数据库迁移（确保 admin_users 表已被创建）
  await runMigrations();

  // 3. ★ 核心改动：执行管理员凭据检查/初始化
  await ensureAdminCredentials();

  // 4. 启动 HTTP 监听
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}
```

调用时机的关键性：必须在迁移之后（表已存在）、在 `app.listen` 之前（避免未初始化就对外服务）。如果 PG 不可用导致这一步失败，启动会抛错并退出——这是想要的行为（fail-fast）。

**2.3 新增 `cookie-parser` 依赖**

`npm install cookie-parser`，`package.json` 同步。

**2.4 修改 `app.js`**

```js
const cookieParser = require('cookie-parser');
// ...
const app = express();
// ★ 必须先于任何路由注册：让 req.secure / req.ip 在反代后能正确识别
// 否则限流会按反代 IP 计算（所有用户共享一个桶）
app.set('trust proxy', 1);
app.use(cookieParser());  // 在 express.json() 之前
```

### Phase 3：环境配置（依赖：Phase 1+2）

**3.1 修改 `.env.example`**

在文件末尾追加上述 5 个 `AUTH_*` / `LOGIN_*` 变量（**不包含** `ADMIN_PASSWORD_HASH`——密码已入库）。

```bash
# 登录鉴权
ADMIN_USERNAME=admin
AUTH_TOKEN_TTL_HOURS=24
AUTH_COOKIE_NAME=auth_token
LOGIN_RATE_LIMIT=5
LOGIN_LOCKOUT_MIN=5
AUTH_ENABLED=true
```

**3.2 不需要手动生成 hash**——`auth-init` 在首次启动自动完成。

### Phase 4：前端（依赖：Phase 1 后端跑通）

**4.0 部署边界：Vite proxy（必做）**

`SameSite=Strict` + 跨端口 = 浏览器**不会**自动携带 Cookie（即使 `credentials: 'include'`）。开发期 Vue 跑 `5173`、后端跑 `3001`，必须把 `/api` 代理到后端，让浏览器视为同源。

`frontend/vite.config.ts` 追加：

```ts
server: {
  port: 5173,
  proxy: {
    '/api': {
      target: 'http://localhost:3001',
      changeOrigin: true,
      // 不重写 path：保持 /api 前缀传给后端
    },
    '/hls': {
      target: 'http://localhost:3001',
      changeOrigin: true,
    },
  },
},
```

并核对 `frontend/src/utils/api.ts` 内的 `BASE_URL` 是否使用相对路径（推荐 `''` 或 `/api`），**不要**写绝对 URL `http://localhost:3001`，否则 Cookie 仍会因跨域丢失。

**4.1 新增 `frontend/src/stores/auth.ts`**

```ts
import { defineStore } from 'pinia';
import { api } from '@/utils/api';

interface User { username: string }
export const useAuthStore = defineStore('auth', {
  state: () => ({ user: null as User | null, ready: false }),
  actions: {
    async fetchMe() {
      try { const r = await api.get('/api/auth/me'); this.user = r.data; }
      catch { this.user = null; }
      finally { this.ready = true; }
    },
    async login(username: string, password: string) {
      const r = await api.post('/api/auth/login', { username, password });
      this.user = r.data;
      return r.data;
    },
    async logout() {
      // 先调后端销毁 session（失败也继续清本地，避免守卫死循环）
      try { await api.post('/api/auth/logout'); } catch {}
      // 同步清 Pinia：必须先清 ready=false？—— 不，保持 ready=true，只把 user 置空
      // 否则下一次 fetchMe 之前的路由跳转会被守卫错误判为"未初始化"
      this.user = null;
    },
    // 路由守卫 / 401 拦截统一调用：原子清空（防残留导致死循环）
    clearLocal() {
      this.user = null;
    },
  },
});
```

**4.2 新增 `frontend/src/views/Login.vue`**

布局：居中卡片，logo + 表单（username / password / 登录按钮），错误条幅，loading 态，`?redirect=` 回跳。
视觉：复用项目 Tailwind 配色（参考 Dashboard 顶栏），不做品牌设计。

**4.3 新增 `frontend/src/components/UserMenu.vue`**

顶栏右侧下拉：当前用户名 + 退出按钮。

**4.4 修改 `frontend/src/router/index.ts`**

```ts
const routes = [
  { path: '/login', name: 'Login', component: () => import('@/views/Login.vue'), meta: { public: true } },
  // ... 其它原路由不变
];

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.ready) await auth.fetchMe();   // 启动时拉一次 /me

  if (to.meta.public) {
    if (auth.user) return { name: 'Dashboard' };
    return true;
  }
  if (!auth.user) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }
  return true;
});
```

**4.5 修改 `frontend/src/utils/api.ts`**

加 `setUnauthorizedHandler(fn)` + `request()` 内 401 触发；`main.ts` 中注册回调 → 调 `auth.clearLocal()` + 跳 `/login?redirect=...`。
**为什么不用 `auth.logout()`**：logout 会再发一次 `/api/auth/logout` 请求，如果服务端 session 已经被服务端主动清理（如服务端崩溃后重启），这次请求可能又触发 401 → 再次进入拦截器 → 死循环。`clearLocal()` 只清本地状态，不发请求。
Cookie 浏览器自动带，**fetch 不需要改**。

**4.6 修改 `frontend/src/main.ts`**

```ts
import { setUnauthorizedHandler } from '@/utils/api';
import { useAuthStore } from '@/stores/auth';
setUnauthorizedHandler(() => {
  const auth = useAuthStore();
  // ★ 用 clearLocal 而非 logout：避免 logout 再发请求触发 401 死循环
  auth.clearLocal();
  const here = router.currentRoute.value.fullPath;
  if (here !== '/login') router.push({ path: '/login', query: { redirect: here } });
});
// ★ 关键：不要在这里手动调 auth.fetchMe()
// 理由：app.mount('#app') 之后，Vue Router 解析初始路由时一定会经过
// router.beforeEach 守卫；守卫内部的 `if (!auth.ready) await auth.fetchMe()`
// 会触发"第一次、也是唯一一次" /me 请求。
// 在 main.ts 重复调 fetchMe 会和守卫内的请求**并发**，导致：
//   1. 两次相同的 GET /api/auth/me（网络浪费）
//   2. Pinia 状态被两个 promise 各自 set 一次（无视觉差异但非原子）
//   3. Redis 多一次 GET（极小但可避免）
// 正确做法：把 fetchMe 的"启动"职责**完全交给**路由守卫。
app.mount('#app');
```

**4.6.1 `frontend/src/App.vue`（新增/修改）：Loading 兜底**

```vue
<template>
  <div v-if="!auth.ready" class="min-h-screen flex items-center justify-center bg-gray-50">
    <div class="flex flex-col items-center gap-3">
      <div class="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      <div class="text-sm text-gray-500">正在恢复登录态…</div>
    </div>
  </div>
  <RouterView v-else />
</template>

<script setup lang="ts">
import { useAuthStore } from '@/stores/auth';
const auth = useAuthStore();
</script>
```

注意：`<RouterView>` 仍受 `router.beforeEach` 守卫；守卫内部 `if (!auth.ready) await auth.fetchMe()` 会在 Vue 挂载后、首次路由跳转时**同步**触发 `auth.ready = true`；App.vue 通过 `v-if="!auth.ready"` 响应式关闭 Loading。这是**单一启动源**（避免 main.ts 和守卫并发发请求）。

**4.7 修改 `frontend/src/components/Layout.vue`**

顶栏末尾嵌入 `<UserMenu />`（已有顶栏的话；如无顶栏，新加）。

**4.8 修改 `router/spa.js`**

`spaRoutes` 数组加 `'/login'`。

### Phase 5：测试（依赖：Phase 1+2）

**5.1 新增 `test/auth.test.js`**

Jest + supertest；mock 掉 `db/redis.js` 和 `db/index.js`（沿用项目其它测试的 mock 模式）。

| 用例 | 覆盖点 |
| --- | --- |
| `hashPassword / verifyPassword` 正确路径 | 哈希+验证往返 |
| `verifyPassword` 错误密码返回 false | 错误场景 |
| `validateCredentials` 命中 DB 用户 | 凭据查询 |
| `validateCredentials` 用户名不存在返回 false | 错误场景 |
| `recordFailure` 第 N 次触发锁定 | 限流 |
| `isLocked` 在锁定期返回剩余秒数 | 锁定查询 |
| `POST /api/auth/login` 200 + set Cookie | 正常登录 |
| `POST /api/auth/login` 401 错误密码 | 错误登录 |
| `POST /api/auth/login` 429 锁定后 | 限流响应 |
| `POST /api/auth/logout` 200 + clear Cookie + destroySession | 登出清理 |
| `POST /api/auth/logout` Cookie 清理参数与 set 一致（同一个 `getCookieOpts` 工厂） | 防 cookie 残留 |
| `app.set('trust proxy', 1)` 后限流按真实客户端 IP 走 | 反代后限流不串桶 |
| `getCookieOpts` 的 `secure` 仅看 `NODE_ENV`，不依赖 `req.secure` | 防 set/clear 参数漂移 |
| `GET /api/auth/me` 200 带 token | 鉴权通过 |
| `GET /api/auth/me` 401 无 token | 鉴权失败 |
| `GET /api/auth/me` 401 token 有效但 session 缺 username | 会话反序列化防御（防 Cannot read properties of null） |
| `GET /api/auth/me` 401 token 有效但 Redis 数据损坏 | JSON.parse 异常不崩溃 |
| `GET /api/rooms` 401 无 token | 全局守卫 |
| `GET /api/rooms` 200 带 token | 全局守卫放行 |

**5.2 修改 `test/` 现有用例**

如有全局守卫影响的旧测试（不太可能有，因为之前没鉴权），在测试 setup 里 mock 掉 `requireAuth` 或注入 `x-test-user` 头。

**5.3 测试 `ensureAdminCredentials`**

| 用例 | 覆盖点 |
| --- | --- |
| 表为空时插入新账号 | 首次初始化 |
| 表已有账号时跳过 | 幂等性 |
| 生成密码长度与字符集 | 密码质量 |

### Phase 6：交付前（依赖：以上全部）

**6.1 校验**

- `npm run lint && npm run format && npm run test`
- 启动 dev：访问 `/` → 跳 `/login` → 输控制台打印的密码 → 进 dashboard → 退出 → 又跳 `/login`
- 启动时故意 `DELETE FROM admin_users;` 后重启 → 控制台打印新密码 → 二次启动沿用
- 用 `psql` 直接 `UPDATE admin_users SET password_hash = ...` 测改密 → 重启后新密码生效

**6.2 文档 + 提交**

- 在 `docs/` 新建 `AUTH.md` 描述方案、配置、首次启动流程、密码修改方式、忘密应急命令
- 按 `AGENTS.md` 要求更新 `docs/todo/TODO.md` 把本计划列入"待完成计划"
- 完成后按惯例 `git add` / `git commit`，类型建议 `feat: 前端登录认证` / `chore: ...`

---

## 文件改动清单

| 类别 | 路径 | 动作 | 阶段 |
| --- | --- | --- | --- |
| 修改 | `db/migrate.js` | 追加 `admin_users` 表 + `updated_at` 触发器 | Phase 1 |
| 新增 | `lib/core/auth-service.js` | 新建（DB 验证 + Redis session + 限流） | Phase 1 |
| 新增 | `middleware/require-auth.js` | 新建 | Phase 1 |
| 新增 | `router/auth.js` | 新建 | Phase 1 |
| 修改 | `router/index.js` | 挂 authRouter + 全局 requireAuth | Phase 1 |
| 新增 | `lib/core/auth-init.js` | 新建（DB 首次启动初始化） | Phase 2 |
| 修改 | `lib/core/lifecycle.js` | `bootstrap` 内调用 `ensureAdminCredentials` | Phase 2 |
| 修改 | `app.js` | 注册 cookieParser + `app.set('trust proxy', 1)` | Phase 2 |
| 修改 | `package.json` | + `cookie-parser` | Phase 2 |
| 修改 | `.env.example` | 追加鉴权环境变量（无 PASSWORD_HASH） | Phase 3 |
| 新增 | `frontend/src/stores/auth.ts` | 新建 | Phase 4 |
| 新增 | `frontend/src/views/Login.vue` | 新建 | Phase 4 |
| 新增 | `frontend/src/components/UserMenu.vue` | 新建 | Phase 4 |
| 修改 | `frontend/src/router/index.ts` | 路由守卫 + login 路由 | Phase 4 |
| 修改 | `frontend/src/utils/api.ts` | 401 拦截点 | Phase 4 |
| 修改 | `frontend/src/main.ts` | 注册拦截 + 启动 fetchMe | Phase 4 |
| 修改 | `frontend/src/components/Layout.vue` | 嵌入 UserMenu | Phase 4 |
| 修改 | `router/spa.js` | spaRoutes 加 /login | Phase 4 |
| 新增 | `test/auth.test.js` | 新建 | Phase 5 |
| 新增 | `docs/AUTH.md` | 新建 | Phase 6 |
| 修改 | `docs/todo/TODO.md` | 挂上本计划 | Phase 6 |

---

## 验收标准

**功能流程**

- [ ] 未登录访问 `/dashboard` → 重定向 `/login?redirect=/dashboard`
- [ ] 登录成功后 → 跳回 `/dashboard`，后续 API 自动带 Cookie
- [ ] 登录密码错误 → 表单显示错误（401），连续 5 次 → 锁定提示 + 429
- [ ] 锁定期间同 IP 无法再登录
- [ ] 顶栏显示当前用户名，点退出后回 `/login`
- [ ] `DELETE FROM admin_users;` 后重启 → 重新生成新密码并打印
- [ ] 手动 SQL `UPDATE admin_users SET password_hash = ...` 改密 → 重启后生效
- [ ] `AUTH_ENABLED=false` 时所有路由免鉴权（开发兜底）

**安全与边界**

- [ ] 首次启动（空库）→ 控制台巨幅打印明文密码 → 数据库写入账号
- [ ] 二次启动沿用上次账号
- [ ] 错误密码 hash 格式 / 错误 scrypt 参数 → `verifyPassword` 返回 false（不抛 `TypeError` 崩溃）
- [ ] Redis 中 session JSON 损坏 → `requireAuth` 返回 401（不冒泡崩溃）
- [ ] Redis 中 session 缺 `username` 字段 → `requireAuth` 返回 401（防下游 `Cannot read properties of null`）
- [ ] `res.clearCookie` 由**同一个 `getCookieOpts(req)` 工厂**生成（不允许手写 path/sameSite）→ 退出后浏览器实际清掉 Cookie（DevTools 可查）
- [ ] `app.set('trust proxy', 1)` 已设置；通过反代访问时 `req.ip` 是真实客户端 IP（限流日志可查）
- [ ] `secure` 仅看 `NODE_ENV === 'production'`（不依赖 `req.secure`）→ set/clear 参数一定一致

**前后端联调**

- [ ] `vite.config.ts` 配置 `server.proxy` 把 `/api` 和 `/hls` 代理到 `localhost:3001`
- [ ] `frontend/src/utils/api.ts` 使用相对路径 baseURL，**不**写绝对 URL
- [ ] 浏览器 DevTools Network：登录后所有 `/api/*` 请求均带 `Cookie: auth_token=...`
- [ ] 网络慢时首屏显示"正在恢复登录态…"旋转动画，不白屏
- [ ] Token 失效（手动 `redis-cli DEL auth:session:xxx`）→ 下一请求触发 401 → 自动跳 `/login?redirect=...`
- [ ] DevTools Network：冷启动**只**发一次 `GET /api/auth/me`（验证 main.ts 没和守卫并发请求）

**工程**

- [ ] `npm run lint && npm run format && npm run test` 全部通过
- [ ] `docs/AUTH.md` 存在并描述配置 / 首次启动 / 改密 / 忘密应急 / **HLS 匿名播放风险提示**

---

## 风险与回退

| 风险 | 缓解 |
| --- | --- |
| DB 不可用导致初始化失败 | fail-fast 启动失败，不静默降级；保持现状等同无鉴权运行 |
| 控制台日志被截断 / 未捕获 | 使用 `console.log`（非自定义 logger），保证 docker logs 直接可见；密码明文只在首次启动打印一次 |
| 改密操作无 UI | README 写明：手动 `node -e "require('./lib/core/auth-service').hashPassword('xxx')"` 生成 hash，SQL 更新 `admin_users.password_hash` |
| 忘密 | 应急命令：`DELETE FROM admin_users;` 后重启，自动重置 |
| session 泄漏 / 凭据泄漏 | Redis session TTL 24h，Cookie HttpOnly + SameSite=Strict；如担心可缩短 TTL |
| 误锁自己（5 次/分钟） | 锁 5 分钟；如嫌频繁可调环境变量 |
| 测试 mock 漏覆盖真实 Redis | 集成测试中清空 `auth:*` key；dev 启动可临时 `AUTH_ENABLED=false` |
| **`timingSafeEqual` 长度不一致抛 `TypeError` 崩溃** | `verifyPassword` 内部先比 `expected.length !== actual.length` 直接 false + 外层 try-catch 兜底 |
| **Redis 会话数据损坏 / 缺 username** | `requireAuth` 中间件显式校验 `session && session.username`，任一缺失返 401 |
| **跨端口开发 Cookie 不携带** | `vite.config.ts` 配 `server.proxy` 把 `/api` 代理到后端；`api.ts` 使用相对路径 baseURL（不写绝对 URL） |
| **首屏 await fetchMe 导致白屏** | 不阻塞 `app.mount`；App.vue 渲染"正在恢复登录态…"Loading；路由守卫内部再兜底拉一次 |
| **logout 后 Cookie 残留（clearCookie 参数不一致）** | 后端统一封装 `setAuthCookie(res, token, req)` / `clearAuthCookie(res, req)`，保证 path/httpOnly/sameSite/secure 完全一致 |
| **HLS 公网匿名播放** | `docs/AUTH.md` 标注风险；公网暴露时建议反代层加 `auth_request`，或限制 HLS 仅监听 `127.0.0.1` |
| **Cookie `secure` 因 `req.secure` 不可靠导致 set/clear 参数漂移** | 不依赖 `req.secure`；统一封装 `getCookieOpts(req)` 工厂，secure 直接看 `NODE_ENV === 'production'`；`app.js` 必须 `app.set('trust proxy', 1)` 让 req.ip 走 X-Forwarded-For |
| **main.ts + 路由守卫并发发 /me 请求（race condition）** | main.ts **不**手动调 `fetchMe()`，把"启动拉一次"的职责完全交给 `router.beforeEach`；App.vue 通过 `auth.ready` 响应式关闭 Loading |
| **PG `updated_at` UPDATE 不自动刷新** | 迁移里加 `BEFORE UPDATE` 触发器（`CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS` 实现幂等） |

---

## 不在本次范围

- 多用户 / 改密 UI / 用户管理
- 找回密码 / 邮箱验证 / 2FA
- 滑动验证码 / 图形验证码
- 角色权限模型（`admin` / `viewer`）—— 全部鉴权后透传 `req.auth.username` 即可
- 审计日志（"谁在何时登录"）—— 后续可加一张 `auth_logs` 表
- HLS 流 `/hls/*` 鉴权—— 仍保持现状可匿名播放（如果是自托管内网可接受）
  - **安全提示**（写进 `docs/AUTH.md`）：如果把服务通过 DDNS / FRP / 云主机等方式**公网暴露**，`/hls/*` 下的切片文件仍可被匿名拉取，**存在流量盗刷 / 资源消耗风险**。强烈建议公网暴露时：
    1. 在反代层（nginx / Caddy）上额外加 `auth_request` / `subrequest` 校验 token
    2. 或在 K-Recorder 内为 HLS 路由加 `requireAuth`（非本次范围，未来按需补）
    3. 或限制 `/hls/*` 仅监听 `127.0.0.1`、通过内网穿透暴露
