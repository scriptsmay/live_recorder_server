#!/bin/sh

# 回放记录同步脚本：本地 PostgreSQL replay_records → 远程 Supabase
# 测试阶段默认写入 test_records，通过 REMOTE_TABLE 环境变量切换
# 由 docker/docker-compose.cron.yml 中 replay_cron 服务调度，使用 psql 直连两边数据库

set -e

# ── 配置 ──────────────────────────────────────────────────
DATABASE_URL="${DATABASE_URL:?DATABASE_URL 未设置}"
SUPABASE_URL="${SUPABASE_URL:?SUPABASE_URL 未设置}"
SUPABASE_PSQL_URL="$(printf '%s' "$SUPABASE_URL" | sed -E 's/([?&])pgbouncer=(true|false)&?/\1/g; s/[?&]$//')"
API_BASE="${API_BASE:-http://localhost:1123}"
CRON_HEADER_ARGS=""
REMOTE_TABLE="${REMOTE_TABLE:-test_records}"
TMPDIR="${TMPDIR:-/tmp}"
EXPORT_CSV="$TMPDIR/sync_replay_$$.csv"
EXPORT_SQL="$TMPDIR/sync_replay_$$.sql"
STAGING="_staging_sync_$$"
SYNC_REPLAY_RECORD_IDS="${SYNC_REPLAY_RECORD_IDS:-}"

if [ "$#" -gt 0 ]; then
  case "$1" in
    --ids|--id)
      shift
      SYNC_REPLAY_RECORD_IDS="${1:-}"
      ;;
    --help|-h)
      cat <<HELP
Usage: sync-records.sh [--ids "1,2,3"]

Environment:
  SYNC_REPLAY_RECORD_IDS  Comma-separated local replay_records.id values to sync.
HELP
      exit 0
      ;;
    *)
      SYNC_REPLAY_RECORD_IDS="$1"
      ;;
  esac
fi

if [ -n "$CRON_API_TOKEN" ]; then
  CRON_HEADER_ARGS="-H X-Cron-Token:$CRON_API_TOKEN"
fi

# ── 工具函数 ──────────────────────────────────────────────
log() {
  echo "[sync-records] $(date '+%Y-%m-%d %H:%M:%S') $1"
}

notify_sync() {
  title="$1"
  content="$2"

  # shellcheck disable=SC2086
  curl -sf -X POST -G $CRON_HEADER_ARGS "$API_BASE/api/notify/feishu_webhook" \
    --data-urlencode "title=$title" \
    --data-urlencode "content=$content" >/dev/null 2>&1 || true
}

cleanup() {
  rm -f "$EXPORT_CSV"
  rm -f "$EXPORT_SQL"
  # 尽力清理远程暂存表，忽略错误
  psql -q "$SUPABASE_PSQL_URL" -c "DROP TABLE IF EXISTS $STAGING" 2>/dev/null || true
}
trap cleanup EXIT

die() {
  log "错误: $1"
  notify_sync "sync-records 同步失败" "目标表：$REMOTE_TABLE
错误：$1"
  exit 1
}

# ── 1. 连接检查 ───────────────────────────────────────────
log "开始同步 replay_records → $REMOTE_TABLE"

if [ -n "$SYNC_REPLAY_RECORD_IDS" ]; then
  case "$SYNC_REPLAY_RECORD_IDS" in
    *[!0-9,[:space:]]*)
      die "SYNC_REPLAY_RECORD_IDS 只能包含数字、逗号和空白字符: $SYNC_REPLAY_RECORD_IDS"
      ;;
  esac
  log "限定同步本地记录 ID: $SYNC_REPLAY_RECORD_IDS"
fi

LOCAL_TOTAL_COUNT=$(psql -tA "$DATABASE_URL" \
  -c "SELECT COUNT(*) FROM replay_records" 2>&1) || die "本地数据库连接失败: $LOCAL_TOTAL_COUNT"
log "本地共 $LOCAL_TOTAL_COUNT 条回放记录"

LOCAL_FILTER_SQL=""
if [ -n "$SYNC_REPLAY_RECORD_IDS" ]; then
  LOCAL_FILTER_SQL=" AND id = ANY(string_to_array('$SYNC_REPLAY_RECORD_IDS', ',')::int[])"
fi

LOCAL_COUNT=$(psql -tA "$DATABASE_URL" \
  -c "SELECT COUNT(*) FROM replay_records WHERE true$LOCAL_FILTER_SQL" 2>&1) || die "本地筛选记录失败: $LOCAL_COUNT"
if [ -n "$SYNC_REPLAY_RECORD_IDS" ]; then
  log "本地匹配 $LOCAL_COUNT 条回放记录"
fi

