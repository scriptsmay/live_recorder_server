# 开发环境文档

## 开发工作流

- `npm install` → 安装项目依赖。
- `npm run dev` → node `--watch` 开发模式（端口 3001），启动开发环境，前台查看日志。
- `npm run dev:backend` → 以后台模式启动开发环境，输出日志可在 `/tmp/dev-server.log` 中查看。
- **修改代码后必须更新文档 + 提交代码**：每次完成功能开发或修复后，先更新对应的 `docs/` 文档，再用 `git add`/`git commit` 提交。提交信息格式：`<type>: <description>`

## 开发环境隔离

`npm run dev` 会自动加载 `.env.dev`，覆盖 `.env` 中的以下配置，表中值为举例内容，具体值以项目实际配置为准：

| 配置         | 生产 (.env)          | 开发 (.env.dev)        |
| ------------ | -------------------- | ---------------------- |
| 端口         | `1123`               | `3001`（命令行指定）   |
| 数据库       | `ks_live_recorder`   | `ks_live_recorder_dev` |
| Redis DB     | `1`                  | `2`                    |
| 录制下载目录 | `VIDEO_DOWNLOAD_DIR` | `./dev_downloads`      |
| 回放工作目录 | `REPLAY_WORK_DIR`    | `./replay`             |

**首次使用前需创建开发数据库：**

```sql
CREATE DATABASE ks_live_recorder_dev;
```

（表结构会在启动时自动迁移创建）

`dev_downloads/`、`dev_biliup/` 和 `replay/` 目录在项目根目录下自动创建，已加入 `.gitignore`。

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

## 弹幕 JSONL 路径约定（v1.8.0）

弹幕 JSONL **只有一个合法位置**：`VIDEO_DOWNLOAD_DIR/danmaku/[sessionId].jsonl`。

- 读写两侧都必须调用 `server/lib/utils/tool.js` 的 `getDanmakuJsonlPath(sessionId)`，**禁止在业务代码里手工拼接路径**。目录名由 `getDanmakuDir()` 提供。
- 不保留旧路径兜底。历史上的三种旧形态（`[sessionId]/danmaku/danmaku.jsonl`、`[sessionId]/danmaku.jsonl`、`[roomId]/[sessionId]/danmaku/danmaku.jsonl`）一律靠一次性迁移脚本收敛。
- `danmaku/` 是保留目录名，`scan-files` 会跳过它，不会产生 orphaned 误报。
- 废弃的 `DANMAKU_OUTPUT_DIR` / `DANMAKU_ARCHIVE_DIR` 环境变量已彻底移除，不要重新引入。
- 外部项目 **danmaku-tool 直接依赖这个路径**，改动路径规则必须两端同步（见知识库 ADR-011）。

### 存量数据迁移（一次性）

```bash
# 0. 先停服并备份数据库
sudo docker stop live_recorder_server && bash scripts/backup-db.sh

# 1. dry-run：只输出报告，不动磁盘和 DB（默认行为）
node scripts/migrate-danmaku-paths.js

# 2. 核对报告无误后真实执行
node scripts/migrate-danmaku-paths.js --apply
```

脚本行为：

- 默认 dry-run，真实写入必须显式加 `--apply`。
- 幂等：目标文件已存在则跳过移动，只补齐 DB；重复执行安全。
- 先移动文件，再在**同一事务**内更新 `danmaku_capture_records.raw_path` 和 `managed_files.file_path`；事务失败会把文件搬回原位，避免磁盘/DB 不一致。
- 用 `COPYFILE_EXCL` 拷贝后删源，不会覆盖已存在的活文件。
- `raw_path` 形态不符合预期时**跳过并告警**，不做猜测性改写。
- 收尾清理残留的空 `danmaku/` 目录。
- 退出码非 0 表示存在失败项，需人工核对报告。

校验方法：`--apply` 后确认 `danmaku_capture_records` 中不再有 `raw_path` 指向旧路径，且 `GET /api/danmaku/search`、会话详情弹幕条数、`GET /api/danmaku/sessions/:id/raw` 均正常。

## 快手轮询 smoke

快手轮询 Checker 需要远程 Browserless/Chromium。开发环境可用以下命令验证远程浏览器、平台级串行限速、风控处理和 FLV 抽取：

```bash
REMOTE_BROWSER_WS_ENDPOINT=ws://127.0.0.1:3000/chromium?token=change-me-browserless-token \
node scripts/smoke-kuaishou-checker.js
```

默认 smoke 两轮，每轮串行检查 `KSGJuHao` 和 `KPL704668133`，跨房间等待快手 Checker 内部固定的 20 秒全局间隔，轮间等待 `KUAISHOU_SMOKE_INTERVAL_SECONDS=70` 秒。
输出中会包含 `hadSession` / `hasSession`，用于确认 Redis 中的快手 cookie session 是否被复用。
