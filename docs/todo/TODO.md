# TODO：下一个版本的开发计划

## v1.1：Docker 镜像与 NAS 部署支持

### 目标

将项目封装成 Docker 镜像，并提供 Docker Compose 部署方案，方便在 NAS
或其他 Linux 主机上稳定运行。

本版本不移除现有 PM2 本地部署方式，而是新增 Docker 部署能力，确保正式环境可平滑迁移与回滚。

### 总体方案

- 应用镜像内包含 Node.js runtime、项目代码、生产依赖、ffmpeg、Python、uv 与通过 `uv tool install biliup` 安装的 biliup。
- PostgreSQL 与 Redis 不打入应用镜像，通过 Docker Compose 独立编排。
- Docker 部署优先使用简洁环境变量，例如 `DATABASE_URL`、`REDIS_URL`、`APP_DATA_DIR`。
- 录制文件、日志、biliup 工作目录、数据库数据均使用 volume 或宿主机目录持久化。
- 容器内不再使用 PM2，应用进程直接通过 `node app.js` 启动，重启交给 Docker restart policy。

### 计划任务

#### 1. Docker 构建文件

- [x] 新增 `Dockerfile`
  - 基于稳定 Node.js 镜像。
  - 安装 `ffmpeg`。
  - 安装 Python、`pip` 与 `uv`。
  - 通过 `uv tool install biliup` 安装投稿工具。
  - 仅安装 production dependencies。
  - 启动命令使用 `node app.js`。
- [x] 新增 `.dockerignore`
  - 排除 `node_modules/`、`logs/`、`backups/`、`coverage/`、开发下载目录、`.env` 等。

#### 2. Docker Compose 编排

- [x] 新增 `docker-compose.yml`
  - `app` 服务：运行 live recorder server。
  - `postgres` 服务：提供 PostgreSQL。
  - `redis` 服务：提供 Redis。
- [x] 新增 `.env.docker.example`
  - `DATABASE_URL=postgresql://postgres:password@postgres:5432/live_recorder`
  - `REDIS_URL=redis://default:password@redis:6379/1`
  - `APP_DATA_DIR=/data`
  - `VIDEO_DOWNLOAD_DIR=/data/video_downloads`
  - `BILIUP_WORK_DIR=/data/biliup`
- 配置持久化目录：
  - `./data/video_downloads:/data/video_downloads`
  - `./data/biliup:/data/biliup`
  - `./logs:/app/logs`
  - `postgres_data:/var/lib/postgresql/data`
  - `redis_data:/data`

#### 3. 环境变量兼容与简化

- [x] PostgreSQL 配置支持两种方式：
  - Docker 推荐：`DATABASE_URL=postgresql://user:password@host:5432/database`
  - 兼容旧配置：`DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_USER`、`DB_PASSWORD`
- [x] Redis 配置支持两种方式：
  - Docker 推荐：`REDIS_URL=redis://user:password@host:6379/1`
  - 兼容旧配置：`REDIS_HOST`、`REDIS_PORT`、`REDIS_USER`、`REDIS_PASSWORD`、`REDIS_DB`
- [x] 新增 `APP_DATA_DIR` 作为容器数据根目录，默认 `/data`。
- [x] Docker 默认目录：
  - `VIDEO_DOWNLOAD_DIR=/data/video_downloads`
  - `BILIUP_WORK_DIR=/data/biliup`
  - biliup cookies 文件放在 `/data/biliup/cookies.json`
- [x] 保留显式 `VIDEO_DOWNLOAD_DIR` 与 `BILIUP_WORK_DIR`，允许高级用户覆盖默认目录。

#### 4. 容器启动可靠性

- [x] 新增 `scripts/docker-entrypoint.sh`
  - 等待 PostgreSQL 可连接。
  - 等待 Redis 可连接。
  - 创建 `/data/video_downloads`、`/data/biliup`、`/app/logs` 等必要目录。
  - 最后执行 `node app.js`。
- [x] 确认启动时自动迁移逻辑在容器环境中可正常运行。
- [x] 确认容器重启后 stale recording 清理逻辑仍然有效。

#### 5. 健康检查

- [x] 新增 `GET /api/health`。
- 返回应用、数据库、Redis 状态与版本信息，例如：

```json
{
  "ok": true,
  "db": true,
  "redis": true,
  "version": "1.1.0"
}
```

- [x] 在 Dockerfile 或 Compose 中配置 healthcheck。

#### 6. biliup 容器化

- [x] 镜像内按 Linux 推荐方式安装 biliup：先安装 `uv`，再执行 `uv tool install biliup`。
- [x] 确认 `uv` 的工具安装目录已加入 `PATH`，使应用可直接调用 `biliup`。
- [x] 默认配置：
  - `BILIUP_WORK_DIR=/data/biliup`
- [x] Docker 部署默认不需要配置 `BILIUP_PATH`。
- [x] `BILIUP_PATH` 仅作为兼容旧部署或自定义 biliup 二进制路径的可选覆盖项保留。
- [x] 将 `/data/biliup` 持久化到宿主机，避免登录态、配置和缓存随容器重建丢失。
- [x] 将 biliup 使用的 `cookies.json` 放在 `/data/biliup/cookies.json`，并在文档中说明宿主机对应路径。
- [x] 在文档中说明 biliup 登录、配置文件、cookie/认证信息的保存位置。

#### 7. 文档

- [x] 新增 `docs/DOCKER.md`
  - 快速启动。
  - `.env.docker` 配置说明。
  - 首次部署步骤。
  - NAS 部署目录建议。
  - 数据卷说明。
  - biliup 登录与投稿配置。
  - 从 PM2 迁移到 Docker 的流程。
  - Docker 回滚到 PM2 的流程。
  - 备份与恢复 PostgreSQL、Redis、录制目录的方法。
- [x] 更新 `docs/ARCHITECTURE.md`
  - 补充 Docker 部署架构。
- [x] 如新增 `/api/health`，同步更新 `docs/API.md`。

#### 8. 验证

- 本地构建：

```bash
docker compose build
```

- 本地启动：

```bash
docker compose up -d
```

- 查看日志：

```bash
docker compose logs -f app
```

- 验证项：
  - 应用正常监听 `1123`。
  - PostgreSQL 连接正常。
  - Redis 连接正常。
  - 数据库迁移正常执行。
  - `/api/health` 正常返回。
  - ffmpeg 可用。
  - biliup 可用。
  - `/data/biliup/cookies.json` 可被 biliup 读取。
  - `VIDEO_DOWNLOAD_DIR` 自动创建且可写。
  - `logs/` 自动创建且可写。
  - 重启容器后录制状态清理逻辑正常。

#### 9. 发布

- 建议分支：`codex/dockerize-app`
- 建议提交信息：

```bash
git commit -m "feat: add docker deployment support"
```

- 建议版本：`v1.1.0`

### 最小交付范围

- `Dockerfile`
- `.dockerignore`
- `docker-compose.yml`
- `.env.docker.example`
- `scripts/docker-entrypoint.sh`
- `DATABASE_URL` / `REDIS_URL` 连接串解析兼容
- `GET /api/health`
- `docs/DOCKER.md`
- `docs/API.md` 与 `docs/ARCHITECTURE.md` 的对应更新