REMOTE_COUNT=$(psql -tA "$SUPABASE_PSQL_URL" \
  -c "SELECT COUNT(*) FROM $REMOTE_TABLE WHERE source = 'kuaishou'" 2>&1) || die "远程数据库连接失败: $REMOTE_COUNT"
log "远端 $REMOTE_TABLE 中 kuaishou 记录 $REMOTE_COUNT 条"

if [ -z "$SYNC_REPLAY_RECORD_IDS" ] && [ "$REMOTE_COUNT" -gt 0 ] && [ "$LOCAL_TOTAL_COUNT" -lt "$REMOTE_COUNT" ] && [ "$SYNC_ALLOW_SOURCE_SHRINK" != "true" ]; then
  die "本地记录数少于远端（local=$LOCAL_TOTAL_COUNT remote=$REMOTE_COUNT），已停止同步。若确认要允许源数据减少，请设置 SYNC_ALLOW_SOURCE_SHRINK=true"
fi

[ "$LOCAL_COUNT" -gt 0 ] || {
  log "无记录需要同步"
  notify_sync "sync-records 跳过" "目标表：$REMOTE_TABLE
本地记录：0
处理结果：无记录需要同步"
  exit 0
}

# ── 2. 导出本地数据为 CSV ─────────────────────────────────
# TO_CHAR 中 _ 为字面字符，无需转义
cat > "$EXPORT_SQL" <<EOF
COPY (
SELECT
  'kuaishou'                                             AS source,
  replay_id                                              AS external_id,
  principal_id,
  video_file_name,
  CASE WHEN start_time IS NOT NULL
       THEN (EXTRACT(EPOCH FROM start_time) * 1000)::bigint
       ELSE NULL END                                     AS replay_time,
  CASE WHEN start_time IS NOT NULL
       THEN TO_CHAR(start_time, 'YYYY-MM-DD_HH24_MI_SS')
       ELSE NULL END                                     AS replay_time_text,
  poster,
  duration,
  CASE WHEN start_time IS NOT NULL AND duration > 0
       THEN (EXTRACT(EPOCH FROM start_time) * 1000 - duration * 1000)::bigint
       WHEN start_time IS NOT NULL
       THEN (EXTRACT(EPOCH FROM start_time) * 1000)::bigint
       ELSE NULL END                                     AS start_live_time,
  CASE WHEN start_time IS NOT NULL AND duration > 0
       THEN TO_CHAR(start_time - (duration || ' seconds')::interval, 'YYYY-MM-DD_HH24_MI_SS')
       WHEN start_time IS NOT NULL
       THEN TO_CHAR(start_time, 'YYYY-MM-DD_HH24_MI_SS')
       ELSE NULL END                                     AS start_live_time_text,
  resolution,
  created_at,
  updated_at,
  status,
  bv_id,
  uploaded_at                                            AS upload_time,
  backed_up_at                                           AS backup_time,
  error_message
FROM replay_records
WHERE replay_id IS NOT NULL AND replay_id <> ''
$LOCAL_FILTER_SQL
ORDER BY id
) TO STDOUT WITH CSV HEADER;
EOF

psql "$DATABASE_URL" -f "$EXPORT_SQL" > "$EXPORT_CSV" || die "导出数据失败"

EXPORT_COUNT=$(wc -l < "$EXPORT_CSV")
EXPORT_COUNT=$((EXPORT_COUNT - 1))  # 减去 header 行
log "已导出 $EXPORT_COUNT 条记录（跳过 replay_id 为空的记录）"
[ "$EXPORT_COUNT" -gt 0 ] || {
  log "无有效记录需要同步"
  notify_sync "sync-records 跳过" "目标表：$REMOTE_TABLE
本地记录：$LOCAL_COUNT
导出记录：0
处理结果：无有效 replay_id 记录"
  exit 0
}

# ── 3. 创建远程暂存表 ─────────────────────────────────────
psql -q "$SUPABASE_PSQL_URL" <<EOF
CREATE TABLE IF NOT EXISTS $STAGING (
  source              VARCHAR(255) NOT NULL DEFAULT 'kuaishou',
  external_id         VARCHAR(255) NOT NULL,
  principal_id        VARCHAR(128),
  video_file_name     VARCHAR(512),
  replay_time         BIGINT,
  replay_time_text    VARCHAR(255),
  poster              TEXT,
  duration            INTEGER,
  start_live_time     BIGINT,
  start_live_time_text VARCHAR(255),
  resolution          VARCHAR(50),
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status              VARCHAR(50) DEFAULT 'pending',
  bv_id               VARCHAR(50),
  upload_time         TIMESTAMP,
  backup_time         TIMESTAMP,
  error_message       TEXT
);
EOF

