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
| segment_duration | INTEGER | DEFAULT 0 | 分段录制时长（秒），0 表示不分段 |
| notification_enabled | BOOLEAN | DEFAULT TRUE | 通知开关，关闭后不发送录制/投稿通知 |
| monitoring_enabled | BOOLEAN | DEFAULT TRUE | 监听开关，关闭后 API 触发时不启动 ffmpeg |
| created_at | TIMESTAMP | DEFAULT NOW() | 创建时间 |
| updated_at | TIMESTAMP | DEFAULT NOW() | 更新时间 |

### recording_sessions — 录制会话

每次连续直播录制创建一个会话，包含一个或多个分片文件。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | SERIAL | PRIMARY KEY | 自增主键 |
| room_url | VARCHAR(512) | FK → rooms(room_url) ON DELETE CASCADE | 关联直播间 |
| started_at | TIMESTAMP | DEFAULT NOW() | 会话开始时间 |
| ended_at | TIMESTAMP | | 会话结束时间 |
| status | VARCHAR(20) | DEFAULT 'recording' | `recording` / `completed` / `interrupted` |
| total_segments | INTEGER | DEFAULT 0 | 分片文件数 |
| total_size | BIGINT | DEFAULT 0 | 总大小（字节） |
| output_dir | VARCHAR(1024) | DEFAULT '' | 输出目录 |
| caption | VARCHAR(1024) | DEFAULT '' | 直播描述/备注 |
| retry_count | INTEGER | DEFAULT 0 | 崩溃恢复重试次数 |
| stream_url | VARCHAR(1024) | DEFAULT '' | 实际直播流地址（用于重启后恢复 ffmpeg） |
| deleted_at | TIMESTAMP | | 软删除时间 |
| created_at | TIMESTAMP | DEFAULT NOW() | |

### recordings — 录制文件

记录每个分片文件的详情。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | SERIAL | PRIMARY KEY | 自增主键 |
| session_id | INTEGER | FK → recording_sessions(id) ON DELETE SET NULL | 所属会话 |
| segment_index | INTEGER | DEFAULT 0 | 分片序号 |
| room_url | VARCHAR(512) | FK → rooms(room_url) ON DELETE CASCADE | 关联直播间 |
| file_path | VARCHAR(1024) | DEFAULT '' | 文件路径 |
| file_size | BIGINT | DEFAULT 0 | 文件大小（字节） |
| started_at | TIMESTAMP | DEFAULT NOW() | 开始时间 |
| ended_at | TIMESTAMP | | 结束时间 |
| status | VARCHAR(20) | DEFAULT 'recording' | `completed` / `interrupted` |

### recording_files — 磁盘文件跟踪

记录录制文件在磁盘上的完整生命周期，支持启动时扫描比对磁盘实际状态。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | SERIAL | PRIMARY KEY | 自增主键 |
| session_id | INTEGER | FK → recording_sessions(id) ON DELETE SET NULL | 所属会话（孤文件为 NULL） |
| room_url | VARCHAR(512) | FK → rooms(room_url) ON DELETE SET NULL | 关联直播间 |
| file_path | VARCHAR(1024) | NOT NULL | 文件绝对路径 |
| file_name | VARCHAR(512) | | 文件名 |
| file_size | BIGINT | DEFAULT 0 | 文件大小（字节） |
| status | VARCHAR(20) | DEFAULT 'pending' | 状态流转见下 |
| started_at | TIMESTAMP | DEFAULT NOW() | 写入时间 |
| completed_at | TIMESTAMP | | 完成时间 |
| checked_at | TIMESTAMP | DEFAULT NOW() | 上次磁盘校验时间 |
| created_at | TIMESTAMP | DEFAULT NOW() | 创建时间 |

**状态流转：**

```
pending ──→ recording ──→ completed
                 │              │
                 ├──→ interrupted  （ffmpeg 崩溃/手动停止）
                 │
                 └──→ missing      （启动扫描发现文件不存在）
                         
orphaned  ←────────────────────── （启动扫描发现磁盘上有未跟踪文件）
```

