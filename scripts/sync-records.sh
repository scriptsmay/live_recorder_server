#!/bin/sh

# 回放记录同步脚本：本地 PostgreSQL replay_records → 远程 Supabase
# 测试阶段默认写入 test_records，通过 REMOTE_TABLE 环境变量切换
# 由 docker/docker-compose.cron.yml 中 replay_cron 服务调度，使用 psql 直连两边数据库

set -e

# ── 配置 ──────────────────────────────────────────────────
DATABASE_URL="${DATABASE_URL:?DATABASE_URL 未设置}"
SUPABASE_URL="${SUPABASE_URL:?SUPABASE_URL 未设置}"
REMOTE_TABLE="${REMOTE_TABLE:-test_records}"
TMPDIR="${TMPDIR:-/tmp}"
EXPORT_CSV="$TMPDIR/sync_replay_$$.csv"
STAGING="_staging_sync_$$"

# ── 工具函数 ──────────────────────────────────────────────
log() {
  echo "[sync-records] $(date '+%Y-%m-%d %H:%M:%S') $1"
}

cleanup() {
  rm -f "$EXPORT_CSV"
  # 尽力清理远程暂存表，忽略错误
  psql -q "$SUPABASE_URL" -c "DROP TABLE IF EXISTS $STAGING" 2>/dev/null || true
}
trap cleanup EXIT

die() {
  log "错误: $1"
  exit 1
}

# ── 1. 连接检查 ───────────────────────────────────────────
log "开始同步 replay_records → $REMOTE_TABLE"

LOCAL_COUNT=$(psql -tA "$DATABASE_URL" \
  -c "SELECT COUNT(*) FROM replay_records" 2>&1) || die "本地数据库连接失败: $LOCAL_COUNT"
log "本地共 $LOCAL_COUNT 条回放记录"

[ "$LOCAL_COUNT" -gt 0 ] || { log "无记录需要同步"; exit 0; }

# ── 2. 导出本地数据为 CSV ─────────────────────────────────
# TO_CHAR 中 _ 为字面字符，无需转义
psql "$DATABASE_URL" <<EOF
\\copy (
  SELECT
    'kuaishou'                                             AS source,
    replay_id                                              AS external_id,
    principal_id,
    video_file_name,
    NULL::bigint                                           AS replay_time,
    NULL::varchar                                          AS replay_time_text,
    NULL::text                                             AS poster,
    duration,
    CASE WHEN start_time IS NOT NULL
         THEN (EXTRACT(EPOCH FROM start_time) * 1000)::bigint
         ELSE NULL END                                     AS start_live_time,
    CASE WHEN start_time IS NOT NULL
         THEN TO_CHAR(start_time, 'YYYY-MM-DD_HH24_MI_SS')
         ELSE NULL END                                     AS start_live_time_text,
    NULL::varchar                                          AS resolution,
    created_at,
    NOW()                                                  AS updated_at,
    status,
    bv_id,
    uploaded_at                                            AS upload_time,
    backed_up_at                                           AS backup_time,
    error_message
  FROM replay_records
  WHERE replay_id IS NOT NULL AND replay_id <> ''
  ORDER BY id
) TO '$EXPORT_CSV' WITH CSV HEADER
EOF

[ $? -eq 0 ] || die "导出数据失败"

EXPORT_COUNT=$(wc -l < "$EXPORT_CSV")
EXPORT_COUNT=$((EXPORT_COUNT - 1))  # 减去 header 行
log "已导出 $EXPORT_COUNT 条记录（跳过 replay_id 为空的记录）"
[ "$EXPORT_COUNT" -gt 0 ] || { log "无有效记录需要同步"; exit 0; }

# ── 3. 创建远程暂存表 ─────────────────────────────────────
psql -q "$SUPABASE_URL" <<EOF
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
psql "$SUPABASE_URL" <<EOF
\\copy $STAGING (source, external_id, principal_id, video_file_name, replay_time, replay_time_text, poster, duration, start_live_time, start_live_time_text, resolution, created_at, updated_at, status, bv_id, upload_time, backup_time, error_message) FROM '$EXPORT_CSV' WITH CSV HEADER
EOF

[ $? -eq 0 ] || die "导入数据到暂存表失败"

STAGING_COUNT=$(psql -tA "$SUPABASE_URL" -c "SELECT COUNT(*) FROM $STAGING" 2>&1)
log "暂存表已导入 $STAGING_COUNT 条记录"

# ── 5. UPSERT 到目标表 ───────────────────────────────────
# ON CONFLICT 基于唯一约束 (source, external_id)
UPSERT_RESULT=$(psql -tA "$SUPABASE_URL" <<EOF
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
    duration             = EXCLUDED.duration,
    start_live_time      = EXCLUDED.start_live_time,
    start_live_time_text = EXCLUDED.start_live_time_text,
    status               = EXCLUDED.status,
    bv_id                = EXCLUDED.bv_id,
    upload_time          = EXCLUDED.upload_time,
    backup_time          = EXCLUDED.backup_time,
    error_message        = EXCLUDED.error_message,
    updated_at           = NOW()
  RETURNING 1
)
SELECT COUNT(*) FROM upserted;
EOF
) || die "UPSERT 失败: $UPSERT_RESULT"

# ── 6. 清理暂存表 ─────────────────────────────────────────
psql -q "$SUPABASE_URL" -c "DROP TABLE IF EXISTS $STAGING" || log "警告: 暂存表清理失败（不影响同步结果）"

log "同步完成: $UPSERT_RESULT 条记录已写入 $REMOTE_TABLE"
