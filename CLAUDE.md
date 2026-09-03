# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

K-Recorder - a lightweight Node.js/Express 5 server that records live streams from Chinese streaming platforms (Huya, Bilibili, Douyin, Kuaishou, Douyu) using FFmpeg, with automatic transcoding (TS→MP4) and optional auto-upload to Bilibili via `biliup`. Kuaishou uses a remote Browserless/Chromium instance (or HTTP API mode). Douyu code exists and is registered in the checker registry but may experience platform-side stream timeout issues.

## Commands

```bash
# Development
npm run dev              # Start dev server (port 3001, file watching, uses .env.dev)
npm run dev:stop         # Kill dev server on port 3001

# Production
npm start                # Start production server (port 1123)

# Testing
npm test                 # Run all tests (Jest 30)
npm run test:watch       # Watch mode
npm run test:coverage    # With coverage
npm run test:api         # API integration tests only

# Code quality
npm run lint             # ESLint (v9 flat config)
npm run format           # Prettier

# Single test file
npx jest path/to/file.test.js
```

## Architecture

CommonJS modules throughout. Express 5 (not 4 - has native async error handling).

**Data flow:**

```
Chrome Extension / PollingManager
    → POST /api/notify/live_download
    → RecorderService.startRecording()
    → DownloaderFactory → FFmpegDownloader.spawn()
    → RecordingManager tracks session
    → Watchdog monitors processes
    → TranscodeQueue → Transcoder (TS→MP4)
    → UploadService → biliup CLI

Chrome Extension (danmaku)
    → POST /api/danmaku/batch
    → DanmakuRecorder → VIDEO_DOWNLOAD_DIR/danmaku/[sessionId].jsonl
    → Session ends → capture record marked completed (ASS/burn moved to danmaku-tool)
```

**Key layers:**

- `server/router/` — Express route handlers (thin, delegate to services)
- `server/services/` — Business logic (RecorderService, RoomService, UploadService, DataService)
- `server/lib/core/` — Infrastructure: lifecycle bootstrap, watchdog, downloaders, polling, transcode queue, notifications
- `server/lib/core/danmaku/` — Danmaku capture (DanmakuRecorder writes JSONL only; ASS/burn moved out)
- `server/lib/core/downloaders/` — FFmpeg-based download engine (factory pattern, extends EventEmitter)
- `server/lib/core/polling/` — Platform-specific live status checkers (strategy pattern, registry in `checkers.js`). Checkers: `HuyaChecker`, `BilibiliChecker`, `DouyinChecker`, `DouyuChecker`, `KuaishouAPIChecker` (HTTP API direct, the only Kuaishou checker since v1.8.3). Signature helpers under `signers/` (douyin, douyu, douyu-vip)
- `server/lib/utils/` — Shared utilities (file paths, platform detection, response helpers, Redis service)
- `server/db/` — PostgreSQL pool, Redis facade, auto-migration on startup (`migrate.js`)
- `public/` — static assets, `frontend/` — Vue SPA source

**Singletons:** `pollingManager`, `recordingManager`, `transcodeQueue` (imported from their modules)

**Frontend (Vue SPA):**

- `frontend/` — Vue 3 + Vite + Tailwind CSS v4 + TypeScript
- `frontend/src/router/index.ts` — Vue Router (history mode), all pages migrated from EJS
- `frontend/src/views/` — Page components (Dashboard, Rooms, Sessions, SessionDanmaku, Recordings, Transcode, Templates, UploadRecords, Settings, Logs)
- `frontend/src/components/` — Shared components (Layout, Navbar, Pagination, ToastContainer, ConfirmDialog)
- `frontend/src/utils/api.ts` — Unified fetch wrapper (apiGet/apiPost/apiPut/apiDelete)
- `frontend/src/stores/` — Pinia stores (app)
- Dev: `cd frontend && npm run dev` (port 5173, proxies `/api` and `/hls` to backend on 3001)
- Build: `cd frontend && npm run build` → outputs to `public/frontend/`, served by `server/router/spa.js` as SPA fallback

**State storage:** Redis for transient state (live status, polling timers, active tasks with TTL). PostgreSQL for persistent data (rooms, sessions, recordings, settings).

**File paths:** `VIDEO_DOWNLOAD_DIR/[sessionId]/[filename]` (recordings); danmaku JSONL centralized at `VIDEO_DOWNLOAD_DIR/danmaku/[sessionId].jsonl` (v1.8.0). Legacy `VIDEO_DOWNLOAD_DIR/[roomId]/[sessionId]/` recording paths remain readable via `recording_sessions.output_dir`.

## Environment

- `.env` for production, `.env.dev` for development (auto-loaded when `NODE_ENV=development`)
- Dev uses separate database (`ks_live_recorder_dev`), separate Redis DB (2 vs 1), separate download dir (`dev_downloads/`)
- `npm run check-env` validates environment configuration
- See `.env.example` for the full variable list

