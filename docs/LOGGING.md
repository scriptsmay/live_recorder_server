# 日志系统开发文档（Logging）

> 状态：**已实现**。模块级日志方案已落地并合入代码：
>
> - `server/lib/core/logger.js` 新增 `createModuleLogger(fileName, options)`；
> - `PollingManager`、各平台 `Checker`、`signers` 与 `watchdog` 已接入（日志拆分到 `logs/polling.log` / `logs/watchdog.log`）；
> - 单元测试用例见 `test/logger.test.js` 的 `describe('createModuleLogger')`。
>   **`event()` API 不在本阶段落地**，已移至第 13 节「下一阶段 TODO」。

## 1. 背景与目标

当前 `server/lib/core/logger.js` 通过**全局覆写 `console.log/warn/error`**，
把所有模块的日志汇聚到通用文件 `logs/server.log`（仅 `production` 落盘）。
`access.log` 由 morgan 通过同一 `createRotatingStream` 引擎写入。

带来的问题：

- 轮询（`PollingManager`）、看门狗（`watchdog`）等高频模块的日志和「通用
  server 日志」混在同一个 `server.log` 里，排查单个子系统时要靠 grep 前缀
  （`[PollingManager]`、`[看门狗]`）手动过滤，效率低。
- 看门狗每 30s 一轮、每次会逐分段打印，体量很大，会稀释 `server.log` 里其他
  有价值的信息（如启动流程、关键错误）。
- 轮询默认每 30~60s 一轮，若每轮都 `INFO`，`server.log` 一天会被上千条
  「idle 检查」淹没。

目标：

- 把**特定模块**的**高频 / 细节**日志拆到**独立的、按日期轮转**的日志文件
  （如 `logs/polling.log`、`logs/watchdog.log`）。
- 但**不牺牲 `server.log` 的关键信号**：ERROR / WARN / 生命周期关键 INFO
  仍按原链路镜像进 `server.log`（详见第 5 节镜像规则）。
- 对轮询这类**高频任务**做**状态降级**：idle 检查降级为默认关闭的 `DEBUG`，
  只在状态变化 / 异常 / 首次监控时才打 INFO（详见第 8 节）。
- 复用已有的 `createRotatingStream` 轮转引擎（日期 + 大小双维度，已有单测覆盖），
  **不重复造轮子**。
- **保留开发期终端可见性**：模块日志在终端照常打印、带时间戳，调试体验不变。

## 2. 现有日志文件：server.log 与 access.log

在引入模块级日志之前，项目只有两类文件日志，均由 `server/lib/core/logger.js`
统一管理。理解它们，是确认「本次改动不影响原有系统」的前提。

### 2.1 server.log — 应用主日志（catch-all）

- **来源**：`logger.js` 在模块加载时**全局覆写** `console.log/warn/error`。覆写函数在
  `NODE_ENV === 'production'` 时调用 `logToFile()`，把**全应用所有模块**的
  `console.*` 输出汇聚写入 `logs/server.log`。
- **内容**：所有业务代码里通过 `console.log/warn/error` 打印的日志（开播通知、数据库
  错误、启动信息等），**不区分模块**。
- **落盘时机**：仅 `production`。开发期 `console.*` 只在终端打印，不写文件。
- **轮转**：`createRotatingStream('server')` —— 日期 + 大小双维度，与模块日志同源。

### 2.2 access.log — HTTP 访问日志

- **来源**：`configureAccessLogger()` 用 morgan 中间件记录每次 HTTP 请求，写入
  `logs/access.log`（同样走 `createRotatingStream('access')`）。
- **内容**：请求方法、URL、状态码、响应耗时（`production` 格式
  `:local-date | :method :url :status :response-time ms`）。
- **落盘时机**：随 morgan 配置生效（开发期格式为 `dev`，同样写文件）。
- **与业务日志的区别**：它记录的是「请求流量」，不是业务模块的 `console` 输出，
  二者互不重叠。

### 2.3 本次改动与现有系统的关系（重要）

> **仅分离高频日志，不丢失关键信号，不影响原有日志系统。**

`createModuleLogger` 是**新增的并行通道**，不修改任何既有逻辑：

- 全局 `console` 覆写、`logToFile`、`server.log` 的写入链路 —— **保持原样**。
- morgan 集成、`access.log` —— **保持原样**。
- `createRotatingStream` 引擎 —— **复用**，未改动。

行为变化是**预期内**的、且是**部分**的：被显式接入 `createModuleLogger` 的模块
（`PollingManager`、`watchdog`）中——

- **高频 INFO / 心跳类日志 / idle 检查**：只写自己的模块文件（如 `polling.log`），
  **不再**进 `server.log`（这正是「分离」的目的，避免稀释主日志）。
