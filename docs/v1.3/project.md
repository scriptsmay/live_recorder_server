# 🚀 直播录制系统 v1.3 架构升级与稳定性优化开发计划

**文档版本**：v1.3.0  
**计划部署版本**：v1.3.0  
**状态**：✅ v1.3.0 开发已完成 (2026-05-16)，待部署
**核心目标**：消除“防御性误杀”断档、解除主线程 I/O 阻塞、实现容器级进程自愈、确立文件状态唯一责任人  
**影响范围**：看门狗测活逻辑、下载引擎 spawn 配置、文件追踪架构、Docker 部署规范、Worker 线程调度

本计划以**连续性保障、事件循环保护、容器化生命周期、文件状态唯一性**为第一优先级，对原计划进行重构与升维，可直接作为技术评审与 Sprint 拆解基线。

---

## 📊 优化清单与优先级矩阵（v1.3）

| 优先级 | 模块         | 优化项                                  | 风险等级 | 预估工时 | 依赖关系 |
| :----: | :----------- | :-------------------------------------- | :------: | :------: | :------- |
| 🔴 P0  | 测活机制     | 看门狗 mtime 轮询 → `stderr` 心跳解析   |    高    |    3d    | 无       |
| 🔴 P0  | 文件同步     | 唯一责任人模式 + `chokidar` 事件驱动    |    高    |   3.5d   | P0-2     |
| 🔴 P0  | I/O 隔离     | 重任务剥离至 `Worker Threads`           |    中    |   2.5d   | 无       |
| 🔴 P0  | 容器生命周期 | `tini` PID 1 + IPC 管道绑定替代 `pkill` |    高    |    2d    | 无       |
| 🟡 P1  | 限流与并发   | 上传限流 Redis 持久化 + 续播分布式锁    |    中    |    2d    | P0-2     |
| 🟡 P1  | 磁盘与存储   | 容量监控 + FFmpeg `.ts` 分段兜底        |    中    |    3d    | P0-2     |
| 🟢 P2  | 投稿解析     | `biliup` 输出分离 + BV 正则兼容         |    低    |   1.5d   | 无       |

---

## 🛠️ 核心改造方案详细设计

### 🔴 P0-1 看门狗测活机制重构：`stderr` 心跳替代 `mtime`

**问题**：VBR/黑屏/缓冲未满导致 `mtime` 停滞，误判僵死 → 杀进程重拉 → 10~20s 断档。  
**方案**：

1. **引擎输出接管**：`spawn` 配置强制 `stdio: ['ignore', 'ignore', 'pipe']`，仅拦截 `stderr`。
2. **心跳解析适配器**：

   ```js
   // lib/heartbeat-parser.js
   const FFmpegHeartbeat = /frame=\d+\s+fps=[\d.]+\s+bitrate=[\d.]+kbits/s/;

   function parseHeartbeat(chunk) {
     const text = chunk.toString();
     return FFmpegHeartbeat.test(text);
   }
   ```

3. **超时判定逻辑**：维护 `lastHeartbeatAt` 时间戳。若 `now - lastHeartbeatAt > watchdog_timeout`（建议 120s），标记僵死。降级保留 `mtime` 检查仅作为解析失败时的 fallback。
   **验收标准**：

- [ ] 模拟 VBR 黑屏 5 分钟，看门狗不触发 `SIGTERM`
- [ ] 注入真实 FFmpeg stderr 流，心跳解析准确率 ≥ 99%
- [ ] `checkStaleRecordings()` 响应时间 ≤ 50ms（无阻塞）

### 🔴 P0-2 文件状态同步唯一责任人模式

**问题**：看门狗、close handler、API 扫描并发重命名 `.part` → `EBUSY`/重复入库。  
**方案**：

1. **权限隔离**：
   - `watchdog`：仅读取目录/监听事件，**严禁**执行 `fs.rename` 或 DB 写入。
   - `close handler`：唯一拥有 `.part` → `.flv/mp4` 重命名权限的模块。
   - `API scan`：仅标记 `orphaned`，不触碰活跃房间目录。
