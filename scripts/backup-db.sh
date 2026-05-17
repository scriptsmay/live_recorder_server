#!/bin/bash

# 设置错误即停止运行（如果在自动安装过程中出错，脚本会立即中断并报错）
set -e

# 获取当前脚本所在目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
BACKUP_DIR="$SCRIPT_DIR/../backups"
ENV_FILE="$SCRIPT_DIR/../.env"
RETENTION_DAYS=7

# 日志函数
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "[环境检查] 正在检查备份前置依赖..."

# ==================== 前置步骤：自动确保安装 pg_dump ====================
if ! command -v pg_dump &> /dev/null; then
    log "[环境检查] 未检测到 pg_dump 命令，开始准备自动安装..."
    
    # 1. 检查是否是 Mac 系统
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # 2. 检查有没有安装 Homebrew
        if ! command -v brew &> /dev/null; then
            log "[环境检查] 未检测到 Homebrew，正在为您安装 Homebrew (可能会提示输入 Mac 开机密码)..."
            # 运行 Homebrew 官方安装脚本
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            
            # 针对 Mac Mini (M1/M2/M3 芯片或 Intel 芯片) 自动配置 brew 环境变量
            if [ -f /opt/homebrew/bin/brew ]; then
                eval "$(/opt/homebrew/bin/brew shellenv)"
            elif [ -f /usr/local/bin/brew ]; then
                eval "$(/usr/local/bin/brew shellenv)"
            fi
        fi
        
        # 3. 使用 Homebrew 安装 postgresql 客户端工具 (libpq)
        log "[环境检查] 正在通过 Homebrew 安装 PostgreSQL 客户端工具集 (libpq)..."
        brew install libpq
        
        # 4. 将 libpq 路径临时链接或加入到当前脚本的 PATH 中，确保接下来的命令能找到 pg_dump
        if [ -d "/opt/homebrew/opt/libpq/bin" ]; then
            export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
        elif [ -d "/usr/local/opt/libpq/bin" ]; then
            export PATH="/usr/local/opt/libpq/bin:$PATH"
        fi
        
        # 再次验证是否成功
        if ! command -v pg_dump &> /dev/null; then
            log "[错误] pg_dump 安装失败，请尝试在终端手动运行 'brew install libpq' 后再试。"
            exit 1
        fi
        log "[环境检查] pg_dump 安装并配置成功！当前版本: $(pg_dump --version)"
    else
        log "[错误] 当前不是 Mac 环境，自动化脚本暂不支持在此系统上自动安装 pg_dump，请手动安装 postgresql-client"
        exit 1
    fi
else
    # 如果已经有 pg_dump 了，但可能由于 Mac 上的环境变量问题 crontab 找不到它
    # 我们顺便帮 Crontab 兜个底，把常见的 Mac 软件安装路径都塞进 PATH 里
    export PATH="/opt/homebrew/bin:/opt/homebrew/opt/libpq/bin:/usr/local/bin:/usr/local/opt/libpq/bin:$PATH"
    log "[环境检查] 依赖检查通过，pg_dump 已就绪: $(pg_dump --version)"
fi
# ======================================================================

log "[备份] 开始执行核心备份任务..."

# 加载环境变量
if [ -f "$ENV_FILE" ]; then
    export $(grep -v '^#' "$ENV_FILE" | xargs)
else
    log "[错误] 未找到 .env 配置文件: $ENV_FILE"
    exit 1
fi

DB_PORT=${DB_PORT:-5432}

# 检查必要的环境变量是否存在
if [ -z "$DB_HOST" ] || [ -z "$DB_USER" ] || [ -z "$DB_NAME" ] || [ -z "$DB_PASSWORD" ]; then
    log "[错误] .env 中缺少必要的数据库配置信息"
    exit 1
fi

# 确保备份目录存在
mkdir -p "$BACKUP_DIR"

# 生成带时间戳的文件名
TS=$(date '+%Y-%m-%d_%H-%M-%S')
FILE_PATH="$BACKUP_DIR/backup_$TS.sql"

log "[备份] 正在从远程数据库 [ $DB_HOST ] 导出并压缩数据..."

export PGPASSWORD="$DB_PASSWORD"

# 执行 pg_dump 并通过管道压缩
if pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl | gzip > "$FILE_PATH.gz"; then
    log "[备份] 导出并压缩成功: $FILE_PATH.gz"
else
    log "[崩溃] pg_dump 或 gzip 执行失败！"
    rm -f "$FILE_PATH.gz"
    exit 1
fi

unset PGPASSWORD

# 清理 7 天前的旧备份
log "[备份] 开始检查并清理过期备份..."
# 注意：Mac 系统的 find 命令和 Linux 略有不同，这里做了全面兼容
find "$BACKUP_DIR" -type f \( -name "*.gz" -o -name "*.sql" \) -mtime +${RETENTION_DAYS}d -exec rm -f {} \; -print | while read -r deleted_file; do
    log "[备份] 已成功清理过期文件: $(basename "$deleted_file")"
done

log "[完成] 备份脚本安全执行完毕。"
exit 0