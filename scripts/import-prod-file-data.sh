#!/bin/bash
set -euo pipefail

# ── 从生产环境导出业务数据并在开发环境创建假文件，用于文件管理模块测试 ──
#
# 用法：
#   # Step 1: 导出生产数据
#   PROD_DATABASE_URL="postgresql://..." ./scripts/import-prod-file-data.sh export
#
#   # Step 2: 导入开发数据库 + 创建假文件
#   ./scripts/import-prod-file-data.sh import
#
#   # 可选：路径重映射（生产路径前缀与开发不同时）
#   PATH_REMAP_FROM="/srv/nas-data/videos/live_records" \
#   PATH_REMAP_TO="/data" \
#   ./scripts/import-prod-file-data.sh import
#
# 环境变量：
#   PROD_DATABASE_URL  — 生产数据库连接串（export 时必填）
#   DEV_DATABASE_URL   — 开发数据库连接串（默认 docker-compose.full 的 postgres）
#   FAKE_FILE_SIZE     — 假文件大小（字节），默认 102400 (100KB)
#   PATH_REMAP_FROM    — 生产路径前缀
#   PATH_REMAP_TO      — 开发路径前缀

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXPORT_FILE="$PROJECT_DIR/data/prod-file-data.sql"

DEV_DATABASE_URL="${DEV_DATABASE_URL:-postgresql://postgres:password@localhost:5432/live_recorder}"
FAKE_FILE_SIZE="${FAKE_FILE_SIZE:-102400}"

log()  { echo "[import-prod-data] $*"; }
die()  { echo "[import-prod-data] ERROR: $*" >&2; exit 1; }

# ── 导出生产数据 ──
do_export() {
  [ -n "${PROD_DATABASE_URL:-}" ] || die "需要设置 PROD_DATABASE_URL"
  mkdir -p "$PROJECT_DIR/data"

  log "从生产环境导出业务数据..."
  pg_dump "$PROD_DATABASE_URL" \
    --data-only \
    --no-owner \
    --no-privileges \
    --column-inserts \
    --table=rooms \
    --table=recording_sessions \
    --table=recording_files \
    --table=replay_records \
    --table=danmaku_capture_records \
    --table=danmaku_burn_records \
    -f "$EXPORT_FILE"

  log "导出完成 → $EXPORT_FILE ($(du -h "$EXPORT_FILE" | cut -f1))"
  log "数据概览："
  for table in rooms recording_sessions recording_files replay_records danmaku_capture_records danmaku_burn_records; do
    count=$(grep -c "INSERT INTO public.${table} " "$EXPORT_FILE" 2>/dev/null \
         || grep -c "INSERT INTO ${table} " "$EXPORT_FILE" 2>/dev/null || echo 0)
    log "  $table: $count 行"
  done
}

# ── 路径重映射 ──
apply_path_remap() {
  local file="$1"
  if [ -n "${PATH_REMAP_FROM:-}" ] && [ -n "${PATH_REMAP_TO:-}" ]; then
    log "路径重映射: $PATH_REMAP_FROM → $PATH_REMAP_TO"
    sed -i.bak "s|'$PATH_REMAP_FROM|'$PATH_REMAP_TO|g" "$file"
    rm -f "${file}.bak"
  fi
}

# ── 导入开发数据库 ──
do_import() {
  [ -f "$EXPORT_FILE" ] || die "导出文件不存在: $EXPORT_FILE，请先执行 export"

  log "准备导入开发数据库 ($DEV_DATABASE_URL)..."

  local import_file="/tmp/prod-file-data-import.sql"
  cp "$EXPORT_FILE" "$import_file"
  apply_path_remap "$import_file"

  log "清空现有数据（CASCADE）..."
  psql "$DEV_DATABASE_URL" -q -c "
    SET session_replication_role = 'replica';
    TRUNCATE danmaku_burn_records, danmaku_capture_records,
             recording_files, recording_sessions, replay_records
    CASCADE;
    SET session_replication_role = 'origin';
  "

  log "导入数据..."
  psql "$DEV_DATABASE_URL" -q -f "$import_file"
  rm -f "$import_file"

  log "导入完成，数据概览："
  for table in rooms recording_sessions recording_files replay_records danmaku_capture_records danmaku_burn_records; do
    count=$(psql -tA "$DEV_DATABASE_URL" -c "SELECT COUNT(*) FROM $table" 2>/dev/null || echo "N/A")
    log "  $table: $count 行"
  done
}

