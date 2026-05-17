# live_recorder_server

一个基于 nodejs express 的轻量直播录制服务器

- 使用 pm2 进行进程管理
- 支持 ffmpeg 和 stream-gears 下载引擎
- 自动监控录制状态，支持断点续录

## 启动

```bash
# install dependencies
npm install

# 开发模式 (端口 3001)
npm run dev

# 生产模式
npm start

# 停止服务
npm run stop
```

## 配置

本地配置在 `.env` 中，参考 `.env.example` 文件。

### 数据库配置

| 配置项          | 说明             | 默认值           |
| --------------- | ---------------- | ---------------- |
| DB_HOST         | 数据库主机       | localhost        |
| DB_PORT         | 数据库端口       | 5432             |
| DB_NAME         | 数据库名称       | ks_live_recorder |
| DB_USER         | 数据库用户名     | postgres         |
| DB_PASSWORD     | 数据库密码       | -                |
| DB_POOL_MAX     | 连接池最大连接数 | 20               |
| DB_POOL_MIN     | 连接池最小连接数 | 2                |
| DB_IDLE_TIMEOUT | 连接空闲超时(ms) | 30000            |

### Redis 配置

| 配置项     | 说明             | 默认值    |
| ---------- | ---------------- | --------- |
| REDIS_HOST | Redis 主机       | localhost |
| REDIS_PORT | Redis 端口       | 6379      |
| REDIS_DB   | Redis 数据库编号 | 1         |

## 项目结构

```
├── app.js                 # 主入口文件
├── lib/                   # 核心模块
│   ├── logger.js          # 结构化日志（Winston）
│   ├── response.js        # 统一 API 响应工具
│   ├── redis-service.js   # Redis 统一服务层
│   ├── downloaders/       # 下载引擎实现
│   └── watchdog.js        # 看门狗监控
├── router/                # API 路由
├── db/                    # 数据库连接
├── views/                 # EJS 模板
├── public/                # 静态资源
├── test/                  # 单元测试
└── docs/                  # 项目文档
```

## 测试

```bash
# 运行所有测试
npm test

# 监听模式
npm run test:watch

# 覆盖率报告
npm run test:coverage
```

## 代码规范

```bash
# ESLint 检查
npm run lint

# Prettier 格式化
npm run format
```
