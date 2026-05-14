# 数据库文档

## PostgreSQL

### 连接信息

从 `.env` 读取以下环境变量：

| 变量 | 说明 |
|------|------|
| `DB_HOST` | 数据库主机 |
| `DB_PORT` | 数据库端口 |
| `DB_NAME` | 数据库名 |
| `DB_USER` | 数据库用户 |
| `DB_PASSWORD` | 数据库密码 |

连接池在 `db/index.js` 中创建，使用 `pg` 模块。

---

## Redis

### 连接信息

从 `.env` 读取以下环境变量：

| 变量 | 说明 |
|------|------|
| `REDIS_HOST` | Redis 主机 |
| `REDIS_PORT` | Redis 端口，默认 6379 |
| `REDIS_PASSWORD` | Redis 密码 |
| `REDIS_USER` | Redis 用户，默认 `default` |
| `REDIS_DB` | Redis 数据库编号，默认 1 |

客户端在 `db/redis.js` 中创建，使用 `redis` 模块。

### 缓存策略

| 用途 | Key 模式 | TTL | 说明 |
|------|----------|-----|------|
| 直播间缓存 | `room:{room_url}` | 5 分钟 | 减少 `getOrCreateRoom` 的 DB 查询 |
| 录制任务锁 | `active_task:{roomKey}` | 24 小时 | 防止重复录制，替代内存 Map |

- 直播间写操作（创建/更新/删除/暂停/恢复/停止）后自动清除对应缓存
- 应用启动时自动清理残留的录制任务锁

---

## 表结构

### rooms — 直播间

记录直播间状态和配置。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | SERIAL | PRIMARY KEY | 自增主键 |
| room_url | VARCHAR(512) | UNIQUE NOT NULL | 直播间地址（唯一标识） |
| room_name | VARCHAR(255) | DEFAULT '' | 直播间名称 |
| status | VARCHAR(20) | DEFAULT 'idle' | 状态：`idle` / `recording` / `paused` |
| filename_template | VARCHAR(255) | DEFAULT '{room_name}_{datetime}' | 文件名模板 |
| output_path | VARCHAR(1024) | DEFAULT '' | 最新录制文件路径 |
| ffmpeg_pid | INTEGER | | ffmpeg 进程 ID（用于暂停/恢复） |
| created_at | TIMESTAMP | DEFAULT NOW() | 创建时间 |
| updated_at | TIMESTAMP | DEFAULT NOW() | 更新时间 |

### recordings — 录制历史

记录每次录制的详情。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | SERIAL | PRIMARY KEY | 自增主键 |
| room_url | VARCHAR(512) | FK → rooms(room_url) ON DELETE CASCADE | 关联直播间 |
| file_path | VARCHAR(1024) | DEFAULT '' | 文件路径 |
| file_size | BIGINT | DEFAULT 0 | 文件大小（字节） |
| duration_seconds | INTEGER | DEFAULT 0 | 录制时长 |
| started_at | TIMESTAMP | DEFAULT NOW() | 开始时间 |
| ended_at | TIMESTAMP | | 结束时间 |
| status | VARCHAR(20) | DEFAULT 'recording' | 状态：`recording` / `completed` / `interrupted` |

---

## 迁移

应用启动时 `db/migrate.js` 自动执行建表（`CREATE TABLE IF NOT EXISTS`），无需手动操作。