- **ERROR / WARN / 生命周期关键 INFO**：**仍**按原链路镜像进 `server.log`，
  保证主日志不丢失关键信号。

**其余所有模块**的 `console` 输出、`access.log` 的访问记录，与改动前**完全一致**，
不受任何影响。

### 2.4 与前端日志查看器的兼容性

`LogFileService` 和日志 API（`/api/logs/files`、`/api/logs/content`、`/api/logs/stream`）
基于 `logs/` 目录扫描 `.log` 文件，**无需改动即可兼容模块日志**：

- **文件列表**：`GET /api/logs/files` 自动发现 `polling.log`、`watchdog.log` 等新文件，
  前端日志页面可直接在下拉框中选择查看。
- **内容读取**：`GET /api/logs/content` 按文件名读取，模块日志与 `server.log` 格式一致
  （`时间戳 | [级别] 消息`），前端无需额外解析。
- **SSE 实时流**：`GET /api/logs/stream` 按 1s 间隔轮询文件末尾，模块日志同样支持
  实时推送。但需注意：若同时开启多个模块的 SSE 流，轮询频率会叠加（每模块 1s 一次
  `fs.stat` + `read`），当前体量（2~3 个模块）无性能问题。
- **日志删除**：`DELETE /api/logs` 对模块日志同样生效，与 `LogCleanupService` 的保护
  名单一致（`access.log`、`server.log` 受保护，其余可删）。

> 前端如需按模块筛选日志，只需在 UI 的文件选择器中展示 `listFiles()` 返回的完整列表，
> 无需新增 API 或后端逻辑。

## 3. 总体架构：两级日志

```
                    ┌─────────────────────────────────────────────┐
                    │            server/lib/core/logger.js        │
                    └─────────────────────────────────────────────┘
                                       │
        ┌──────────────────────────────┴───────────────────────────────┐
        │ ① 通用日志（全局 console 覆写驱动）                            │
        │    server.log / access.log                                    │
        │    - 所有 console.log/warn/error 汇聚于此（server.log）         │
        │    - 仅 NODE_ENV=production 时落盘（开发期只在终端）           │
        │    - 轮转：createRotatingStream('server' / 'access')          │
        └──────────────────────────────┬───────────────────────────────┘
                                       │
        ┌──────────────────────────────┴───────────────────────────────┐
        │ ② 模块级日志（createModuleLogger 驱动，本方案新增）            │
        │    logs/{module}.log（如 polling.log / watchdog.log）          │
        │    - 任意模块一行接入，独立文件、独立轮转                       │
        │    - 仅 NODE_ENV=production 时落盘（与 server.log 一致）        │
        │    - 终端始终打印（带时间戳）                                   │
        │    - 按级别镜像：ERROR/WARN/重要INFO → 仍进 server.log；        │
        │      高频INFO/心跳 → 仅模块文件，不进 server.log                │
        └───────────────────────────────────────────────────────────────┘
```

两级共享同一个 `createRotatingStream` 引擎，因此轮转/保留语义完全一致。

## 4. 为什么需要 `origConsole`（设计问答）

`logger.js` 在模块加载时做了全局覆写：

```js
['log', 'warn', 'error'].forEach((method) => {
  const orig = console[method];
  console[method] = (...args) => {
    orig(`${ts()} |`, ...args); // ① 终端打印
    if (process.env.NODE_ENV === 'production') {
      logToFile(method, ...args); // ② 同时写入 server.log
    }
  };
});
```

即在 `production` 下，**任何 `console.log/warn/error` 都会自动镜像进 `server.log`**。

模块日志器需要把**不同级别**的消息分别路由：高频 INFO 不能进 `server.log`，
而 ERROR/WARN/重要 INFO 必须进 `server.log`。因此方案在覆写**之前**捕获原始
`console` 引用：

```js
// 保存被覆盖前的原始 console 方法，供模块级日志器用于「只写文件+终端」路径，
// 避免再次触发全局覆盖逻辑而重复写入 server.log
const origConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
```

模块日志器据此走**两条路径**（实现细节见第 5 节）：

- **路径 A（高频 INFO / DEBUG）**：用 `origConsole` 打终端 + 写模块文件，**绕开**
  `logToFile` 的 server.log 写入路径 —— 高频日志因此不会稀释主日志。
- **路径 B（ERROR/WARN/重要 INFO）**：用全局 `console.error/warn/log` 触发既有链路，
  由全局覆写负责「终端 + 生产期 server.log」，模块日志器只需再写一份模块文件。

两条路径都只打印一次终端，互不重复。

