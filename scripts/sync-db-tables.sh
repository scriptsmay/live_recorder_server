#!/bin/bash
# scripts/sync-db-tables.sh
# 从生产数据库导入指定表数据到开发数据库（先清空开发库对应表再导入）
#
# 用法:
#   ./scripts/sync-db-tables.sh rooms upload_templates settings
#   ./scripts/sync-db-tables.sh --all
#   ./scripts/sync-db-tables.sh --list    # 列出所有表及依赖顺序
#   TGT_PASSWORD=xxx ./scripts/sync-db-tables.sh rooms

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# ── 日志 ──────────────────────────────────────────────
log()  { echo "[sync-db] $(date '+%H:%M:%S') $1"; }
warn() { echo "[sync-db] ⚠️  $1" >&2; }

# ── 所有表及其依赖顺序 ────────────────────────────────
# 顺序即为 import 顺序（父表在前，子表在后），DELETE 时反向
# 格式: "表名:简介"
ALL_TABLES_ORDERED=(
  "admin_users:管理员账号"
  "settings:全局设置（key-value）"
  "upload_templates:投稿模板"
  "rooms:直播间配置"
  "recording_sessions:录制会话"
  "replay_records:回放记录"
  "replay_settings:回放设置"
  "recording_files:录制文件"
  "transcode_records:转码记录"
  "danmaku_capture_records:弹幕采集记录"
  "danmaku_burn_records:弹幕压制记录"
  "upload_records:投稿记录"
  "replay_upload_records:回放投稿记录"
)

# ── 解析参数 ──────────────────────────────────────────
MODE="selected"
SELECTED_TABLES=()

if [ $# -eq 0 ]; then
  echo "用法: $0 [--all | --list | table1 table2 ...]"
  echo ""
  echo "示例:"
  echo "  $0 rooms upload_templates     # 只导入指定表"
  echo "  $0 --all                      # 导入全部表"
  echo "  $0 --list                     # 列出所有可用表"
  echo ""
  echo "环境变量覆盖（源 - 生产库）:"
  echo "  SRC_HOST  SRC_PORT  SRC_DB  SRC_USER  SRC_PASSWORD"
  echo "环境变量覆盖（目标 - 开发库，默认读 .env + .env.dev）:"
  echo "  TGT_HOST  TGT_PORT  TGT_DB  TGT_USER  TGT_PASSWORD"
  exit 0
fi

for arg in "$@"; do
  case "$arg" in
    --all)   MODE="all" ;;
    --list)  MODE="list" ;;
    *)       SELECTED_TABLES+=("$arg") ;;
  esac
done

# ── --list 模式 ───────────────────────────────────────
if [ "$MODE" = "list" ]; then
  echo "所有可用表（按导入顺序，父表→子表）:"
  echo "──────────────────────────────────────────"
  for entry in "${ALL_TABLES_ORDERED[@]}"; do
    table="${entry%%:*}"
    desc="${entry#*:}"
    printf "  %-30s %s\n" "$table" "$desc"
  done
  echo ""
  echo "依赖关系说明：父表必须先于子表导入。DELETE 时子表先删。"
  exit 0
fi

# ── 构建待导入表列表（按依赖顺序） ────────────────────
IMPORT_TABLES=()
if [ "$MODE" = "all" ]; then
  for entry in "${ALL_TABLES_ORDERED[@]}"; do
    IMPORT_TABLES+=("${entry%%:*}")
  done
else
  # 校验用户输入的表名，并按 ALL_TABLES_ORDERED 中的顺序排列
  for entry in "${ALL_TABLES_ORDERED[@]}"; do
    table="${entry%%:*}"
    for sel in "${SELECTED_TABLES[@]}"; do
      if [ "$table" = "$sel" ]; then
        IMPORT_TABLES+=("$table")
        break
      fi
    done
  done
  # 检查是否有无效表名
  for sel in "${SELECTED_TABLES[@]}"; do
    found=false
    for entry in "${ALL_TABLES_ORDERED[@]}"; do
      [ "${entry%%:*}" = "$sel" ] && found=true && break
    done
    if [ "$found" = false ]; then
      warn "未知表名: ${sel} (用 --list 查看可用表)"
    fi
  done
fi