[ $? -eq 0 ] || die "创建暂存表失败"

# ── 4. 导入 CSV 到暂存表 ──────────────────────────────────
psql "$SUPABASE_PSQL_URL" <<EOF
\\copy $STAGING (source, external_id, principal_id, video_file_name, replay_time, replay_time_text, poster, duration, start_live_time, start_live_time_text, resolution, created_at, updated_at, status, bv_id, upload_time, backup_time, error_message) FROM '$EXPORT_CSV' WITH CSV HEADER
EOF

[ $? -eq 0 ] || die "导入数据到暂存表失败"

STAGING_COUNT=$(psql -tA "$SUPABASE_PSQL_URL" -c "SELECT COUNT(*) FROM $STAGING" 2>&1)
log "暂存表已导入 $STAGING_COUNT 条记录"

# ── 5. UPSERT 到目标表 ───────────────────────────────────
# ON CONFLICT 基于唯一约束 (source, external_id)
UPSERT_RESULT=$(psql -tA "$SUPABASE_PSQL_URL" <<EOF
WITH upserted AS (
  INSERT INTO $REMOTE_TABLE (
    source, external_id, principal_id, video_file_name,
    replay_time, replay_time_text, poster, duration,
    start_live_time, start_live_time_text, resolution,
    created_at, updated_at, status, bv_id,
    upload_time, backup_time, error_message
  )
  SELECT
    s.source, s.external_id, s.principal_id, s.video_file_name,
    s.replay_time, s.replay_time_text, s.poster, s.duration,
    s.start_live_time, s.start_live_time_text, s.resolution,
    s.created_at, s.updated_at, s.status, s.bv_id,
    s.upload_time, s.backup_time, s.error_message
  FROM $STAGING s
  WHERE s.external_id IS NOT NULL AND s.external_id <> ''
  ON CONFLICT (source, external_id) DO UPDATE SET
    principal_id         = EXCLUDED.principal_id,
    video_file_name      = EXCLUDED.video_file_name,
    poster               = COALESCE(NULLIF(EXCLUDED.poster, ''), $REMOTE_TABLE.poster),
    duration             = EXCLUDED.duration,
    start_live_time      = EXCLUDED.start_live_time,
    start_live_time_text = EXCLUDED.start_live_time_text,
    resolution           = COALESCE(NULLIF(EXCLUDED.resolution, ''), $REMOTE_TABLE.resolution),
    status               = EXCLUDED.status,
    bv_id                = EXCLUDED.bv_id,
    upload_time          = EXCLUDED.upload_time,
    backup_time          = EXCLUDED.backup_time,
    error_message        = EXCLUDED.error_message,
    updated_at           = EXCLUDED.updated_at
  WHERE (
    $REMOTE_TABLE.principal_id,
    $REMOTE_TABLE.video_file_name,
    $REMOTE_TABLE.poster,
    $REMOTE_TABLE.duration,
    $REMOTE_TABLE.start_live_time,
    $REMOTE_TABLE.start_live_time_text,
    $REMOTE_TABLE.resolution,
    $REMOTE_TABLE.status,
    $REMOTE_TABLE.bv_id,
    $REMOTE_TABLE.upload_time,
    $REMOTE_TABLE.backup_time,
    $REMOTE_TABLE.error_message,
    $REMOTE_TABLE.updated_at
  ) IS DISTINCT FROM (
    EXCLUDED.principal_id,
    EXCLUDED.video_file_name,
    EXCLUDED.poster,
    EXCLUDED.duration,
    EXCLUDED.start_live_time,
    EXCLUDED.start_live_time_text,
    EXCLUDED.resolution,
    EXCLUDED.status,
    EXCLUDED.bv_id,
    EXCLUDED.upload_time,
    EXCLUDED.backup_time,
    EXCLUDED.error_message,
    EXCLUDED.updated_at
  )
  RETURNING 1
)
SELECT COUNT(*) FROM upserted;
EOF
) || die "UPSERT 失败: $UPSERT_RESULT"

# ── 6. 清理暂存表 ─────────────────────────────────────────
psql -q "$SUPABASE_PSQL_URL" -c "DROP TABLE IF EXISTS $STAGING" || log "警告: 暂存表清理失败（不影响同步结果）"

log "同步完成: $UPSERT_RESULT 条记录已写入 $REMOTE_TABLE"
notify_sync "sync-records 同步完成" "本地表：replay_records
目标表：$REMOTE_TABLE
本地记录：$LOCAL_TOTAL_COUNT
筛选记录：$LOCAL_COUNT
远端记录：$REMOTE_COUNT
导出记录：$EXPORT_COUNT
暂存导入：$STAGING_COUNT
变更写入：$UPSERT_RESULT"