**Auth (enabled in production):** `AUTH_ENABLED` (set `false` to disable — anything else enables it), `ADMIN_USERNAME` (default `admin`), `AUTH_TOKEN_TTL_HOURS` (24), `AUTH_COOKIE_NAME` (`auth_token`), `AUTH_COOKIE_SECURE`, `LOGIN_RATE_LIMIT` (5), `LOGIN_LOCKOUT_MIN` (5). On first boot with an empty `admin_users` table, `server/lib/core/auth-init.js` generates a random password and prints it to the startup log. Sessions live in Redis at `auth:session:{token}`. Note this auth wall blocks unauthenticated `curl` against API endpoints.

**Remote browser / Browserless:** `REMOTE_BROWSER_WS_ENDPOINT` (CDP endpoint used by `server/lib/core/browser/RemoteBrowserClient.js` for Kuaishou polling and replay m3u8 extraction), `BROWSERLESS_TOKEN`, `BROWSERLESS_CONCURRENT`, `BROWSERLESS_QUEUED`, `BROWSERLESS_TIMEOUT_MS`. Kuaishou polling also reads `KUAISHOU_CHECKER_ENABLED` and `POLLING_KUAISHOU_COOKIE`.

**Danmaku archive:** `DANMAKU_ARCHIVE_DIR` (production `/data/danmaku_archive`) — not deprecated. `FileManageService._scanDanmakuArchiveFiles` indexes archived JSONL from `danmaku_capture_records.raw_path` with `file_type=danmaku_archive` and marks it not safe to delete. Only `DANMAKU_OUTPUT_DIR` was removed in v1.8.0.

## Code Style

- Prettier: single quotes, trailing commas (es5), 120 char print width, 2-space indent, semicolons
- ESLint: allows empty catch blocks, unused args prefixed with `_`, infinite loops
- No ES modules — use `require`/`module.exports`
- Git commits: `<type>: <description>` (e.g., `feat(polling): add bilibili live polling support`)

## Design Philosophy

- Keep it lightweight — no complex state machines, synchronous fs operations are acceptable
- Express 5 async error handling is built-in, no need for express-async-errors
- Recording process control via signals: SIGSTOP (pause), SIGCONT (resume), SIGTERM (stop), signal 0 (alive check)
- Docs must be updated in `/docs/` before committing code changes

## External Dependencies

- **FFmpeg** — download engine and transcoder (must be installed separately)
- **biliup** — Bilibili upload CLI (Python, installed via `pip`/`uv` in Docker)
- Chrome extension at `../chrome_live_listener/` pushes stream URLs to this server's API

## Testing

- Jest 30 with `fast-check` for property-based testing
- Coverage targets: core modules ≥80%, utilities ≥90%, API endpoints full coverage
- Pre-commit check: `npm run lint && npm run format && npm run test`

## Docker

All Docker config files live in `docker/`. Composition is **base + override**, service name is always `live_recorder_server`. See `docker/README.md` for details.

- `docker/docker-compose.yml` (base) — main service commonalities; image via `${APP_IMAGE:-registry.cnb.cool/scriptsmay/live_recorder_server:latest}`
- `docker/docker-compose.build.yml` — local full-stack override: builds from `Dockerfile.local`, adds PostgreSQL 16 + Redis 7
- `docker/docker-compose.prod.yml` — production override: pinned `APP_VERSION`, `shared_scripts` volume, external network (`EXTERNAL_NETWORK_NAME`), `deploy.resources`
- `docker/docker-compose.cron.yml` — replay cron + data sync overlay
- `docker/docker-compose.browserless.yml` — Browserless/Chromium overlay

```bash
cd docker
# local full stack
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
# production
APP_VERSION=v1.8.2 docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.cron.yml up -d
```

**Dockerfiles:** root `Dockerfile` is the only production image (4 stages: frontend build → backend deps → BtbN n7.1 static ffmpeg → runtime with yt-dlp + CJK fonts). `docker/Dockerfile.local` is a local-acceleration build and is **not equivalent to production**. `docker/Dockerfile.replay-cron` is a lightweight Alpine that contains **no scripts** and depends entirely on the mounted volume.

**shared_scripts sync (v1.8.2):** Docker named volumes only seed from the image on first creation, so image updates to `scripts/` were previously masked. The production `Dockerfile` now snapshots `cp -a /app/scripts /app/scripts.image`, and `docker/scripts/docker-entrypoint.sh` refreshes `/app/scripts` from that snapshot on every boot. If a release only changes `scripts/`, force-recreate the main container to trigger the sync, then restart `replay_cron`.

CI/CD: `.cnb.yml`（CNB 云原生构建）在 `v*` tag 推送时构建主服务镜像 + replay-cron 镜像并推送到 CNB 制品库 `registry.cnb.cool/scriptsmay/live_recorder_server`（主服务，同名制品）与 `.../live_recorder_server/replay-cron`（非同名制品，命名空间路径）试点迁移，对应知识库 ADR-001 步骤③）；`main` 分支 crontab 每周同步 FFmpeg 构建镜像到 `.../live_recorder_server/ffmpeg`。GitHub Actions 原 `ghcr.io` 流程暂并存。
