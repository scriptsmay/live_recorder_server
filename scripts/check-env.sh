#!/bin/bash

# ============================================================
#  系统环境工具检测脚本
#  读取 .env 环境变量，判断项目调用的外部程序是否已安装，
#  并检查关键目录和服务连通性。
#
#  用法：
#    bash scripts/check-env.sh          # 检查生产环境 (.env)
#    bash scripts/check-env.sh --dev    # 检查开发环境 (.env + .env.dev)
# ============================================================

# 不使用 set -e（检测脚本应跑完所有项再汇总）
# 不使用 set -u（环境变量可能未设置，用 ${VAR:-} 兼容）
set -o pipefail

# ─── 颜色定义 ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ─── 路径与变量 ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
ENV_DEV_FILE="$PROJECT_DIR/.env.dev"

# 计数器
PASS=0
FAIL=0
WARN=0

# ─── 工具函数 ──────────────────────────────────────────────
log_pass() { ((PASS++)); echo -e "  ${GREEN}✔${RESET} $1"; }
log_fail() { ((FAIL++)); echo -e "  ${RED}✘${RESET} $1"; }
log_warn() { ((WARN++)); echo -e "  ${YELLOW}⚠${RESET} $1"; }
log_info() { echo -e "  ${CYAN}ℹ${RESET} $1"; }

section() { echo -e "\n${BOLD}$1${RESET}"; }

# 获取命令版本号（尝试 --version / -version，取第一行）
get_version() {
  local cmd="$1"
  local ver
  ver=$("$cmd" --version 2>/dev/null | head -1) || true
  if [ -z "$ver" ]; then
    ver=$("$cmd" -version 2>/dev/null | head -1) || true
  fi
  if [ -z "$ver" ]; then
    ver="(version unknown)"
  fi
  echo "$ver"
}

# 加载 .env（去掉注释行和空行，处理带引号的值）
load_env() {
  local file="$1"
  if [ ! -f "$file" ]; then
    return 1
  fi
  while IFS='=' read -r key value; do
    # 跳过注释和空行
    [ -z "$key" ] && continue
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    # 去除首尾空白
    key="$(echo "$key" | xargs)"
    value="$(echo "$value" | xargs)"
    # 去除值两端的引号
    value="${value#\"}" ; value="${value%\"}"
    value="${value#\'}" ; value="${value%\'}"
    # 仅设置尚未导出的变量（.env.dev 覆盖 .env）
    if [ -z "${!key+x}" ]; then
      export "$key=$value"
    fi
  done < <(grep -v '^[[:space:]]*#' "$file" | grep -v '^[[:space:]]*$')
}

# 检查命令是否存在
check_cmd() {
  local cmd="$1"
  local label="${2:-$cmd}"
  if command -v "$cmd" &>/dev/null; then
    local ver
    ver=$(get_version "$cmd")
    log_pass "$label — ${CYAN}${ver}${RESET}"
    return 0
  else
    log_fail "$label — 未找到命令 '$cmd'"
    return 1
  fi
}

# 检查自定义路径的命令（如 BILIUP_PATH）
check_custom_cmd() {
  local env_key="$1"
  local label="$2"
  local cmd_path="${!env_key:-}"
  if [ -z "$cmd_path" ]; then
    # 未配置环境变量，尝试 PATH 中查找
    if command -v "$label" &>/dev/null; then
      local ver
      ver=$(get_version "$label")
      log_pass "$label (PATH) — ${CYAN}${ver}${RESET}"
      return 0
    else
      log_warn "$label — 未配置 $env_key 且 PATH 中未找到"
      return 1
    fi
  fi
  # 去除引号
  cmd_path="${cmd_path#\"}" ; cmd_path="${cmd_path%\"}"
  cmd_path="${cmd_path#\'}" ; cmd_path="${cmd_path%\'}"
  if [ -x "$cmd_path" ]; then
    local ver
    ver=$(get_version "$cmd_path")
    log_pass "$label ($cmd_path) — ${CYAN}${ver}${RESET}"
    return 0
  else
    log_fail "$label — $env_key='$cmd_path' 路径不存在或不可执行"
    return 1
  fi
}

# ─── 加载环境变量 ──────────────────────────────────────────
USE_DEV=false
if [ "${1:-}" = "--dev" ]; then
  USE_DEV=true
fi

echo -e "${BOLD}═══════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  K-Recorder — 系统环境检测${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════════${RESET}"
echo -e "  项目路径: $PROJECT_DIR"

