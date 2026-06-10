# 开发环境文档

## 开发工作流

- `npm install` → 安装项目依赖。
- `npm run dev` → node `--watch` 开发模式（端口 3001），启动开发环境，前台查看日志。
- `npm run dev:backend` → 以后台模式启动开发环境，输出日志可在 `/tmp/dev-server.log` 中查看。
- **修改代码后必须更新文档 + 提交代码**：每次完成功能开发或修复后，先更新对应的 `docs/` 文档，再用 `git add`/`git commit` 提交。提交信息格式：`<type>: <description>`

## 开发环境隔离

`npm run dev` 会自动加载 `.env.dev`，覆盖 `.env` 中的以下配置，表中值为举例内容，具体值以项目实际配置为准：

| 配置     | 生产 (.env)          | 开发 (.env.dev)        |
| -------- | -------------------- | ---------------------- |
| 端口     | `1123`               | `3001`（命令行指定）   |
| 数据库   | `ks_live_recorder`   | `ks_live_recorder_dev` |
| Redis DB | `1`                  | `2`                    |
| 下载目录 | `VIDEO_DOWNLOAD_DIR` | `./dev_downloads`      |

**首次使用前需创建开发数据库：**

```sql
CREATE DATABASE ks_live_recorder_dev;
```

（表结构会在启动时自动迁移创建）

`dev_downloads/` 和 `dev_biliup/` 目录在项目根目录下自动创建，已加入 `.gitignore`。

## 开发环境管理命令

```bash
# 方式1：前台运行并查看日志
npm run dev

# 方式2：后台运行并查看日志
npm run dev > /tmp/dev-server.log 2>&1 &
tail -f /tmp/dev-server.log

# 停止开发服务
kill $(lsof -ti :3001)

# 检查开发环境端口占用
lsof -i :3001
```

**主动重启后建议清理脏数据：**

```bash
node scripts/cleanup-dev.js
```

该脚本会：杀死孤儿进程 → 重命名 `.part` → 清除孤文件 DB 记录 → 中断遗留会话 → 追踪遗留文件到 recording_files。具体实现见 `scripts/cleanup-dev.js`。

- 录制进程日志（ffmpeg 输出）在 `logs/` 目录
- 数据库独立：`ks_live_recorder_dev`（需手动 `CREATE DATABASE`，表结构自动迁移）
- Redis DB 编号：`2`（生产使用 `1`）

## 快手轮询 smoke

快手轮询 Checker 需要远程 Browserless/Chromium。开发环境可用以下命令验证远程浏览器、平台级串行限速、风控处理和 FLV 抽取：

```bash
REMOTE_BROWSER_WS_ENDPOINT=ws://127.0.0.1:3000/chromium/playwright \
node scripts/smoke-kuaishou-checker.js
```

默认 smoke 两轮，每轮串行检查 `KSGJuHao` 和 `KPL704668133`，跨房间等待 `KUAISHOU_CHECKER_GLOBAL_INTERVAL_SECONDS`，轮间等待 `KUAISHOU_SMOKE_INTERVAL_SECONDS=70` 秒。
