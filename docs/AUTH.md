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
