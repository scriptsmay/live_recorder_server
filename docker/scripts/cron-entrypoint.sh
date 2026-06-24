#!/bin/sh
set -eu

CRONTAB_FILE=/tmp/crontab

# ── 回放定时任务 ──
if [ "$REPLAY_CRON_ENABLED" = "true" ]; then
  echo "[replay-cron] 启用，表达式: $REPLAY_CRON_EXPR"
  echo "$REPLAY_CRON_EXPR /replay-cron.sh >> /proc/1/fd/1 2>&1" >> "$CRONTAB_FILE"
else
  echo "[replay-cron] 已禁用"
fi

# ── 数据同步定时任务 ──
if [ "$SYNC_CRON_ENABLED" = "true" ] && [ -n "$SUPABASE_URL" ]; then
  echo "[sync-cron] 启用，表达式: $SYNC_CRON_EXPR，目标表: $REMOTE_TABLE"
  echo "$SYNC_CRON_EXPR /sync-records.sh >> /proc/1/fd/1 2>&1" >> "$CRONTAB_FILE"
else
  echo "[sync-cron] 已禁用（SYNC_CRON_ENABLED=$SYNC_CRON_ENABLED）"
fi

# ── Redis 事件监听 ──
REDIS_LISTENER_PID=
if [ -n "$REDIS_URL" ]; then
  echo "[redis-listener] 启用，监听 channel: $REDIS_PUBLISH_CHANNEL"
  echo "[redis-listener] REDIS_URL 已配置（凭据隐藏）"

  (
    while true; do
      echo "[redis-listener] 连接 Redis URL（已隐藏凭据），channel: $REDIS_PUBLISH_CHANNEL ..."

      redis-cli --no-auth-warning -u "$REDIS_URL" subscribe "$REDIS_PUBLISH_CHANNEL" | while read -r line; do
        if echo "$line" | grep -q "message"; then
          read -r _channel || _channel=""
          read -r payload || payload=""
          record_id=$(printf '%s' "$payload" | sed -n 's/.*"record_id"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
          if [ -n "$record_id" ]; then
            echo "[redis-listener] 收到记录 $record_id 变更通知，触发单条同步..."
            /sync-records.sh --ids "$record_id" >> /proc/1/fd/1 2>&1 || true
          else
            echo "[redis-listener] 收到任务完成通知，触发全量同步..."
            /sync-records.sh >> /proc/1/fd/1 2>&1 || true
          fi
        fi
      done

      echo "[redis-listener] Redis 连接断开，5秒后重试..."
      sleep 5
    done
  ) &
  REDIS_LISTENER_PID=$!
  echo "[redis-listener] 已启动，PID: $REDIS_LISTENER_PID"
else
  echo "[redis-listener] 未配置 REDIS_URL，已禁用"
fi

# ── 信号处理 ──
cleanup() {
  echo "[cron] 收到退出信号，清理..."
  if [ -n "$REDIS_LISTENER_PID" ]; then
    kill "$REDIS_LISTENER_PID" 2>/dev/null || true
  fi
  exit 0
}
trap cleanup TERM INT

# ── 启动 ──
if [ ! -f "$CRONTAB_FILE" ] && [ -z "$REDIS_LISTENER_PID" ]; then
  echo "[cron] 无启用的定时任务且 Redis 监听未启用，退出"
  exit 0
fi

if [ -f "$CRONTAB_FILE" ]; then
  crontab "$CRONTAB_FILE"
  echo "[cron] 当前 crontab:"
  crontab -l
  if [ -n "$REDIS_LISTENER_PID" ]; then
    crond -l 2
  else
    crond -f -l 2
  fi
fi

if [ -n "$REDIS_LISTENER_PID" ]; then
  echo "[cron] 服务已启动，等待任务..."
  wait "$REDIS_LISTENER_PID" 2>/dev/null || true
fi
