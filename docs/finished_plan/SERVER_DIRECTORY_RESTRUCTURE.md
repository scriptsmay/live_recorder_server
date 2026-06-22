## live-recorder-server 目录重构方案

### 目标

将后端 server 相关的源码目录移入 `server/` 子目录，让项目根目录更简洁，同时保持 `package.json`、`test/`、`.env` 等文件在根目录不动，最小化对现有部署流程的影响。

### 重构后的目录结构

```
live_recorder_server/
├── .github/                    # CI/CD (不动)
├── docker/                     # Docker compose (不动)
├── docs/                       # 项目文档 (不动)
├── frontend/                   # Vue 3 SPA (不动)
├── public/                     # 静态资源 + 前端构建产物 (不动)
├── scripts/                    # 运维脚本 (不动，需更新 import 路径)
├── test/                       # 测试 (不动，需更新 import 路径)
├── logs/                       # 运行日志 (不动，通过 getLogsDir() 定位)
│
├── server/                     # <-- 新建
│   ├── app.js                  # 入口 (从根目录移入)
│   ├── config/                 # 配置 (从根目录移入)
│   ├── db/                     # 数据库 (从根目录移入)
│   ├── lib/                    # 核心模块 (从根目录移入)
│   ├── middleware/              # 中间件 (从根目录移入)
│   ├── router/                 # 路由 (从根目录移入)
│   └── services/               # 服务层 (从根目录移入)
│
├── .env / .env.dev / ...      # 环境变量 (不动)
├── .gitignore / ...            # 点文件 (不动)
├── Dockerfile                  # Docker 构建 (不动，需更新 CMD)
├── ecosystem.config.js         # PM2 (不动，需更新路径)
├── eslint.config.mjs           # Lint 配置 (不动)
├── jest.config.js              # 测试配置 (不动)
├── package.json                # 依赖 (不动，需更新 scripts)
└── README.md / ...             # 文档 (不动)
```

---

### 影响范围总览

| 类别                                                   | 涉及文件数   | 改动行数    | 难度          |
| ------------------------------------------------------ | ------------ | ----------- | ------------- |
| server 内部跨边界路径 + getLogsDir()                   | 11           | ~18 行      | 低            |
| 根目录配置文件 (package.json / ecosystem / Dockerfile) | 3            | ~5 行       | 低            |
| test/ 测试文件 import 路径                             | 32           | ~120 行     | 低 (机械替换) |
| scripts/ 脚本 import 路径                              | 10           | ~28 行      | 低 (机械替换) |
| **合计**                                               | **~56 文件** | **~170 行** | —             |

server 内部的相互引用（如 `app.js` → `./config/env`、`router/` → `../lib/`、`services/` → `../db/`）**全部不需要改动**，因为它们一起移入 `server/`，相对关系不变。

---

### 详细改动清单

#### 1. server 内部：跨边界路径 + getLogsDir()（11 个文件，~18 行）

这些文件移入 `server/` 后，`__dirname` 多了一层，引用根目录资源时需要多往上跳一级。

**`server/config/env.js` (关键！)**

```diff
- const rootDir = path.join(__dirname, '..');
+ const rootDir = path.join(__dirname, '..', '..');
```

`rootDir` 用于定位 `.env` 文件（留在根目录），必须多跳一层。

**`server/config/app-info.js`**

```diff
- path.join(__dirname, '../package.json')
+ path.join(__dirname, '../../package.json')
```

**`server/router/api.js`**

```diff
- require('../package.json')
+ require('../../package.json')

- path.join(__dirname, '../docs/API.md')
+ path.join(__dirname, '../../docs/API.md')
```

**`server/router/index.js`**

```diff
- path.join(__dirname, '..', 'public', '404.html')
+ path.join(__dirname, '..', '..', 'public', '404.html')
```

**`server/router/spa.js`**

```diff
- const SPA_DIR = path.join(__dirname, '..', 'public', 'frontend');
+ const SPA_DIR = path.join(__dirname, '..', '..', 'public', 'frontend');
```

**`server/app.js`**

```diff
- app.use(express.static('public'));
+ const path = require('path');
+ app.use(express.static(path.join(__dirname, '..', 'public')));
```

