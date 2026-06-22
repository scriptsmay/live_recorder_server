# 登录鉴权

## 概述

K-Recorder 使用单管理员账号登录。首次启动时，如果 `admin_users` 表为空，系统会自动生成一组随机初始密码并打印到控制台。

## 登录方式

- 用户名 + 密码
- 登录态通过 `HttpOnly` Cookie 维持
- `AUTH_COOKIE_SECURE=true` 时仅通过 HTTPS 写入 Cookie；内网 HTTP 部署保持默认 `false`
- 登录接口：
  - `POST /api/auth/login`
  - `POST /api/auth/logout`
  - `GET /api/auth/me`

## 失败限制

- 同 IP 5 次失败 / 分钟
- 超过限制后锁定 5 分钟

## 环境变量

| 环境变量               | 说明                                                                     | 默认值       |
| ---------------------- | ------------------------------------------------------------------------ | ------------ |
| `AUTH_ENABLED`         | 登录鉴权总开关；设为 `false` 时业务路由免登录，生产环境应保持开启        | `true`       |
| `ADMIN_USERNAME`       | 首次启动自动创建管理员时使用的用户名；用户创建后修改该变量不会改库内账号 | `admin`      |
| `AUTH_TOKEN_TTL_HOURS` | 登录态 Cookie / Redis session 有效期，单位小时                           | `24`         |
| `AUTH_COOKIE_NAME`     | 登录态 Cookie 名称                                                       | `auth_token` |
| `AUTH_COOKIE_SECURE`   | 是否只允许 HTTPS 写入 Cookie；内网 HTTP 部署保持 `false`                 | `false`      |
| `LOGIN_RATE_LIMIT`     | 同一 IP 每分钟允许的登录失败次数                                         | `5`          |
| `LOGIN_LOCKOUT_MIN`    | 达到失败次数上限后的锁定时长，单位分钟；锁定期间登录接口会直接拒绝       | `5`          |

## 初始密码

首次启动时，控制台会输出初始用户名和密码。

忘记密码时可直接执行：

```sql
DELETE FROM admin_users;
```

然后重启服务，系统会重新生成管理员密码。

## 匿名访问

- `GET /api/health` 仍可匿名访问
- `/hls/*` 仍可匿名播放

如果服务暴露到公网，`/hls/*` 仍然可以被直接拉取。