2. **事件驱动替换轮询**：
   ```js
   // lib/file-watcher.js
   const watcher = chokidar.watch(activeDirs, { ignoreInitial: true });
   watcher.on('add', handleNewFile);
   watcher.on('change', handleFileUpdate);
   watcher.on('rename', (oldPath, newPath) => handleRename(oldPath, newPath));
   ```
3. **防并发写入锁**：使用 `Map<sessionId, Set<filePath>>` 内存锁 + Redis `SETNX watch:file:{hash} 1 EX 10` 双保险，确保同一文件仅被 `recording_files` 插入一次。
   **验收标准**：

- [ ] 强制 `kill -9` 后，仅 `close handler` 执行重命名，无 `EBUSY`
- [ ] 并发扫描同一目录，DB `UNIQUE` 约束零冲突
- [ ] 延迟续播/断流恢复场景下，文件追踪完整率 100%

### 🔴 P0-3 重任务 I/O 隔离（Worker Threads）

**问题**：`scanRecordingFiles` / `cleanupFragmentFiles` 在 HDD 上触发 `fs.readdir` + `fs.stat` 风暴 → 阻塞 Event Loop → API 超时。  
**方案**：

1. **剥离至 Worker**：
   ```js
   // lib/workers/fs-scanner.js
   const { parentPort } = require('worker_threads');
   parentPort.on('message', async (task) => {
     const results = await processDirectoryChunk(task.dir, task.batchSize);
     parentPort.postMessage({ type: 'done', results });
   });
   ```
2. **主线程调度**：使用 `worker_threads.Worker` 池（默认 2 个），传入目录路径与过滤规则。主线程仅接收 `message` 并更新 DB/状态。
3. **降级策略**：若 Worker 池满或系统 `ulimit -n` 不足，fallback 至子进程 `find . -type f -mtime +2 -size +100k` 快速过滤。
   **验收标准**：

- [ ] 单目录 5000+ 文件扫描，主线程 Event Loop 延迟 < 10ms
- [ ] HTTP API P99 响应时间 ≤ 200ms（压测期间）
- [ ] 内存峰值 ≤ 原方案的 60%（分块处理）

### 🔴 P0-4 容器化进程生命周期改造

**问题**：Node.js 作为 PID 1 不回收僵尸；`pkill` 跨会话误杀；崩溃后子进程逃逸。  
**方案**：

1. **Dockerfile 入口改造**：
   ```dockerfile
   RUN apt-get update && apt-get install -y tini
   ENTRYPOINT ["/usr/bin/tini", "--", "node", "app.js"]
   ```
2. **Spawn 管道绑定**：
   ```js
   const downloader = spawn(cmd, args, {
     stdio: ['ignore', 'pipe', 'pipe'], // 强制管道绑定
     detached: false, // 不脱离父进程组
     env: { ...process.env, ...roomEnv },
   });
   downloader.on('exit', () => cleanup(downloader.pid));
   ```
3. **移除 `pkill` 与复杂启动清理**：依赖 `tini` 自动回收；依赖 `SIGPIPE`/管道断开实现子进程随父崩溃自愈。`startup()` 仅保留 DB 状态修复与 `.part` 兜底。
   **验收标准**：

- [ ] 容器内 `ps aux` 无 `<defunct>` 僵尸进程
- [ ] `kill -9 node` 后，FFmpeg 子进程在 3s 内自动退出
- [ ] `startup()` 耗时从 ~15s 降至 ≤ 2s

---

## 🟡 P1 配套优化整合（原计划收敛）

| 模块             | 调整说明                                                                                                    |
| :--------------- | :---------------------------------------------------------------------------------------------------------- |
| **上传限流**     | 移至 Redis `INCR`，但调用链需适配 P0-2 的分布式锁，避免投稿与续播并发冲突                                   |
| **延迟续播并发** | 改为 `Redis SETNX lock:resume:{room_id} 1 EX 10` + DB `FOR UPDATE`，确保会话状态原子切换                    |
| **磁盘监控**     | 保留，但触发 `critical` 后不再直接杀进程，改为暂停新请求 + 触发 Worker 清理碎片                             |
| **FFmpeg 分段**  | 优先输出 `.ts`，若必须 `.mp4` 则启用 `-movflags +frag_keyframe+empty_moov` 提升中断可播性                   |
| **BV 解析**      | `spawn biliup` 时 `stdout`/`stderr` 分离，正则 `/BV[0-9A-Za-z]{10}/` 提取，失败入库 `raw_output` 供人工复核 |

