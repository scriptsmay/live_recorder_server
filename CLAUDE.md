# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

K-Recorder - a lightweight Node.js/Express 5 server that records live streams from Chinese streaming platforms (Huya, Bilibili, Douyin) using FFmpeg, with automatic transcoding (TS→MP4) and optional auto-upload to Bilibili via `biliup`. (Douyu/斗鱼 support is currently unavailable due to platform stream timeout issues) (Douyin/抖音 support is available)

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
    → DanmakuRecorder → danmaku.jsonl
    → Session ends → DanmakuAssGenerator → danmaku.ass + segments
```

**Key layers:**

- `server/router/` — Express route handlers (thin, delegate to services)
- `server/services/` — Business logic (RecorderService, RoomService, UploadService, DataService)
- `server/lib/core/` — Infrastructure: lifecycle bootstrap, watchdog, downloaders, polling, transcode queue, notifications
- `server/lib/core/danmaku/` — Danmaku capture (DanmakuRecorder) and ASS subtitle generation
- `server/lib/core/downloaders/` — FFmpeg-based download engine (factory pattern, extends EventEmitter)
- `server/lib/core/polling/` — Platform-specific live status checkers (strategy pattern, registry in `checkers.js`)
- `server/lib/utils/` — Shared utilities (file paths, platform detection, response helpers, Redis service)
- `server/db/` — PostgreSQL pool, Redis facade, auto-migration on startup (`migrate.js`)
- `public/` — static assets, `frontend/` — Vue SPA source

**Singletons:** `pollingManager`, `recordingManager`, `transcodeQueue` (imported from their modules)

**Frontend (Vue SPA):**

- `frontend/` — Vue 3 + Vite + Tailwind CSS v4 + TypeScript
- `frontend/src/router/index.ts` — Vue Router (history mode), all pages migrated from EJS
- `frontend/src/views/` — Page components (Dashboard, Rooms, Sessions, SessionDanmaku, Recordings, Transcode, DanmakuToolbox, Templates, UploadRecords, Settings, Logs)
- `frontend/src/components/` — Shared components (Layout, Navbar, Pagination, ToastContainer, ConfirmDialog)
- `frontend/src/utils/api.ts` — Unified fetch wrapper (apiGet/apiPost/apiPut/apiDelete)
- `frontend/src/stores/` — Pinia stores (app, danmaku-toolbox)
- Dev: `cd frontend && npm run dev` (port 5173, proxies `/api` and `/hls` to backend on 3001)
- Build: `cd frontend && npm run build` → outputs to `public/frontend/`, served by `server/router/spa.js` as SPA fallback

**State storage:** Redis for transient state (live status, polling timers, active tasks with TTL). PostgreSQL for persistent data (rooms, sessions, recordings, settings).

**File paths:** `VIDEO_DOWNLOAD_DIR/[roomId]/[sessionId]/[filename]`, danmaku data in `danmaku/` subdirectory

## Environment

- `.env` for production, `.env.dev` for development (auto-loaded when `NODE_ENV=development`)
- Dev uses separate database (`ks_live_recorder_dev`), separate Redis DB (2 vs 1), separate download dir (`dev_downloads/`)
- `npm run check-env` validates environment configuration

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

All Docker config files live in `docker/`:

- `docker/docker-compose.yml` — pre-built GHCR image deployment (main app only)
- `docker/docker-compose.cron.yml` — replay cron + data sync (optional overlay)
- `docker/docker-compose.full.yml` — full stack with PostgreSQL 16 + Redis 7
- CI/CD: GitHub Actions builds Docker image on `v*` tags, pushes to GHCR
