#!/bin/sh

# 数据库定时备份：pg_dump 全量导出 → 校验 → 落盘 → 按天保留
# 由 docker/docker-compose.cron.yml 中 replay_cron 服务调度
#
# ⚠️ 必须是 POSIX sh：replay_cron 镜像（alpine）没有 bash，只有 postgresql17-client 与 curl。
# 依赖 DATABASE_URL（与 sync-records.sh 同一份），不再读 .env、不再要求离散 DB_* 变量。

set -eu

# ── 配置 ──────────────────────────────────────────────────
DATABASE_URL="${DATABASE_URL:?DATABASE_URL 未设置}"
BACKUP_OUTPUT_DIR="${BACKUP_OUTPUT_DIR:-/data/db_backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
API_BASE="${API_BASE:-http://localhost:1123}"
CRON_HEADER_ARGS=""

if [ -n "${CRON_API_TOKEN:-}" ]; then
  CRON_HEADER_ARGS="-H X-Cron-Token:$CRON_API_TOKEN"
fi

# ── 工具函数 ──────────────────────────────────────────────
log() {
  echo "[db-backup] $(date '+%Y-%m-%d %H:%M:%S') $1"
}

notify_cron() {
  title="$1"
  content="$2"

  # shellcheck disable=SC2086
  curl -sf -X POST -G $CRON_HEADER_ARGS "$API_BASE/api/notify/feishu_webhook" \
    --data-urlencode "title=$title" \
    --data-urlencode "content=$content" >/dev/null 2>&1 || true
}

TS="$(date '+%Y%m%d_%H%M%S')"
PARTIAL=""
FINAL_PATH=""
STATUS=failed
FAIL_MSG=""

die() {
  FAIL_MSG="$1"
  log "错误: $1"
  exit 1
}

# 失败告警集中在这里：die、以及任何被 set -e 中断的意外错误都会走到这一个出口，
# 不会出现「备份没跑成但一声不响」。
finish() {
  rc=$?

  if [ -n "$PARTIAL" ]; then
    rm -f "$PARTIAL" 2>/dev/null || true
  fi

  if [ "$STATUS" = "ok" ]; then
    # 每周日一条心跳：证明任务确实在跑（纯失败告警的盲区是 cron 根本没触发）
    if [ "$(date '+%u')" = "7" ]; then
      notify_cron "db-backup 每周备份心跳" "产物：$(basename "$FINAL_PATH")
保留策略：$BACKUP_RETENTION_DAYS 天"
    fi
  else
    if [ -z "$FAIL_MSG" ]; then
      FAIL_MSG="未捕获到具体错误（set -e 中断，退出码 $rc），详见 replay_cron 日志"
    fi
    log "备份失败: $FAIL_MSG"
    notify_cron "db-backup 备份失败" "目录：$BACKUP_OUTPUT_DIR
错误：$FAIL_MSG"
  fi

  exit "$rc"
}
trap finish EXIT

log "开始备份，输出目录：$BACKUP_OUTPUT_DIR"

mkdir -p "$BACKUP_OUTPUT_DIR" || die "无法创建备份目录: $BACKUP_OUTPUT_DIR"

# ── 磁盘水位 ──────────────────────────────────────────────
# 宁可报失败，也不要把盘写满导致后续任务与数据库一起出事
DB_SIZE_KB=$(psql -tA "$DATABASE_URL" -c "SELECT (pg_database_size(current_database()) / 1024)::bigint") \
  || die "无法读取数据库大小（连接失败或权限不足）"
AVAIL_KB=$(df -Pk "$BACKUP_OUTPUT_DIR" | awk 'NR==2 {print $4}')
[ -n "$AVAIL_KB" ] || die "无法读取 $BACKUP_OUTPUT_DIR 的可用空间"

# 纯整数比较，不走 awk：BusyBox awk 对 exit !(...) 这类写法并不可靠，
# 而判定失败一旦静默返回假，水位检查就变成了摆设
NEED_KB=$((DB_SIZE_KB * 3 / 2))
[ "$AVAIL_KB" -ge "$NEED_KB" ] || die "可用空间不足：需要 ${NEED_KB} KB（库大小 ${DB_SIZE_KB} KB 的 1.5 倍），实际 ${AVAIL_KB} KB"
log "空间检查通过：库大小 ${DB_SIZE_KB} KB，需要 ${NEED_KB} KB，可用 ${AVAIL_KB} KB"

# ── 导出 ──────────────────────────────────────────────────
# -Fc 自定义格式自带压缩，且可用 pg_restore --list 校验、可选择性恢复单表
PARTIAL="$BACKUP_OUTPUT_DIR/backup_$TS.dump.partial"
FINAL_PATH="$BACKUP_OUTPUT_DIR/backup_$TS.dump"

log "正在导出（-Fc，不含 owner/ACL）..."
pg_dump --no-owner --no-acl -Fc -f "$PARTIAL" "$DATABASE_URL" \
  || die "pg_dump 执行失败，版本 $(pg_dump --version 2>/dev/null || echo unknown)"

# ── 校验 ──────────────────────────────────────────────────
# pg_dump 把 TOC 写在归档末尾，--list 读不出来即说明产物不完整；
# 半档/坏档绝不允许被 rename 成正式产物。
TOC=$(pg_restore --list "$PARTIAL") || die "归档校验失败（pg_restore --list 读不出目录，产物不完整）"
# 条目数只作诊断：空库的合法产物本来就是 0 条，不能据此判失败
ENTRIES=$(printf '%s\n' "$TOC" | grep -c '^[0-9]') || ENTRIES=0
log "归档校验通过：${ENTRIES} 个 TOC 条目"

DUMP_SIZE_KB=$(wc -c <"$PARTIAL" | awk '{print int($1 / 1024)}')
mv -f "$PARTIAL" "$FINAL_PATH" || die "写入正式产物失败: $FINAL_PATH"
PARTIAL=""
log "导出完成：$(basename "$FINAL_PATH")（${ENTRIES} 个条目，${DUMP_SIZE_KB} KB）"

# ── 保留策略 ──────────────────────────────────────────────
# 注意：旧实现写的是 -mtime +7d，`d` 后缀不是合法参数、匹配不到任何文件，
# 且 find | while 没有 pipefail，清理一直在静默空转。这里用标准写法并直接 -delete。
# 只清理本脚本产出的 backup_*.dump；历史遗留的 backup_*.sql.gz 不自动删，需人工确认。
log "清理 ${BACKUP_RETENTION_DAYS} 天前的旧备份..."
# 先取 find 的退出码再打日志：走管道会让 find 的失败被 while 的状态盖掉（旧实现的静默空转就是这么来的）
REMOVED=$(find "$BACKUP_OUTPUT_DIR" -maxdepth 1 -type f -name 'backup_*.dump' \
  -mtime +"$BACKUP_RETENTION_DAYS" -print -delete) || die "清理过期备份失败"
if [ -n "$REMOVED" ]; then
  printf '%s\n' "$REMOVED" | while read -r removed; do
    log "已清理过期备份: $(basename "$removed")"
  done
fi

# 崩溃时残留的半档（trap 没来得及跑，例如容器被强杀）；失败不影响本次备份结论
find "$BACKUP_OUTPUT_DIR" -maxdepth 1 -type f -name 'backup_*.dump.partial' \
  -mtime +1 -delete || true

STATUS=ok
log "备份脚本执行完毕"
exit 0