### 双路径的取舍对比

| 方案                                          | 开发期终端      | 生产期 server.log                             | 结论                                  |
| --------------------------------------------- | --------------- | --------------------------------------------- | ------------------------------------- |
| 本方案（origConsole 走 A，全局 console 走 B） | 可见 + 带时间戳 | 仅 ERROR/WARN/重要INFO 进入，高频 INFO 不进入 | ✅ 既保留关键信号，又避免主日志被稀释 |
| 模块日志器全程用被覆写的 `console.*`          | 可见 + 带时间戳 | **所有** INFO 都重复写入 server.log           | ❌ 违背「分离高频日志」的目标         |
| 模块日志器完全不打印终端                      | 不可见          | 不重复                                        | ❌ 牺牲调试                           |

结论：采用「origConsole + 全局 console 双路径」。它并非「剥夺」调试便利，
而是**在保留终端可见性的同时，让 server.log 只保留值得关注的关键信号**。

## 5. API：`createModuleLogger(fileName, options)`

```js
const { createModuleLogger } = require('../../lib/core/logger'); // 路径随调用方位置调整
const log = createModuleLogger('polling');

log.info('高频/心跳 INFO（仅模块文件）');
log.important('生命周期关键 INFO（模块文件 + server.log）');
log.warn('警告（模块文件 + server.log）');
log.error('错误（模块文件 + server.log）');
log.debug('调试细节（默认不输出，需开启 debug）');
```

- **参数**
  - `fileName` _(string)_：日志文件基础名（不含扩展名），同时作为文件标识。
    例如 `'polling'` → `logs/polling.log`。不得与已有日志文件同名（`server`、`access`），
    否则会导致写入冲突。
  - `options` _(Object, 可选)_：
    - `debug` _(boolean, 默认 `false`)_：是否输出 `log.debug` 内容。
    - `mirrorToServer` _(boolean, 默认 `true`)_：`important`/`warn`/`error`
      是否同时镜像进 `server.log`。设为 `false` 时该模块日志**仍打印终端 + 写模块文件**，
      只是不镜像 `server.log`，适用于希望完全隔离主日志的模块。终端打印不受此选项影响
      （见「终端行为」）。通常无需修改。
    - 其余字段透传给 `createRotatingStream`，通常**无需传**。
      测试时可传 `{ logDir, maxFileSize, maxBackupsPerDay, retentionDays, now }`。
- **返回值**：`{ info, important, warn, error, debug }`，与 `console` 同签名（可变参数）。
- **文件行格式**：`时间戳 | [级别] <消息>`，与现有 `logToFile` 一致；对象序列化为 JSON。
- **server.log 镜像规则（核心设计）**：

  | 方法        | 模块文件 | server.log | 用途                                                     |
  | ----------- | -------- | ---------- | -------------------------------------------------------- |
  | `info`      | ✅       | ❌         | 高频 INFO、心跳、逐分段细节等「会稀释主日志」的内容      |
  | `important` | ✅       | ✅         | 生命周期关键 INFO（进程启停、录制开始/结束、状态转换等） |
  | `warn`      | ✅       | ✅         | 警告                                                     |
  | `error`     | ✅       | ✅         | 错误                                                     |
  | `debug`     | 条件     | ❌         | 调试细节（如逐轮 idle 检查）；默认关闭，不进 server.log  |

  > `debug` 默认**不输出**（既不写模块文件也不打终端），需通过 `options.debug: true`
  > 或环境变量 `LOG_MODULE_DEBUG` 开启，用于临时排查高频细节。
  > 环境变量支持逗号分隔多模块（`LOG_MODULE_DEBUG=polling,watchdog`）或通配符
  > `LOG_MODULE_DEBUG=*`（开启所有模块的 debug）。

- **终端行为**：始终打印（带时间戳）。`info`/`debug` 经 `origConsole`（不触发 server.log）；
  `important/warn/error` 经全局 `console`（生产期同时进 server.log）；当 `mirrorToServer:false`
  时 `important/warn/error` 改走 `origConsole`（仅终端、不进 server.log）。**不会重复打印终端**。
- **文件写入时机**：仅 `NODE_ENV === 'production'` 落盘（与 `server.log` 一致）。开发期
  只在终端打印、不写模块文件。实现上 `createModuleLogger` 内部对 `info/important/warn/
error/debug` 的文件写入分支均加 `if (process.env.NODE_ENV === 'production')` 判断。

#### 5.1 级别路由（Level Routing）

每个级别按如下规则分流——**高频 INFO 只进模块文件，关键信号同时进 server.log**：