- 非分段录制：ffmpeg 启动后 INSERT `recording`，关闭后 UPDATE `completed`
- 分段录制：ffmpeg 关闭后为每段 INSERT `completed`
- 启动时 `scanRecordingFiles()` 遍历 `VIDEO_DOWNLOAD_DIR`，标记缺失/发现孤文件
- 清理/看门狗同步将记录标记为 `interrupted`

### upload_templates — 投稿模板

投稿参数模板，支持变量替换。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | SERIAL | PRIMARY KEY | |
| name | VARCHAR(255) | NOT NULL | 模板名称 |
| room_url | VARCHAR(512) | FK → rooms(room_url) ON DELETE SET NULL | 关联直播间（可选） |
| title_template | VARCHAR(1024) | | 标题模板，默认 `{room_name} 直播录像 {date}` |
| desc_template | TEXT | | 简介模板 |
| tid | INTEGER | DEFAULT 171 | B站分区 ID |
| tags | VARCHAR(1024) | | 标签，逗号分隔 |
| copyright | INTEGER | DEFAULT 2 | 1-自制 2-转载 |
| source | VARCHAR(1024) | DEFAULT `{room_url}` | 转载来源（支持模板变量） |
| cover | VARCHAR(1024) | | 封面路径 |
| is_only_self | INTEGER | DEFAULT 0 | 仅自己可见，0-关闭 1-开启 |
| cookies_path | VARCHAR(1024) | | biliup 账户文件绝对路径（必填） |
| dtime | INTEGER | DEFAULT 0 | 延迟发布时间，10 位 Unix 时间戳 |
| after_upload | VARCHAR(20) | DEFAULT 'none' | 投稿后处理方式：`none` 无操作、`backup` 备份到NAS、`delete` 删除本地文件 |
| created_at / updated_at | TIMESTAMP | | |

**模板变量：** `{room_name}` `{room_url}` `{date}` `{datetime}` `{YYYY}` `{MM}` `{DD}` `{HH}` `{mm}` `{ss}`

### upload_records — 投稿记录

每次投稿操作的执行记录。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | SERIAL | PRIMARY KEY | |
| session_id | INTEGER | FK → recording_sessions(id) | 关联录制会话 |
| template_id | INTEGER | FK → upload_templates(id) | 使用的模板 |
| room_url | VARCHAR(512) | | 直播间地址 |
| title | VARCHAR(512) | | 实际投稿标题 |
| status | VARCHAR(20) | DEFAULT 'pending' | `pending` `uploading` `success` `failed` |
| command | TEXT | | 实际执行的命令 |
| output | TEXT | | 命令输出 |
| error_message | TEXT | | 错误信息 |
| file_count | INTEGER | | 文件数 |
| total_size | BIGINT | | 总大小 |
| bv_id | VARCHAR(50) | DEFAULT '' | B站 BV 号，投稿成功后从输出中提取 |
| started_at / completed_at / created_at | TIMESTAMP | | |

---

### settings — 全局设置

KV 结构的全局配置表。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | SERIAL | PRIMARY KEY | |
| key | VARCHAR(255) | UNIQUE NOT NULL | 设置键名 |
| value | TEXT | DEFAULT '' | 设置值 |
| created_at | TIMESTAMP | DEFAULT NOW() | |
| updated_at | TIMESTAMP | DEFAULT NOW() | |

**默认设置项：**

| 键 | 默认值 | 说明 |
|----|--------|------|
| `pool_size` | `3` | 下载线程池大小，限制最大同时录制数 |
| `watchdog_interval` | `30` | 看门狗检查间隔（秒） |
| `watchdog_timeout` | `60` | 录制状态检查超时（秒），超过则标记为完成 |
| `filtering_threshold` | `10` | 碎片过滤阈值（MB），小于此大小的文件将被过滤 |
| `delay` | `60` | 下播延迟检测（秒） |
| `submit_api` | `` | biliup --submit 选项，留空为自动 |
| `lines` | `` | 上传线路，留空为自动 |
| `threads` | `3` | 单文件并发上传数 |
| `pool2_size` | `3` | 上传线程池大小 |
| `max_upload_limit` | `99` | 上传重试次数上限（内存计数，重启后重置），建议设为 `2`-`3` |

---

## 迁移

应用启动时 `db/migrate.js` 自动执行建表（`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS` + 默认设置 INSERT），无需手动操作。