# ── 创建假文件 ──
do_create_files() {
  log "从数据库提取文件路径，创建假文件（${FAKE_FILE_SIZE} bytes）..."

  local created=0 skipped=0
  local paths
  paths=$(psql -tA "$DEV_DATABASE_URL" -c "
    SELECT file_path FROM recording_files
      WHERE file_path IS NOT NULL AND file_path <> ''
    UNION
    SELECT raw_file_path FROM replay_records
      WHERE raw_file_path IS NOT NULL AND raw_file_path <> ''
    UNION
    SELECT unnest(string_to_array(
      REPLACE(REPLACE(REPLACE(COALESCE(final_file_paths, '[]'), '[', ''), ']', ''), '\"', ''), ','
    )) FROM replay_records
      WHERE final_file_paths IS NOT NULL AND final_file_paths <> '' AND final_file_paths <> '[]'
    UNION
    SELECT output_path FROM danmaku_burn_records
      WHERE output_path IS NOT NULL AND output_path <> ''
    UNION
    SELECT raw_path FROM danmaku_capture_records
      WHERE raw_path IS NOT NULL AND raw_path <> ''
  " 2>/dev/null || true)

  while IFS= read -r filepath; do
    [ -z "$filepath" ] && continue
    filepath=$(echo "$filepath" | xargs)
    [ -z "$filepath" ] && continue

    if [ -f "$filepath" ]; then
      skipped=$((skipped + 1))
      continue
    fi

    mkdir -p "$(dirname "$filepath")"
    dd if=/dev/zero of="$filepath" bs=1 count=0 seek="$FAKE_FILE_SIZE" 2>/dev/null
    created=$((created + 1))
  done <<< "$paths"

  log "假文件创建完成: 新建 $created，已存在跳过 $skipped"
}

# ── 触发扫描 ──
do_trigger_scan() {
  local port="${PORT:-1123}"
  local token="${CRON_API_TOKEN:-}"

  if [ -z "$token" ]; then
    log "未设置 CRON_API_TOKEN，跳过自动扫描，请在前端页面手动触发"
    return
  fi

  log "触发文件扫描 (localhost:$port)..."
  curl -s -X POST "http://localhost:${port}/api/files/scan" \
    -H 'Content-Type: application/json' \
    -H "X-Cron-Token: $token"
  echo
  log "扫描请求已发送"
}

# ── 主入口 ──
case "${1:-help}" in
  export)  do_export ;;
  import)  do_import; do_create_files ;;
  files)   do_create_files ;;
  scan)    do_trigger_scan ;;
  all)     do_export; do_import; do_create_files; do_trigger_scan ;;
  *)
    cat <<HELP
用法: $0 {export|import|files|scan|all}

  export  — 从生产数据库导出业务数据到 data/prod-file-data.sql
  import  — 导入到开发数据库 + 创建假文件
  files   — 仅创建假文件（数据库已有数据时）
  scan    — 触发 API 文件扫描
  all     — export → import → files → scan

环境变量：
  PROD_DATABASE_URL  生产数据库连接串（export 时必填）
  DEV_DATABASE_URL   开发数据库连接串（默认 localhost:5432/live_recorder）
  FAKE_FILE_SIZE     假文件大小，字节（默认 102400）
  PATH_REMAP_FROM    生产路径前缀（如 /srv/nas-data/videos）
  PATH_REMAP_TO      开发路径前缀（如 /data）
  CRON_API_TOKEN     API Token（scan 时需要）
HELP
    ;;
esac