if [ "$USE_DEV" = true ]; then
  echo -e "  检测模式: ${YELLOW}开发环境${RESET} (.env + .env.dev)"
else
  echo -e "  检测模式: ${GREEN}生产环境${RESET} (.env)"
fi

if ! load_env "$ENV_FILE"; then
  log_fail ".env 文件不存在: $ENV_FILE"
  echo -e "\n${RED}无法继续，请先创建 .env 配置文件${RESET}"
  exit 1
fi

if [ "$USE_DEV" = true ]; then
  if ! load_env "$ENV_DEV_FILE"; then
    log_warn ".env.dev 文件不存在: $ENV_DEV_FILE（将使用 .env 默认值）"
  fi
fi

# ─── 1. 必需的外部命令 ─────────────────────────────────────
section "1. 必需的外部命令"

# ffmpeg — 录制引擎 + 转码
check_cmd "ffmpeg" "ffmpeg（录制引擎 + 转码）"

# ─── 2. 条件性外部命令 ─────────────────────────────────────
section "2. 条件性外部命令（按配置检测）"

# biliup — 投稿工具（BILIUP_PATH 可指定路径）
check_custom_cmd "BILIUP_PATH" "biliup（投稿工具）"

# rsync — NAS 备份（仅 NAS 配置存在时需要）
if [ -n "${NAS_HOST:-}" ] || [ -n "${NAS_USER:-}" ] || [ -n "${NAS_BACKUP_DIR:-}" ]; then
  check_cmd "rsync" "rsync（NAS 备份）"
else
  log_info "rsync — 未配置 NAS 备份，跳过检测"
fi

# pg_dump — 数据库备份脚本（仅 backup-db.sh 需要，非服务必需）
if command -v pg_dump &>/dev/null; then
  log_pass "pg_dump（数据库备份） — $(pg_dump --version 2>/dev/null | head -1)"
else
  log_warn "pg_dump（数据库备份） — 未安装，backup-db.sh 脚本将不可用"
fi

# ─── 3. 基础服务连通性 ─────────────────────────────────────
section "3. 基础服务连通性"

# PostgreSQL 连通性
DB_PORT="${DB_PORT:-5432}"
if [ -n "${DB_HOST:-}" ] && [ -n "${DB_USER:-}" ] && [ -n "${DB_NAME:-}" ]; then
  if command -v psql &>/dev/null; then
    PGPASSWORD="${DB_PASSWORD:-}" psql \
      -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
      -c "SELECT 1" &>/dev/null && \
      log_pass "PostgreSQL — $DB_HOST:$DB_PORT/$DB_NAME 连接成功" || \
      log_fail "PostgreSQL — $DB_HOST:$DB_PORT/$DB_NAME 连接失败"
  else
    log_warn "PostgreSQL — psql 未安装，无法测试连通性（配置: $DB_HOST:$DB_PORT/$DB_NAME）"
  fi
else
  log_fail "PostgreSQL — 环境变量不完整（需要 DB_HOST, DB_USER, DB_NAME）"
fi

# Redis 连通性
REDIS_PORT="${REDIS_PORT:-6379}"
if [ -n "${REDIS_HOST:-}" ]; then
  if command -v redis-cli &>/dev/null; then
    REDIS_CMD="redis-cli -h $REDIS_HOST -p $REDIS_PORT"
    if [ -n "${REDIS_PASSWORD:-}" ]; then
      REDIS_CMD="$REDIS_CMD -a $REDIS_PASSWORD"
    fi
    # redis-cli 7.0+ 会警告明文密码，输出重定向到 /dev/null
    if $REDIS_CMD ping 2>/dev/null | grep -q PONG; then
      log_pass "Redis — $REDIS_HOST:$REDIS_PORT 连接成功"
    else
      log_fail "Redis — $REDIS_HOST:$REDIS_PORT 连接失败"
    fi
  else
    log_warn "Redis — redis-cli 未安装，无法测试连通性（配置: $REDIS_HOST:$REDIS_PORT）"
  fi
else
  log_fail "Redis — 未配置 REDIS_HOST"
fi

# ─── 4. 关键目录检测 ───────────────────────────────────────
section "4. 关键目录检测"