```
log.info(msg)
    │
    └──► 模块文件 only          （logs/polling.log / logs/watchdog.log）
          · 高频 INFO / 心跳 / idle 检查 / 逐项明细
          · 不进 server.log（避免稀释主日志）

log.important(msg)
    │
    └──► 模块文件 + server.log  （生命周期关键 INFO：进程启停、录制开始/结束、状态转换…）

log.warn(msg)
    │
    └──► 模块文件 + server.log  （警告）

log.error(msg)
    │
    └──► 模块文件 + server.log  （错误）

log.debug(msg)
    │
    └──► 默认无输出            （需 options.debug / LOG_MODULE_DEBUG 开启）
          · 开启后仅写模块文件，不进 server.log
```

### 实现骨架（参考）

```js
function createModuleLogger(fileName, options = {}) {
  // 错误降级：stream 创建失败时不阻塞模块启动，fallback 到纯终端输出
  let stream = null;
  try {
    stream = createRotatingStream(fileName, options);
  } catch (err) {
    origConsole.error(`[ModuleLogger] Failed to create stream for "${fileName}":`, err.message);
    // 返回空操作日志器，所有方法仅打终端
    return {
      info: (...args) => origConsole.log(`${ts()} |`, ...args),
      important: (...args) => console.log(...args),
      warn: (...args) => console.warn(...args),
      error: (...args) => console.error(...args),
      debug: () => {},
    };
  }

  const mirrorToServer = options.mirrorToServer !== false; // 默认 true
  const debugEnv = process.env.LOG_MODULE_DEBUG || '';
  const debugEnabled =
    options.debug === true ||
    debugEnv === '*' ||
    debugEnv
      .split(',')
      .map((s) => s.trim())
      .includes(fileName);

  const prod = process.env.NODE_ENV === 'production'; // 落盘时机与 server.log 一致

  // 路径 A：仅模块文件 + 终端（绕过 server.log）
  const writeFileOnly = (level, args) => {
    origConsole[level](`${ts()} |`, ...args); // 终端（始终）
    if (prod) stream.write(formatLine(level, args)); // 模块文件（仅 production）
  };

  // 路径 B：模块文件 + 终端 + 镜像 server.log（复用全局覆写链路）
  const writeAndMirror = (level, args) => {
    if (prod) stream.write(formatLine(level, args)); // 模块文件（仅 production）
    if (mirrorToServer) console[level](...args); // 终端 + 生产期 server.log
  };

  return {
    info: (...args) => writeFileOnly('log', args), // 高频 INFO：不镜像
    important: (...args) => writeAndMirror('log', args), // 重要 INFO：镜像
    warn: (...args) => writeAndMirror('warn', args), // 警告：镜像
    error: (...args) => writeAndMirror('error', args), // 错误：镜像
    debug: (...args) => {
      // 调试：默认关闭
      if (!debugEnabled) return;
      origConsole.log(`${ts()} |`, ...args); // 终端（始终）
      if (prod) stream.write(formatLine('debug', args)); // 模块文件（仅 production）
    },
  };
}
```

## 6. 轮转机制（沿用 `createRotatingStream`）

以 `polling` 为例：

```
logs/polling.log                 ← 当前写入
logs/polling.2026-08-04.log      ← 跨天归档
logs/polling.2026-08-04.1.log    ← 当天单文件超过 maxFileSize 后，按序号备份
logs/polling.2026-08-04.2.log
...
```

- **跨天**：当前文件重命名为 `{fileName}.YYYY-MM-DD.log`。
- **当天超限**：单文件 > `maxFileSize` 时，归档为 `{fileName}.YYYY-MM-DD.1.log`，
  超出 `maxBackupsPerDay` 的旧备份会被删除（每日最多保留 N 个大小备份）。
- **保留期**：由 `ROTATION_DEFAULTS.retentionDays` 控制，默认 `null`（不自动删除）。
- 当前 `ROTATION_DEFAULTS`：

  | 配置项             | 默认值                    | 说明                          |
  | ------------------ | ------------------------- | ----------------------------- |
  | `maxFileSize`      | `10 * 1024 * 1024` (10MB) | 单文件大小上限                |
  | `maxBackupsPerDay` | `5`                       | 每日期大小备份上限            |
  | `retentionDays`    | `null`                    | 保留天数；`null` = 不自动清理 |

### 6.1 与 `LogCleanupService` 的交互

模块日志文件（`polling.log`、`watchdog.log` 等）与 `server.log`、`access.log`
位于同一 `logs/` 目录，因此受 `LogCleanupService` 统一管控：