---

## 🗓️ 实施路径（3 个 Sprint）

| Sprint                 | 交付目标                                                           | 风险控制                                                          |
| :--------------------- | :----------------------------------------------------------------- | :---------------------------------------------------------------- |
| **Sprint 1 (P0 底座)** | `tini` 容器改造 + IPC 管道绑定 + Worker 线程池 + `stderr` 心跳解析 | 先灰度 10% 房间，保留 `mtime` fallback 开关，监控 Event Loop 延迟 |
| **Sprint 2 (P0 同步)** | `chokidar` 事件驱动 + 唯一责任人重命名 + 防并发写入锁              | 双跑对比：旧轮询 vs 新事件流，7 天后切换；压测并发断流恢复        |
| **Sprint 3 (P1 收敛)** | Redis 限流 + 续播分布式锁 + 磁盘监控联动 + BV 解析增强             | 全链路集成测试，输出压测报告，更新 `ARCHITECTURE.md` 与部署手册   |

---

## 📈 架构演进对比（Before → After）

| 维度           | v1.2 现状                      | v1.3 目标                                 |
| :------------- | :----------------------------- | :---------------------------------------- |
| **测活机制**   | 磁盘 `mtime` 轮询（易误杀）    | `stderr` 心跳流解析（精准保活）           |
| **文件同步**   | 多模块竞态扫描/重命名          | `chokidar` 事件驱动 + 唯一责任人          |
| **Event Loop** | 主线程同步 `fs` 操作（易阻塞） | `Worker Threads` 异步剥离（API 始终响应） |
| **进程管理**   | `pkill` 全局杀 + PID 1 不回收  | `tini` PID 1 + IPC 管道绑定自愈           |
| **部署形态**   | 裸机/简单 Docker               | 标准容器化 + 免维护生命周期               |

---

## 📎 附录：关键配置与代码骨架

### 1. `spawn` 标准配置模板

```js
const spawnOpts = {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: false,
  env: { ...process.env, FFMPEG_LOG_LEVEL: 'info' },
  cwd: process.cwd(),
};
```

### 2. Worker 线程调度器骨架

```js
// lib/fs-worker-pool.js
const { Worker } = require('worker_threads');
class FSWorkerPool {
  constructor(size = 2) {
    this.pool = Array.from({ length: size }, () => new Worker(path.join(__dirname, 'workers/fs-scanner.js')));
    this.queue = [];
  }
  async scan(dir, opts) {
    return new Promise((resolve) => {
      const worker = this.pool.find((w) => !w.isBusy) || this.pool[0];
      worker.isBusy = true;
      worker.postMessage({ dir, ...opts });
      worker.on('message', (res) => {
        worker.isBusy = false;
        resolve(res.results);
      });
    });
  }
}
```

---

## 🔍 唯一需要注意的微小盲点（上线前 Check）

为了追求 100% 的完美，建议你在实施过程中肉眼盯紧一个边缘场景：

- **Stream-gears 内部重试引发的“假死”边界**：
  文档在 P0-1 中提到了对 Stream-gears 的心跳匹配包含 `/download speed|retry|flv tag/`。需要注意的是：如果 Stream-gears 因为网络极度恶劣触发了**长期的断线重试（指数退避）**，它依然会在 `stderr` 输出 `retry` 日志。
- **潜在风险**：如果它重试了 5 分钟，虽然解析器认为它“活着”（有心跳），但实际上它这 5 分钟**完全没有在录制任何数据**。
- **修正建议**：在 `heartbeat-parser.js` 中，如果连续匹配到 `retry` 且时间超过了预设阈值（例如 3 分钟），应该主动判定为“虽然进程健康，但链路已死”，触发重连，而不是允许它无限重试下去，从而引发另一种形式的“长时间断档”。