# VIDEO_DOWNLOAD_DIR — 录制文件下载目录
if [ -n "${VIDEO_DOWNLOAD_DIR:-}" ]; then
  if [ -d "$VIDEO_DOWNLOAD_DIR" ]; then
    log_pass "VIDEO_DOWNLOAD_DIR — $VIDEO_DOWNLOAD_DIR 存在"
  else
    log_fail "VIDEO_DOWNLOAD_DIR — $VIDEO_DOWNLOAD_DIR 目录不存在（启动时会自动创建）"
  fi
else
  log_fail "VIDEO_DOWNLOAD_DIR — 未配置，录制功能将不可用"
fi

# BILIUP_WORK_DIR — biliup 工作目录
if [ -n "${BILIUP_WORK_DIR:-}" ]; then
  if [ -d "$BILIUP_WORK_DIR" ]; then
    log_pass "BILIUP_WORK_DIR — $BILIUP_WORK_DIR 存在"
  else
    log_warn "BILIUP_WORK_DIR — $BILIUP_WORK_DIR 目录不存在（启动时会自动创建）"
  fi
fi

# NAS_BACKUP_DIR — 仅提示，不检查本地是否存在（远程目录）
if [ -n "${NAS_BACKUP_DIR:-}" ]; then
  log_info "NAS_BACKUP_DIR — ${NAS_USER:-}@${NAS_HOST:-}:$NAS_BACKUP_DIR（远程目录，仅在线检测）"
fi

# ─── 5. 关键环境变量完整性 ──────────────────────────────────
section "5. 关键环境变量完整性"

check_env() {
  local key="$1"
  local desc="${2:-$key}"
  if [ -n "${!key:-}" ]; then
    log_pass "$key — $desc"
  else
    log_fail "$key — 未配置（$desc）"
  fi
}

check_env "DB_HOST"     "数据库主机"
check_env "DB_PORT"     "数据库端口（默认 5432）"
check_env "DB_NAME"     "数据库名称"
check_env "DB_USER"     "数据库用户"
check_env "DB_PASSWORD" "数据库密码"
check_env "REDIS_HOST"  "Redis 主机"
check_env "REDIS_PORT"  "Redis 端口（默认 6379）"

# ─── 6. 可选环境变量 ────────────────────────────────────────
section "6. 可选环境变量"

check_env_opt() {
  local key="$1"
  local desc="${2:-$key}"
  if [ -n "${!key:-}" ]; then
    log_pass "$key — 已配置"
  else
    log_warn "$key — 未配置（$desc）"
  fi
}

check_env_opt "VIDEO_DOWNLOAD_DIR"  "录制必需"
check_env_opt "BILIUP_PATH"         "投稿功能需要"
check_env_opt "BILIUP_WORK_DIR"     "biliup 工作目录"
# check_env_opt "NAS_HOST"            "NAS 备份功能需要"
# check_env_opt "NAS_USER"            "NAS 备份功能需要"
# check_env_opt "NAS_BACKUP_DIR"      "NAS 备份功能需要"
check_env_opt "MESSAGE_FEISHU_WEBHOOK" "飞书通知"
check_env_opt "MESSAGE_GOTIFY_SERVER"  "Gotify 通知"
check_env_opt "MESSAGE_GOTIFY_TOKEN"   "Gotify 通知"

# ─── 7. Node.js 环境 ───────────────────────────────────────
section "7. Node.js 环境"

if command -v node &>/dev/null; then
  log_pass "Node.js — $(node --version)"
  if command -v npm &>/dev/null; then
    log_pass "npm — $(npm --version)"
  fi
  # 检查 node_modules 是否完整
  if [ -d "$PROJECT_DIR/node_modules" ]; then
    log_pass "node_modules — 依赖已安装"
  else
    log_fail "node_modules — 未安装依赖，请运行 npm install"
  fi
else
  log_fail "Node.js — 未安装"
fi

# ─── 汇总 ──────────────────────────────────────────────────
echo -e "\n${BOLD}═══════════════════════════════════════════════${RESET}"
echo -e "  ${GREEN}通过: $PASS${RESET}  ${RED}失败: $FAIL${RESET}  ${YELLOW}警告: $WARN${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════════${RESET}"

if [ "$FAIL" -gt 0 ]; then
  echo -e "\n${RED}${BOLD}存在未通过的项目，请根据上述提示修复后再启动服务。${RESET}\n"
  exit 1
else
  echo -e "\n${GREEN}${BOLD}所有必需项检测通过！${RESET}\n"
  exit 0
fi