改为绝对路径，避免依赖 `process.cwd()`。

**`server/config/config.js` — 新增 `getLogsDir()`**

`config.js` 已有 `getDanmakuOutputDir()` 和 `getReplayWorkDir()` 两个路径辅助函数，新增 `getLogsDir()` 统一管控日志目录，所有引用 `logs/` 的地方都通过它获取，避免各处散落 `__dirname` 多层跳跃：

```diff
+ function getLogsDir() {
+   return envs.LOG_DIR || path.join(__dirname, '..', '..');
+ }

  module.exports = {
    // ...
+   getLogsDir,
    getDanmakuOutputDir,
    getReplayWorkDir,
  };
```

`__dirname` 在移入 `server/config/` 后为 `server/config`，向上两层正好是项目根目录。如果未来需要通过环境变量覆盖日志路径，设 `LOG_DIR` 即可。

**`server/lib/core/logger.js`**

```diff
+ const { getLogsDir } = require('../../config/config');
- const logsDir = path.join(__dirname, '../../logs');
+ const logsDir = path.join(getLogsDir(), 'logs');
```

**`server/lib/utils/proc-log.js`**

```diff
+ const { getLogsDir } = require('../../config/config');
- const logsDir = path.join(__dirname, '../../', 'logs');
+ const logsDir = path.join(getLogsDir(), 'logs');
```

**`server/services/LogFileService.js`**

```diff
+ const { getLogsDir } = require('../config/config');
- constructor(logsDir = path.join(process.cwd(), 'logs'))
+ constructor(logsDir = path.join(getLogsDir(), 'logs'))
```

**`server/services/LogCleanupService.js`**

```diff
+ const { getLogsDir } = require('../config/config');
- this.logsDir = path.resolve(options.logsDir || path.join(process.cwd(), 'logs'))
+ this.logsDir = path.resolve(options.logsDir || path.join(getLogsDir(), 'logs'))
```

> 统一用 `getLogsDir()` 的好处：以后日志路径再调整只改 `config.js` 一处，不用在四个文件里分别找 `__dirname` 跳几层。

#### 2. 根目录配置文件（3 个文件，3 行）

**`package.json`** — 更新 npm scripts：

```diff
- "start": "node app.js",
+ "start": "node server/app.js",

- "dev": "PORT=3001 NODE_ENV=development node --watch app.js",
+ "dev": "PORT=3001 NODE_ENV=development node --watch server/app.js",

- "dev:backend": "PORT=3001 ... node --watch app.js ...",
+ "dev:backend": "PORT=3001 ... node --watch server/app.js ...",

- "dev:win": "set PORT=3001&& ... node --watch app.js",
+ "dev:win": "set PORT=3001&& ... node --watch server/app.js",
```

**`ecosystem.config.js`** — PM2 配置：

```diff
- script: './app.js',
+ script: './server/app.js',
```

**`Dockerfile`** — 启动命令：

```diff
- CMD ["node", "app.js"]
+ CMD ["node", "server/app.js"]
```

Dockerfile 中的 `COPY . .` 和 `WORKDIR /app` 不需要改动——源码在容器内的 `/app/server/` 下，其他路径关系不变。

#### 3. test/ 文件 import 路径（32 个文件，~120 行）

所有 `require('../xxx/...')` 统一改为 `require('../server/xxx/...')`，是纯机械替换。涉及的前缀：

| 原路径前缀        | 新路径前缀               | 涉及文件数                  |
| ----------------- | ------------------------ | --------------------------- |
| `'../lib/`        | `'../server/lib/`        | 27                          |
| `'../db/`         | `'../server/db/`         | 18                          |
| `'../services/`   | `'../server/services/`   | 12                          |
| `'../router/`     | `'../server/router/`     | 3                           |
| `'../middleware/` | `'../server/middleware/` | 1                           |
| `'../config/`     | `'../server/config/`     | 1                           |
| `'../scripts/`    | `'../server/scripts/`    | 0 (scripts/ 不移入 server/) |

注意：`jest.mock('...')` 和 `jest.requireActual('...')` 中的路径也需要同步更新。

`api-coverage.test.js` 中的 `__dirname` 路径也需更新：

```diff
- path.join(__dirname, '../router/api.js')
+ path.join(__dirname, '../server/router/api.js')
```