- **保留策略**：`LogCleanupService` 默认按 `log_retention_days`（设置表，默认 30 天）
  清理过期归档。模块日志的归档文件（如 `polling.2026-08-04.log`）与 `server.log`
  的归档适用相同规则。
- **保护名单**：`LogCleanupService` 默认只保护 `access.log` 和 `server.log`（当前写入文件
  不被误删）。模块日志的当前写入文件（如 `polling.log`）通过 `activeWindowMs`（5 分钟）
  保护——只要最近有写入就不会被清理。
- **容量上限**：`LogCleanupService` 在保留期清理后，若总日志体积仍超过 `maxTotalSize`
  （默认 1GB），会按修改时间从旧到新删除非保护文件，模块日志同样参与此流程。
- **`ROTATION_DEFAULTS.retentionDays` vs `LogCleanupService`**：前者是
  `createRotatingStream` 内部的轮转保留期（默认 `null`，不自动删），后者是应用层的
  统一清理策略（默认 30 天）。两者不冲突——模块日志的归档文件最终由 `LogCleanupService`
  的保留天数和容量上限统一管控。

> 如需对某个模块日志设更短/更长的保留期，可在 `createModuleLogger` 的 `options` 中
> 传 `retentionDays`，`createRotatingStream` 会在轮转时按此值额外清理。

## 7. 接入一个模块（步骤）

### 迁移工作量参考

当前 `server/` 目录下共有约 **385 处** `console.log/warn/error` 分布在 **48 个文件**中。
首批接入的两个模块涉及：

