#!/bin/sh

# 回放定时任务触发器
# 通过 curl 调用后端 API 触发队列，不直接执行重度任务
# 由 docker-compose.yml 中的 replay_cron 服务调度

set -e

API_BASE="${API_BASE:-http://localhost:1123}"
PRINCIPAL_ID="${REPLAY_PRINCIPAL_ID:-}"
COUNT="${REPLAY_CRON_COUNT:-1}"

log() {
  echo "[replay-cron] $(date '+%Y-%m-%d %H:%M:%S') $1"
}

if [ -z "$PRINCIPAL_ID" ]; then
  log "REPLAY_PRINCIPAL_ID 未设置，跳过"
  exit 0
fi

# 先同步最新回放列表
log "同步主播 $PRINCIPAL_ID 最近 $COUNT 条回放..."
SYNC_RESULT=$(curl -sf -X POST "$API_BASE/api/replay/records/sync" \
  -H 'Content-Type: application/json' \
  -d "{\"principal_id\":\"$PRINCIPAL_ID\",\"count\":$COUNT}" 2>&1) || {
  log "同步失败: $SYNC_RESULT"
  exit 1
}
log "同步完成: $SYNC_RESULT"

# 将未完成的回放入队
log "入队主播 $PRINCIPAL_ID 最近 $COUNT 条回放..."
ENQUEUE_RESULT=$(curl -sf -X POST "$API_BASE/api/replay/tasks/enqueue" \
  -H 'Content-Type: application/json' \
  -d "{\"principal_id\":\"$PRINCIPAL_ID\",\"count\":$COUNT,\"skip_completed\":true}" 2>&1) || {
  log "入队失败: $ENQUEUE_RESULT"
  exit 1
}
log "入队完成: $ENQUEUE_RESULT"

log "定时任务触发完成"