（共 5 处 router 文件引用）

#### 4. scripts/ 文件 import 路径（10 个文件，~28 行）

同样是机械替换，`require('../xxx/...')` → `require('../server/xxx/...')`。

涉及的文件：`cleanup-dev.js`、`dev-replay-cleanup.js`、`ensure-db.js`、`fix-segment-times.js`、`migrate-wuyan-replay-history.js`、`release.js`、`replay-cli.js`、`smoke-kuaishou-api-checker.js`、`smoke-kuaishou-checker.js`、`test-checker.js`、`transcode-missed.js`。

---

### 执行步骤

建议按以下顺序执行，用 git 跟踪每一步：

```bash
# 0. 确保工作区干净
git stash  # 或先提交当前改动

# 1. 创建 server/ 目录并移入源码
mkdir server
git mv app.js server/
git mv config server/
git mv db server/
git mv lib server/
git mv middleware server/
git mv router server/
git mv services server/

# 2. 修改 server 内部跨边界路径 + 新增 getLogsDir() (第 1 节)
# 手动编辑 env.js, config.js, app.js, router 和 4 个日志消费者

# 3. 修改根目录配置文件 (第 2 节)
# 编辑 package.json, ecosystem.config.js, Dockerfile

# 4. 批量替换 test/ 和 scripts/ 中的 import 路径 (第 3、4 节)
# 可用 sed 批量处理，见下方命令

# 5. 验证
npm test              # 跑全部测试
npm run lint          # ESLint 检查
npm run dev           # 手动验证开发服务器启动
```

**批量替换命令参考（sed）：**

```bash
# test/ 目录
sed -i '' "s|'\.\./lib/|'../server/lib/|g" test/*.test.js
sed -i '' "s|'\.\./db/|'../server/db/|g" test/*.test.js
sed -i '' "s|'\.\./services/|'../server/services/|g" test/*.test.js
sed -i '' "s|'\.\./router/|'../server/router/|g" test/*.test.js
sed -i '' "s|'\.\./middleware/|'../server/middleware/|g" test/*.test.js
sed -i '' "s|'\.\./config/|'../server/config/|g" test/*.test.js

# api-coverage.test.js 的 __dirname 路径
sed -i '' "s|__dirname, '\.\./router/|__dirname, '../server/router/|g" test/api-coverage.test.js

# scripts/ 目录
sed -i '' "s|'\.\./lib/|'../server/lib/|g" scripts/*.js
sed -i '' "s|'\.\./db/|'../server/db/|g" scripts/*.js
sed -i '' "s|'\.\./services/|'../server/services/|g" scripts/*.js
sed -i '' "s|'\.\./config/|'../server/config/|g" scripts/*.js
```

---

### 可选的附带优化

这些不是必须的，但既然在做目录重构，可以顺便处理：

1. **修复 `PollingManager.js` 中的冗余路径**：`require('../../../lib/utils/platform-detector')` → `require('../../utils/platform-detector')`（同目录内的引用不需要跳到根目录再回来）

2. **修复 `watchdog.js` 中的冗余路径**：`require('../core/downloaders/DownloaderFactory')` → `require('./downloaders/DownloaderFactory')`

3. **将 `scripts/` 中纯后端脚本（如 `ensure-db.js`、`transcode-missed.js`）也移入 `server/scripts/`**，进一步精简根目录。但运维相关的 shell 脚本（`docker-entrypoint.sh`、`replay-cron.sh`）建议留在根目录 `scripts/`。

---

### 风险点

1. **Docker 构建**：Dockerfile 的 `COPY . .` 会把 `server/` 整体复制进容器的 `/app/server/`。`CMD` 更新后应该没问题，但需要重新构建验证。

2. **docker-compose volumes**：`../logs:/app/logs` 的映射关系不受影响（映射的是运行时目录，不是源码目录）。

3. **生产环境更新**：代码合并后需要重新 `docker compose pull && docker compose up -d`，建议在 staging 环境先验证。

4. **ESLint / Prettier**：`eslint.config.mjs` 的 `files: ['**/*.{js,mjs,cjs}']` 是通配模式，会自动匹配 `server/` 下的文件，不需要改。