| 模块                                 | 文件数 | `console.*` 调用数 | 说明                                                                                                                               |
| ------------------------------------ | ------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PollingManager`（含各平台 Checker） | 8      | 60                 | `PollingManager.js`(27)、`HuyaChecker.js`(9)、`DouyinChecker.js`(9)、`DouyuChecker.js`(8)、`BilibiliChecker.js`(1)、`signers/*`(6) |
| `watchdog`                           | 1      | 32                 | `watchdog.js` 单文件                                                                                                               |

后续批次可按需扩展：`TranscodeQueue`(27)、`RecorderService`(45)、`FileCleanupScheduler`(18)、
`RecordingManager`(14) 等模块的 console 调用量较高，适合优先接入。

### 接入步骤

1. **取日志器实例**（注意 `require` 相对路径，PollingManager 比 watchdog 深一层）：

   ```js
   // server/lib/core/polling/PollingManager.js（位于 core/polling 下）
   const { createModuleLogger } = require('../core/logger');
   const log = createModuleLogger('polling');

   // server/lib/core/watchdog.js（位于 core 下）
   const { createModuleLogger } = require('../../lib/core/logger');
   const log = createModuleLogger('watchdog');
   ```

2. **替换日志调用并分类级别**：把文件内 `console.log / console.warn / console.error`
   替换为模块日志器方法，并按语义分类：
   - `console.error` → `log.error`（镜像 server.log）
   - `console.warn` → `log.warn`（镜像 server.log）
   - `console.log`（**生命周期/关键**信息，如启动录制、状态转换、进程启停、轮询首次监控）→ `log.important`（镜像 server.log）
   - `console.log`（**高频/心跳/细节**，如每轮轮询结果、每分段追踪、碎片清理明细、idle 检查）→ `log.info` 或 `log.debug`（**不**镜像 server.log；idle 检查建议用 `log.debug` 默认关闭，见第 8 节）
     消息里已有的 `[PollingManager]` / `[看门狗]` 等前缀**保留**（模块文件名只决定文件名，不重复加前缀）。

3. **验证**：`npx jest test/logger.test.js` + `npx eslint <改动文件>`。

## 8. 高频模块日志降级策略

轮询、看门狗都属于**高频任务**：若每个周期 / 每个文件 / 每个分段都打 `INFO`，
`server.log` 与对应模块日志会被海量细节淹没。通用原则是**「周期级 / 状态级用
`important`（镜像 `server.log`），逐项明细降级为默认关闭的 `DEBUG`」**。
下面分别给出两个模块的落法。

### 8.1 PollingManager

轮询是**高频任务**（默认每 30~60s 一轮）。若每轮都 `INFO`，`server.log` 与
`polling.log` 都会被海量「idle 检查」淹没。因此 PollingManager 接入时采用
**状态降级**策略（与第 5 节镜像规则配合）：

- **首次开始监控某房间**：`log.important('开始监控 <房间名>')` —— 关键生命周期事件，
  进 `polling.log` + `server.log`。
- **之后每轮 idle 检查**：`log.debug('状态检查 <房间名> idle')` —— 降级为 `DEBUG`，
  默认**不输出**（需开启 `debug` 才写入 `polling.log`），彻底避免噪声。
- **检测到状态变化**（idle ↔ live）：`log.important('直播状态变化: false -> true')`
  —— 真正的业务信号，进 `polling.log` + `server.log`。
- **异常**（API 失败、解析错误等）：`log.warn('API失败: ...')` —— 进 `polling.log` + `server.log`。

效果示意（以监控房间「KSG子旗」为例）：

```
INFO  [PollingManager] 开始监控 KSG子旗          ← important（首轮，进 server.log）
DEBUG 状态检查 KSG子旗 idle                      ← debug（默认不输出）
DEBUG 状态检查 KSG子旗 idle                      ← debug（默认不输出）
...
INFO  [PollingManager]                           ← important（状态变化，进 server.log）
直播状态变化:
false -> true
WARN  [PollingManager] API失败: ...              ← warn（异常，进 server.log）
```

日志量对比（假设 60s 一轮、一天运行）：

- **旧**：每轮 1 条 INFO → 约 1440 条/天 全进 `server.log`。
- **新**：仅「开始监控」(1 条) + 「状态变化」(极少) + 「异常」(偶发) 进 `server.log`，
  idle 检查降级为默认关闭的 `DEBUG` → `server.log` 噪声下降 **90%+**。

> 需要排查某房间轮询细节时，临时开启 debug：
> `createModuleLogger('polling', { debug: true })` 或通过环境变量
> `LOG_MODULE_DEBUG=polling,watchdog` 同时开启多个模块的 debug，
> idle 检查即写入 `polling.log`。

### 8.2 Watchdog

看门狗每次扫描会遍历大量文件 / 分段；若每个文件的检查、每段状态都 `INFO`，
`server.log` 与 `watchdog.log` 会被逐文件、逐分段的明细淹没。采用与 8.1 相同的降级策略：

- **扫描开始**：`log.important('扫描开始')` —— 周期起点（关键生命周期节点），
  进 `watchdog.log` + `server.log`。
- **扫描结束**：`log.important('扫描完成 耗时 xx ms')` —— 关键汇总（含耗时），
  进 `watchdog.log` + `server.log`。
- **逐文件状态 / 逐分段明细**：`log.debug('文件 xxx 状态 ...')` / `log.debug('分段 xxx')`
  —— 降级为 `DEBUG`，默认**不输出**（需开启 `debug` 才写入 `watchdog.log`）。
- **异常**（僵死进程、清理失败等）：`log.warn(...)` / `log.error(...)` —— 进 `server.log`。

效果示意：

```
INFO  [看门狗] 扫描开始                              ← important（进 server.log）
DEBUG 文件 /path/xxx.ts 状态: ...                   ← debug（默认不输出）
DEBUG 分段 xxx                                       ← debug（默认不输出）
...
INFO  [看门狗] 扫描完成 耗时 1234ms                  ← important（进 server.log）
```

日志量对比（假设每次扫描涉及 N 个文件、M 个分段）：

- **旧**：每轮 `(N + M)` 条 INFO 全进 `server.log`。
- **新**：仅「扫描开始」「扫描完成」进 `server.log`，逐文件/分段明细降级为默认关闭的
  `DEBUG` → 噪声同样下降 **90%+**。

> 排查看门狗扫描细节时，临时开启 debug：
> `createModuleLogger('watchdog', { debug: true })` 或通过环境变量
> `LOG_MODULE_DEBUG=polling,watchdog` 同时开启多个模块的 debug，
> 明细即写入 `watchdog.log`。

## 9. 已规划接入的模块

| 模块             | 日志文件            | 说明                                                                                                                                                                              |
| ---------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PollingManager` | `logs/polling.log`  | 轮询检测 / 开播触发录制日志；高频 idle 检查降级为默认关闭的 `DEBUG`，ERROR/WARN/状态变化/首次监控仍镜像 `server.log`（见第 8 节）                                                 |
| `watchdog`       | `logs/watchdog.log` | 僵死检测 / 分段追踪 / 碎片清理 / 文件同步等；扫描开始/完成用 `important`（进 server.log），逐文件/分段明细降级为默认关闭的 `DEBUG`，ERROR/WARN 仍镜像 `server.log`（见第 8.2 节） |

> 其他模块（如 `transcoder`、`lifecycle`）如需同样拆分，照第 7 节一行接入即可，
> 无需改动 `logger.js`。

## 10. 与 `proc-log` 的关系（为什么不合并）

`server/lib/utils/proc-log.js` 是**另一类用途**，不应合并：

- 它服务于**子进程原始输出**（ffmpeg / biliup / 回放等），每个实例对应一个进程，
  文件名是 `{name}_{id}.log`（带随机 id 或传入 id），如 `logs/replay_{recordId}.log`。
  历史上还产生过 `logs/*_burn*.log`（弹幕压制），v1.8.0 起该功能迁至 danmaku-tool，本服务不再产出。
- 只有**按大小**滚动（>10MB 就 `rename` 成 `_rotated_时间戳`），没有日期维度、
  没有级别标签、不回显终端。
- 它的调用契约（按 id 命名、可 `rename`/`destroy`）被现有业务依赖，**改动有风险**。

模块级日志是「结构化、带级别、按日期轮转、终端可见」的子系统日志，两者职责不同。
本方案在 `logger.js` 上新增 `createModuleLogger` 复用 `createRotatingStream`，
`proc-log` 保持不动。

## 11. 测试

`test/logger.test.js` 中新增 `describe('createModuleLogger')`：

- 验证 `info` 写入独立 `polling.log`、对象被 JSON 化，且**不**出现在 `server.log`。
- 验证 `error` / `important` 写入独立 `polling.log` **且**经全局覆写（`server.log` 链路）——
  可在测试中注入 `NODE_ENV=production` 后断言 `server.log` 也包含该消息。
- 验证 `debug` **默认不输出**：未开启 `debug` 时，`log.debug(...)` 既不写模块文件也不打终端；
  开启 `options.debug: true` 后写入模块文件且**不**进 `server.log`。
- 验证 `LOG_MODULE_DEBUG` 环境变量：逗号分隔（`polling,watchdog`）同时开启两个模块的
  debug；通配符 `*` 开启所有模块的 debug。
- 验证 `createRotatingStream` 抛异常时的**错误降级**：模块日志器仍可正常调用，
  所有方法仅打终端、不写文件，且启动时输出一条 `[ModuleLogger] Failed to create stream` 错误。
- 验证 `mirrorToServer: false` 时，`important`/`warn`/`error` 仍写模块文件 + 打印终端，
  但不触发全局 `console` 覆写（即不进 `server.log`）。
- 验证跨天（`now` 注入）后旧内容归档为 `polling.YYYY-MM-DD.log`，新内容继续写
  `polling.log`。
- 复用 `createRotatingStream` 既有的日期/大小/保留期单测。
- **落盘时机（production 门控）**：模块日志文件写入仅在 `NODE_ENV === 'production'` 生效
  （与 `server.log` 一致）。测试时：
  - 验证 **production 下** `info/important/warn/error` 写入 `polling.log`；`debug` 需开启后写入；
  - 验证 **非 production 下** 仅打印终端、**不**产生 `polling.log` 文件
    （可在测试中 `delete process.env.NODE_ENV` 后断言 `polling.log` 不存在）。

## 12. 决策记录（review 已确认）

本阶段方案的 4 个关键决策，已在 review 中确认：

1. **文件写入时机（已决策）**：模块日志**仅 `NODE_ENV === 'production'` 落盘**，
   与 `server.log` 完全一致；开发期只在终端打印、不写模块文件（`createModuleLogger`
   内部对文件写入分支统一加 `if (prod)` 门控，见第 5 节实现骨架）。
   `logs/` 目录已在 `.gitignore` 中，不会污染仓库。
2. **server.log 镜像粒度（已确认）**：ERROR/WARN/生命周期关键 INFO **仍**镜像进
   `server.log`，高频 INFO / 心跳 / idle 检查 **不**进。分级合理，`important` 级别
   边界（见第 7 节步骤 2）可落地。
3. **`debug` 默认关闭（已确认）**：idle 检查等高频细节默认不输出；开启方式支持
   `options.debug: true`、环境变量逗号分隔多模块（`LOG_MODULE_DEBUG=polling,watchdog`）
   与通配符（`LOG_MODULE_DEBUG=*`），符合预期。
4. **保留期（已确认，对接现有 `log_retention_days`）**：**数据库 `settings` 表已存在
   `log_retention_days`（默认 `30`，可通过设置页 UI 修改，见 `frontend/src/views/Settings.vue`
   的 `log_retention_days` 项）。** 该设置被 `LogCleanupService` 读取，统一清理 `logs/`
   目录下超过保留期的 `.log` 文件（默认 30 天 + 1GB 容量上限兜底）。因此：
   - `ROTATION_DEFAULTS.retentionDays` 保持 `null`（不在 `createRotatingStream` 内部
     重复做删除），**统一由 `LogCleanupService` 按 `log_retention_days` 管控**——
     模块日志（`polling.log` / `watchdog.log` 及其归档）与 `server.log` 的保留策略
     **单一来源**，无需为模块日志单独新增设置项。
   - `LogCleanupService` 的 `protectedFiles = ['access.log', 'server.log']` 仅保护
     这两个通用日志不被「按保留期删除」；模块日志**不受保护**，超过 `log_retention_days`
     后会被正常清理（符合预期）。当前写入中的模块日志文件因 `activeWindowMs`（5 分钟）
     保护，不会被误删。
   - 若未来某模块需要**不同于全局**的保留期，再单独在 `createModuleLogger` 的
     `options` 传 `retentionDays`（届时 `createRotatingStream` 会在轮转时按该值额外清理）。

## 13. 下一阶段 TODO（待细化）

以下能力**不在本阶段落地**，留待后续细化后再设计 / 实现。

### 13.1 `event()` 结构化业务事件 API

- **动机**：直播录制系统有大量「离散业务事件」值得单独标记并便于日后统计，如：
  开播（`直播开始`）、录制开始/结束、状态变化等。当前 `important` 虽能承载，
  但缺少统一的「类型 + 结构化字段」形态，不利于 grep / 聚合统计
  （如「统计某房间某日开播次数」）。
- **设计草案（本阶段仅记录，未定稿）**：
  - 新增 `log.event(type, data)`：写模块文件（INFO 级别），并以 `[<module>:event]` 标记 +
    类型 + `key=value` 字段单行呈现。
  - 示例：`log.event('直播开始', { roomId, platform })` →
    `INFO [polling:event] 直播开始 roomId=xxx platform=huya`。
  - 路由设想：同 `important`（模块文件 + server.log），使主日志也有统一事件流；
    或仅写模块文件（不进 server.log）——**待定**。
- **待细化问题**：
  1. 事件是否应当镜像进 `server.log`？
  2. `key=value` 单行格式是否满足统计需求（如 `grep ':event' polling.log | grep 直播开始 | wc -l`）？
  3. 是否需要事件类型枚举（如 `LIVE_START` / `RECORD_START`）以规范统计口径？
  4. `data` 含对象/数组时的序列化策略（如 `JSON.stringify`）。
  5. 是否需要配套统计/聚合能力（如查询某事件在时间段内的计数），还是仅依赖日志 grep。
  6. 是否需要在前端日志查看器中对 `[<module>:event]` 做高亮或单独筛选视图。

## 14. 实现记录（Implementation Notes）

- **核心实现**：`createModuleLogger` 位于 `server/lib/core/logger.js`，复用既有
  `createRotatingStream` 轮转引擎（日期 + 大小双维度），不重复造轮子。
- **共享轮转流（P1-2 修复）**：按 `fileName + logDir + 轮转配置` 缓存轮转流（`_moduleStreamCache`），
  同一 fileName 的多次 `createModuleLogger` 调用（如 PollingManager、各 Checker、signers 都传
  `'polling'`）复用同一流实例，保证 `currentSize` / 轮转状态在并发写入同一 `polling.log` 时准确一致，
  避免大小阈值失效或重复轮转。
- **级别路由**：`info` 仅写模块文件；`important`/`warn`/`error` 经全局 `console` 覆写链路
  同时镜像 `server.log`；`debug` 默认关闭，可通过 `options.debug` 或环境变量
  `LOG_MODULE_DEBUG`（逗号分隔多模块 / `*` 通配）开启。`mirrorToServer:false` 时
  `important`/`warn`/`error` 仍走全局 `console`（终端始终打印）但抑制 `server.log` 镜像。
- **落盘时机**：与 `server.log` 一致，仅 `NODE_ENV === 'production'` 落盘；开发期只在终端打印。
- **错误降级**：`createRotatingStream` 创建失败时 fallback 为纯终端输出，不阻塞模块启动。
- **接入模块**：
  - 轮询：`server/lib/core/polling/PollingManager.js` 及各平台 `Checker`、`signers/*`
    → 日志写入 `logs/polling.log`；idle 检查降级为 `debug`（默认不输出），状态变化 / 异常 / 首次监控用 `important`/`warn`/`error`。
  - 看门狗：`server/lib/core/watchdog.js` → 日志写入 `logs/watchdog.log`；扫描开始/完成用 `important`，
    逐文件 / 逐分段明细降级为 `debug`。
- **测试**：`test/logger.test.js` 的 `describe('createModuleLogger')` 覆盖信息隔离、server.log 镜像、
  debug 默认关闭与 `LOG_MODULE_DEBUG` 开关、`mirrorToServer:false`、跨天归档、production 门控、流创建失败降级等场景。
- **前端兼容**：`/api/logs/*` 基于 `logs/` 目录扫描，无需改动即可在日志查看器中发现 `polling.log` / `watchdog.log`。