if [ ${#IMPORT_TABLES[@]} -eq 0 ]; then
  warn "没有可导入的表"
  exit 1
fi

# ── 加载目标（开发库）配置 ────────────────────────────
# .env.dev 覆盖 .env
for env_file in "$PROJECT_DIR/.env" "$PROJECT_DIR/.env.dev"; do
  if [ -f "$env_file" ]; then
    while IFS='=' read -r key value; do
      # 跳过注释和空行
      [[ "$key" =~ ^[[:space:]]*# ]] && continue
      [[ -z "$key" ]] && continue
      # 去除首尾空格和引号
      key=$(echo "$key" | xargs)
      value=$(echo "$value" | xargs | sed 's/^"//;s/"$//;s/^'"'"'//;s/'"'"'$//')
      export "$key=$value"
    done < "$env_file"
  fi
done

# 目标（开发）DB 配置：环境变量 > .env 文件中的值 > 默认值
TGT_HOST="${TGT_HOST:-${DB_HOST:-127.0.0.1}}"
TGT_PORT="${TGT_PORT:-${DB_PORT:-5432}}"
TGT_DB="${TGT_DB:-${DB_NAME:-live_recorder}}"
TGT_USER="${TGT_USER:-${DB_USER:-postgres}}"
TGT_PASSWORD="${TGT_PASSWORD:-${DB_PASSWORD:-}}"

# 源（生产）DB 配置：环境变量 > .env / .env.dev 中的 SRC_* > .env 的 DB_* 连接参数
# 注意：本仓库为公开仓库，不在脚本里硬编码生产地址，缺省时直接报错退出
SRC_HOST="${SRC_HOST:-${DB_HOST:-}}"
SRC_PORT="${SRC_PORT:-${DB_PORT:-5432}}"
SRC_DB="${SRC_DB:-live_recorder}"
SRC_USER="${SRC_USER:-${DB_USER:-postgres}}"
SRC_PASSWORD="${SRC_PASSWORD:-${DB_PASSWORD:-}}"

if [ -z "$SRC_HOST" ]; then
  warn "未配置源（生产）数据库地址"
  echo "  请在 .env / .env.dev 中设置 SRC_HOST（可选 SRC_PORT），或通过环境变量传入："
  echo "    SRC_HOST=<prod-host> SRC_PORT=<prod-port> $0 $*"
  exit 1
fi

# ── 依赖检查 ──────────────────────────────────────────
for cmd in pg_dump psql; do
  if ! command -v "$cmd" &>/dev/null; then
    # Mac 上 pg_dump 可能在 /opt/homebrew/opt/libpq/bin
    if [ -x "/opt/homebrew/opt/libpq/bin/$cmd" ]; then
      export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
    elif [ -x "/usr/local/opt/libpq/bin/$cmd" ]; then
      export PATH="/usr/local/opt/libpq/bin:$PATH"
    else
      log "缺少 ${cmd}, 尝试安装..."
      if [[ "$OSTYPE" == darwin* ]] && command -v brew &>/dev/null; then
        brew install libpq
        export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
      else
        log "请手动安装 PostgreSQL 客户端工具 (libpq)"
        exit 1
      fi
    fi
  fi
done

# ── 确认提示 ──────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "  数据库表同步：生产 → 开发"
echo "═══════════════════════════════════════════════"
echo "  源（生产）: ${SRC_USER}@${SRC_HOST}:${SRC_PORT}/${SRC_DB}"
echo "  目标（开发）: ${TGT_USER}@${TGT_HOST}:${TGT_PORT}/${TGT_DB}"
echo "───────────────────────────────────────────────"
echo "  将先清空开发库以下表，再导入生产数据:"
for table in "${IMPORT_TABLES[@]}"; do
  printf "    - %s\n" "$table"
done
echo "═══════════════════════════════════════════════"
echo ""

if [ -z "$SRC_PASSWORD" ]; then
  warn "SRC_PASSWORD 未设置，生产数据库可能要求密码"
fi
if [ -z "$TGT_PASSWORD" ]; then
  warn "TGT_PASSWORD / DB_PASSWORD 未设置，开发数据库可能要求密码"
fi

# 非交互确认
if [ -t 0 ]; then
  read -r -p "确认执行? [y/N] " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    log "已取消"
    exit 0
  fi
fi

# ── 构建 psql / pg_dump 通用参数 ─────────────────────
build_psql_args() {
  local host="$1" port="$2" user="$3" db="$4"
  local args="-h $host -p $port -U $user -d $db"
  # 如果 host 不是 localhost/127.0.0.1，不强制本地连接
  echo "$args"
}

SRC_PSQL_ARGS=$(build_psql_args "$SRC_HOST" "$SRC_PORT" "$SRC_USER" "$SRC_DB")
TGT_PSQL_ARGS=$(build_psql_args "$TGT_HOST" "$TGT_PORT" "$TGT_USER" "$TGT_DB")

# ── 临时文件 ──────────────────────────────────────────
TMPDIR="${TMPDIR:-/tmp}"
DUMP_FILE="$TMPDIR/sync_db_$$.sql"
cleanup() { rm -f "$DUMP_FILE"; }
trap cleanup EXIT

# ── 构建 pg_dump table 参数 ──────────────────────────
DUMP_TABLE_ARGS=""
for table in "${IMPORT_TABLES[@]}"; do
  DUMP_TABLE_ARGS="$DUMP_TABLE_ARGS --table=$table"
done

# ── Step 1: 从生产库导出 ─────────────────────────────
log "Step 1/3: 从生产库导出数据..."

export PGPASSWORD="$SRC_PASSWORD"
if ! pg_dump \
  $SRC_PSQL_ARGS \
  --data-only \
  --inserts \
  --no-owner \
  --no-acl \
  --no-comments \
  --rows-per-insert=100 \
  $DUMP_TABLE_ARGS \
  > "$DUMP_FILE" 2>/tmp/sync_db_err_$$.log; then
  warn "pg_dump 失败，请检查源数据库连接和密码"
  cat /tmp/sync_db_err_$$.log 2>/dev/null || true
  exit 1
fi
unset PGPASSWORD

DUMP_SIZE=$(wc -c < "$DUMP_FILE" | tr -d ' ')
log "  导出完成，$(wc -l < "$DUMP_FILE" | tr -d ' ') 行，${DUMP_SIZE} 字节"

if [ "$DUMP_SIZE" -lt 50 ]; then
  warn "导出数据极少（${DUMP_SIZE} 字节），可能源表为空或连接有问题"
fi

# ── Step 2: 清空开发库对应表（反向依赖顺序） ─────────
log "Step 2/3: 清空开发库表..."

export PGPASSWORD="$TGT_PASSWORD"

# 反向遍历，先删子表避免 FK 冲突
for ((i=${#IMPORT_TABLES[@]}-1; i>=0; i--)); do
  table="${IMPORT_TABLES[$i]}"
  log "  DELETE FROM $table"
  psql $TGT_PSQL_ARGS -c "DELETE FROM \"$table\"" >/dev/null 2>&1 || {
    # DELETE 可能因为 FK 约束失败（其他未导入的表引用了当前表）
    # 尝试 TRUNCATE ... CASCADE（会级联删除引用行）
    warn "  DELETE FROM $table 失败（可能有其他表引用），尝试 TRUNCATE CASCADE..."
    psql $TGT_PSQL_ARGS -c "TRUNCATE \"$table\" CASCADE" >/dev/null 2>&1 || {
      warn "  TRUNCATE $table 也失败: $(psql $TGT_PSQL_ARGS -c 'TRUNCATE \"$table\" CASCADE' 2>&1)"
    }
  }
done

log "  清空完成"

# ── Step 3: 导入到开发库 ─────────────────────────────
log "Step 3/3: 导入数据到开发库..."

# reset sequences after import by running psql with the file
if psql $TGT_PSQL_ARGS -v ON_ERROR_STOP=1 -f "$DUMP_FILE" > /tmp/sync_db_import_$$.log 2>&1; then
  log "  导入完成"
else
  warn "导入过程中出现错误:"
  tail -20 /tmp/sync_db_import_$$.log 2>/dev/null || true
  
  # 常见错误处理：序列冲突
  if grep -q "duplicate key" /tmp/sync_db_import_$$.log 2>/dev/null; then
    warn "检测到主键冲突，可能未完全清空表。请确保已导入与其关联的所有子表。"
    warn "用法: $0 --all 导入全部表可避免此问题。"
  fi
  exit 1
fi

unset PGPASSWORD

# ── 汇总 ──────────────────────────────────────────────
log "同步完成!"
echo ""

# 显示各表行数
export PGPASSWORD="$TGT_PASSWORD"
printf "  %-30s %8s\n" "表名" "行数"
printf "  %-30s %8s\n" "──────────────────────────────" "──────────"
for table in "${IMPORT_TABLES[@]}"; do
  count=$(psql $TGT_PSQL_ARGS -tA -c "SELECT COUNT(*) FROM \"$table\"" 2>/dev/null || echo "?")
  printf "  %-30s %8s\n" "$table" "$count"
done
unset PGPASSWORD

echo ""
log "开发数据库 ${TGT_DB} 已更新"

# 清理临时错误日志
rm -f /tmp/sync_db_err_$$.log /tmp/sync_db_import_$$.log
