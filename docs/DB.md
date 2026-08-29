# 数据库文档

## PostgreSQL

### 连接信息

从 `.env` 读取以下环境变量：

| 变量          | 说明       |
| ------------- | ---------- |
| `DB_HOST`     | 数据库主机 |
| `DB_PORT`     | 数据库端口 |
| `DB_NAME`     | 数据库名   |
| `DB_USER`     | 数据库用户 |
| `DB_PASSWORD` | 数据库密码 |

连接池在 `db/index.js` 中创建，使用 `pg` 模块。

---

## Redis

### 连接信息

从 `.env` 读取以下环境变量：

| 变量             | 说明                       |
| ---------------- | -------------------------- |
| `REDIS_HOST`     | Redis 主机                 |
| `REDIS_PORT`     | Redis 端口，默认 6379      |
| `REDIS_PASSWORD` | Redis 密码                 |
| `REDIS_USER`     | Redis 用户，默认 `default` |
| `REDIS_DB`       | Redis 数据库编号，默认 1   |

客户端在 `db/redis.js` 中创建，使用 `redis` 模块。

### 缓存策略

| 用途       | Key 模式                     | TTL     | 说明                              |
| ---------- | ---------------------------- | ------- | --------------------------------- |
| 直播间缓存 | `room:{room_url}`            | 5 分钟  | 减少 `getOrCreateRoom` 的 DB 查询 |
| 录制任务锁 | `active_task:{roomKey}`      | 24 小时 | 防止重复录制，替代内存 Map        |
| 转码队列   | `transcode_queue`            | 无      | Redis LIST，转码任务 FIFO 队列    |
| 转码并发   | `transcode_processing_count` | 无      | 当前处理中转码任务计数            |

- 直播间写操作（创建/更新/删除/暂停/恢复/停止）后自动清除对应缓存
- 应用启动时自动清理残留的录制任务锁

---

## 表结构

### admin_users — 管理员账户

后台登录的管理员账户。

| 字段          | 类型                     | 约束            | 说明     |
| ------------- | ------------------------ | --------------- | -------- |
| id            | SERIAL                   | PRIMARY KEY     | 自增主键 |
| username      | VARCHAR(50)              | UNIQUE NOT NULL | 用户名   |
| password_hash | VARCHAR(255)             | NOT NULL        | 密码哈希 |
| created_at    | TIMESTAMP WITH TIME ZONE | DEFAULT NOW()   | 创建时间 |
| updated_at    | TIMESTAMP WITH TIME ZONE | DEFAULT NOW()   | 更新时间 |

**触发器：** `trg_admin_users_updated_at` — UPDATE 时自动设置 `updated_at = CURRENT_TIMESTAMP`

### rooms — 直播间

记录直播间状态和配置。

| 字段                 | 类型          | 约束                              | 说明                                                                                            |
| -------------------- | ------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| id                   | SERIAL        | PRIMARY KEY                       | 自增主键                                                                                        |
| room_url             | VARCHAR(512)  | UNIQUE NOT NULL                   | 直播间地址（唯一标识）                                                                          |
| room_name            | VARCHAR(255)  | DEFAULT ''                        | 直播间名称                                                                                      |
| status               | VARCHAR(20)   | DEFAULT 'idle'                    | 状态：`idle` / `recording` / `paused`                                                           |
| filename_template    | VARCHAR(255)  | DEFAULT '{room_name}\_{datetime}' | 文件名模板                                                                                      |
| output_path          | VARCHAR(1024) | DEFAULT ''                        | 最新录制文件路径                                                                                |
| ffmpeg_pid           | INTEGER       |                                   | ffmpeg 进程 ID（用于暂停/恢复）                                                                 |
| segment_duration     | INTEGER       | DEFAULT 0                         | 分段录制时长（秒），0 表示不分段                                                                |
| notification_enabled | BOOLEAN       | DEFAULT TRUE                      | 通知开关，关闭后不发送录制/投稿通知                                                             |
| monitoring_enabled   | BOOLEAN       | DEFAULT TRUE                      | 监听开关，关闭后 API 触发时不启动 ffmpeg                                                        |
| upload_template_id   | INTEGER       | FK → upload_templates(id)         | 关联的投稿模板                                                                                  |
| polling_enabled      | BOOLEAN       | DEFAULT FALSE                     | 轮询开关，启用后定期检测开播状态                                                                |
| polling_platform     | VARCHAR(50)   |                                   | 轮询平台：`huya`、`bilibili`、`douyin`、`kuaishou`（已实现），`douyu`（不可用-平台流2分钟超时） |
| polling_interval     | INTEGER       | DEFAULT 60                        | 轮询间隔（秒）                                                                                  |
| created_at           | TIMESTAMP     | DEFAULT NOW()                     | 创建时间                                                                                        |
| updated_at           | TIMESTAMP     | DEFAULT NOW()                     | 更新时间                                                                                        |

### recording_sessions — 录制会话

每次连续直播录制创建一个会话，包含一个或多个分片文件。

| 字段           | 类型          | 约束                                   | 说明                                                  |
| -------------- | ------------- | -------------------------------------- | ----------------------------------------------------- |
| id             | SERIAL        | PRIMARY KEY                            | 自增主键                                              |
| room_url       | VARCHAR(512)  | FK → rooms(room_url) ON DELETE CASCADE | 关联直播间                                            |
| started_at     | TIMESTAMP     | DEFAULT NOW()                          | 会话开始时间                                          |
| ended_at       | TIMESTAMP     |                                        | 会话结束时间                                          |
| status         | VARCHAR(20)   | DEFAULT 'recording'                    | `pending` / `recording` / `completed` / `interrupted` |
| total_segments | INTEGER       | DEFAULT 0                              | 分片文件数                                            |
| total_size     | BIGINT        | DEFAULT 0                              | 总大小（字节）                                        |
| output_dir     | VARCHAR(1024) | DEFAULT ''                             | 输出目录                                              |
| caption        | VARCHAR(1024) | DEFAULT ''                             | 直播描述/备注                                         |
| output_path    | VARCHAR(1024) | DEFAULT ''                             | 录制输出路径（覆盖 rooms 级别）                       |
| cover_url      | VARCHAR(1024) | DEFAULT ''                             | 直播封面 URL                                          |
| cover_path     | VARCHAR(1024) | DEFAULT ''                             | 封面本地缓存路径                                      |
| retry_count    | INTEGER       | DEFAULT 0                              | 崩溃恢复重试次数                                      |
| stream_url     | VARCHAR(1024) | DEFAULT ''                             | 实际直播流地址（用于重启后恢复 ffmpeg）               |
| deleted_at     | TIMESTAMP     |                                        | 软删除时间                                            |
| created_at     | TIMESTAMP     | DEFAULT NOW()                          |                                                       |

### recordings — 录制文件（已废弃）

> **注意**：此表已废弃，数据已迁移到 `recording_files` 表。当前迁移会清理该旧表，新代码不再读写它。

### recording_files — 录制文件（主表）

**会话详情、投稿操作、流媒体播放、文件统计均以此表作为数据源。** 记录磁盘上每个录制文件的完整生命周期，支持启动时扫描比对磁盘实际状态。

| 字段              | 类型          | 约束                                           | 说明                               |
| ----------------- | ------------- | ---------------------------------------------- | ---------------------------------- |
| id                | SERIAL        | PRIMARY KEY                                    | 自增主键                           |
| session_id        | INTEGER       | FK → recording_sessions(id) ON DELETE SET NULL | 所属会话（孤文件为 NULL）          |
| room_url          | VARCHAR(512)  | FK → rooms(room_url) ON DELETE SET NULL        | 关联直播间                         |
| file_path         | VARCHAR(1024) | NOT NULL UNIQUE                                | 文件绝对路径                       |
| file_name         | VARCHAR(512)  |                                                | 文件名                             |
| file_size         | BIGINT        | DEFAULT 0                                      | 文件大小（字节）                   |
| status            | VARCHAR(20)   | DEFAULT 'pending'                              | 状态流转见下                       |
| started_at        | TIMESTAMP     | DEFAULT NOW()                                  | 写入时间                           |
| ended_at          | TIMESTAMP     |                                                | 结束时间                           |
| completed_at      | TIMESTAMP     |                                                | 完成时间                           |
| checked_at        | TIMESTAMP     | DEFAULT NOW()                                  | 上次磁盘校验时间                   |
| segment_index     | INTEGER       | DEFAULT 0                                      | 分片序号                           |
| duration_seconds  | INTEGER       | DEFAULT 0                                      | 时长（秒）                         |
| is_hls_ready      | BOOLEAN       | DEFAULT FALSE                                  | HLS 是否已生成                     |
| hls_playlist_path | VARCHAR(1024) | DEFAULT ''                                     | HLS 播放列表路径                   |
| hls_generated_at  | TIMESTAMP     |                                                | HLS 生成时间                       |
| hls_status        | VARCHAR(20)   | NOT NULL DEFAULT 'pending'                     | HLS 生命周期状态，见下             |
| hls_deleted_at    | TIMESTAMP     |                                                | HLS 因保留期或用户操作被删除的时间 |
| segment_start_ms  | INTEGER       | DEFAULT 0                                      | 分段起始时间（毫秒）               |
| segment_end_ms    | INTEGER       | DEFAULT 0                                      | 分段结束时间（毫秒）               |
| created_at        | TIMESTAMP     | DEFAULT NOW()                                  | 创建时间                           |

**状态流转：**

```
非分段：  recording ──→ completed         （ffmpeg 启动→关闭）
                          │
                          ├──→ interrupted  （ffmpeg 崩溃/手动停止）

分段：    completed                       （分片完成时直接 INSERT）

扫描：    orphaned                        （磁盘有文件但无记录）
          missing                         （DB 有记录但磁盘无文件）
```

**HLS 状态流转：**

```text
pending -> generating -> ready -> deleting -> expired
                         |                   -> deleted
                         -> missing
generating -> failed
expired / deleted / missing / failed -> generating  （仅手动重新生成）
```

`is_hls_ready` 是兼容字段，仅当 `hls_status = 'ready'` 时为 `TRUE`。看门狗只自动生成
`pending` HLS；`expired`、`deleted`、`missing` 和 `failed` 不会因播放列表不存在而自动重建。
清理候选使用索引 `idx_recording_files_hls_cleanup (hls_status, hls_generated_at)`。

**写入时机：**

| 场景                         | 写入方式                     |
| ---------------------------- | ---------------------------- |
| 非分段录制完成               | INSERT/UPDATE 为 `completed` |
| 分段录制分片完成（看门狗）   | INSERT 为 `completed`        |
| 分段录制分片完成（进程退出） | INSERT 为 `completed`        |
| 启动清理追踪遗留文件         | INSERT 为 `completed`        |
| 磁盘扫描发现未跟踪文件       | INSERT 为 `orphaned`         |
| 手动关联孤文件到会话         | UPDATE 为 `completed`        |
| 看门狗超时判定录制中断       | UPDATE 为 `interrupted`      |
| 启动扫描发现文件已丢失       | UPDATE 为 `missing`          |

### upload_templates — 投稿模板

投稿参数模板，支持变量替换。

| 字段                    | 类型          | 约束           | 说明                                                                                                                                                     |
| ----------------------- | ------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                      | SERIAL        | PRIMARY KEY    |                                                                                                                                                          |
| name                    | VARCHAR(255)  | NOT NULL       | 模板名称                                                                                                                                                 |
| title_template          | VARCHAR(1024) |                | 标题模板，默认 `{room_name} 直播录像 {date}`                                                                                                             |
| desc_template           | TEXT          |                | 简介模板                                                                                                                                                 |
| tid                     | INTEGER       | DEFAULT 171    | B站分区 ID                                                                                                                                               |
| tags                    | VARCHAR(1024) |                | 标签，逗号分隔                                                                                                                                           |
| copyright               | INTEGER       | DEFAULT 2      | 1-自制 2-转载                                                                                                                                            |
| source                  | VARCHAR(1024) | DEFAULT ''     | 转载来源（支持模板变量）                                                                                                                                 |
| cover                   | VARCHAR(1024) |                | 封面路径                                                                                                                                                 |
| is_only_self            | INTEGER       | DEFAULT 0      | 仅自己可见，0-关闭 1-开启                                                                                                                                |
| cookies_path            | VARCHAR(1024) |                | biliup 账户文件绝对路径（必填）                                                                                                                          |
| dtime                   | INTEGER       | DEFAULT 0      | 延迟发布时间，10 位 Unix 时间戳                                                                                                                          |
| after_upload            | VARCHAR(20)   | DEFAULT 'none' | 投稿后处理方式：`none` 无操作、`backup` 备份到NAS、`delete` 删除本地文件、`backup_and_delete` 备份到NAS后删除本地文件；未配置 `NAS_*` 时备份类动作会跳过 |
| created_at / updated_at | TIMESTAMP     |                |                                                                                                                                                          |

> **v1.7.0 变更**：`room_url` 列已删除。模板不再与特定直播间绑定，改为由 `rooms.upload_template_id` 反向引用。

**直播投稿模板变量：** `{room_name}` `{room_url}` `{caption}` `{date}` `{datetime}` `{YYYY}` `{MM}` `{DD}` `{HH}` `{mm}` `{ss}` `{H}` `{M}` `{D}` `{duration_mins}`

其中 `{duration_mins}` 为根据录制时长计算的分钟数。`{duration}`、`{duration_hour}` 是回放投稿专用变量，分别表示格式化后的时长和小时数；直播投稿不会提供这两个变量。回放投稿中的 `{caption}` 当前固定为空值。

### upload_records — 投稿记录

每次投稿操作的执行记录。

| 字段                                   | 类型         | 约束                        | 说明                                     |
| -------------------------------------- | ------------ | --------------------------- | ---------------------------------------- |
| id                                     | SERIAL       | PRIMARY KEY                 |                                          |
| session_id                             | INTEGER      | FK → recording_sessions(id) | 关联录制会话                             |
| template_id                            | INTEGER      | FK → upload_templates(id)   | 使用的模板                               |
| room_url                               | VARCHAR(512) |                             | 直播间地址                               |
| title                                  | VARCHAR(512) |                             | 实际投稿标题                             |
| status                                 | VARCHAR(20)  | DEFAULT 'pending'           | `pending` `uploading` `success` `failed` |
| command                                | TEXT         |                             | 实际执行的命令                           |
| output                                 | TEXT         |                             | 命令输出                                 |
| error_message                          | TEXT         |                             | 错误信息                                 |
| file_count                             | INTEGER      |                             | 文件数                                   |
| total_size                             | BIGINT       |                             | 总大小                                   |
| bv_id                                  | VARCHAR(50)  | DEFAULT ''                  | B站 BV 号，投稿成功后从输出中提取        |
| upload_files                           | TEXT         | DEFAULT '[]'                | 投稿文件路径列表（JSON 数组）            |
| started_at / completed_at / created_at | TIMESTAMP    |                             |                                          |

### transcode_records — 转码记录

每次转码任务的执行记录，记录 FLV 到 MP4 的转换。

| 字段            | 类型          | 约束             | 说明                                       |
| --------------- | ------------- | ---------------- | ------------------------------------------ |
| id              | SERIAL        | PRIMARY KEY      |                                            |
| session_id      | INTEGER       |                  | 关联的录制会话 ID                          |
| original_path   | VARCHAR(1024) | NOT NULL UNIQUE  | 原文件路径（FLV）                          |
| transcoded_path | VARCHAR(1024) |                  | 转码后文件路径（MP4）                      |
| status          | VARCHAR(20)   | DEFAULT 'queued' | `queued` `processing` `completed` `failed` |
| enqueued_at     | TIMESTAMP     | DEFAULT NOW()    | 入队时间                                   |
| started_at      | TIMESTAMP     |                  | 开始转码时间                               |
| completed_at    | TIMESTAMP     |                  | 完成转码时间                               |
| created_at      | TIMESTAMP     | DEFAULT NOW()    |                                            |

---

### settings — 全局设置

KV 结构的全局配置表。

| 字段       | 类型         | 约束            | 说明     |
| ---------- | ------------ | --------------- | -------- |
| id         | SERIAL       | PRIMARY KEY     |          |
| key        | VARCHAR(255) | UNIQUE NOT NULL | 设置键名 |
| value      | TEXT         | DEFAULT ''      | 设置值   |
| created_at | TIMESTAMP    | DEFAULT NOW()   |          |
| updated_at | TIMESTAMP    | DEFAULT NOW()   |          |

**默认设置项：**

| 键                                | 默认值             | 说明                                                                           |
| --------------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| `pool_size`                       | `3`                | 下载线程池大小，限制最大同时录制数                                             |
| `watchdog_interval`               | `30`               | 看门狗检查间隔（秒）                                                           |
| `watchdog_timeout`                | `60`               | 录制状态检查超时（秒），超过则标记为完成                                       |
| `filtering_threshold`             | `10`               | 碎片过滤阈值（MB），小于此大小的文件将被过滤                                   |
| `delay`                           | `60`               | 下播延迟检测（秒）                                                             |
| `max_upload_limit`                | `99`               | 上传重试次数上限（内存计数，重启后重置），建议设为 `2`-`3`                     |
| `auto_transcode`                  | `true`             | 是否自动转码 FLV 到 MP4                                                        |
| `transcode_delete_originals`      | `true`             | 转码后是否删除原 FLV 文件                                                      |
| `transcode_concurrency`           | `3`                | 转码队列并发数，控制同时处理的转码任务数                                       |
| `auto_generate_hls`               | `true`             | 是否自动生成 HLS 播放文件                                                      |
| `hls_enabled`                     | `true`             | 是否启用 HLS 播放功能                                                          |
| `hls_segment_duration`            | `10`               | HLS 分片时长（秒）                                                             |
| `hls_cleanup_days`                | `30`               | HLS 文件自动清理天数                                                           |
| `log_retention_days`              | `30`               | 日志文件保留天数，启动时和每日日志清理任务会删除超过该天数的日志文件           |
| `kuaishou_danmaku_enabled`        | `false`            | 是否启用快手弹幕采集                                                           |
| `danmaku_density_per_second`      | `15`               | 弹幕渲染每秒最大密度（**遗留键**，仅供外部 danmaku-tool 消费，本服务不再使用） |
| `danmaku_font_family`             | `Noto Sans CJK SC` | 弹幕渲染字体（**遗留键**，同上）                                               |
| `danmaku_font_size`               | `38`               | 弹幕渲染字体大小（**遗留键**，同上）                                           |
| `danmaku_opacity`                 | `0.88`             | 弹幕不透明度（**遗留键**，同上）                                               |
| `danmaku_outline_colour`          | `000000`           | 弹幕描边颜色（**遗留键**，同上）                                               |
| `danmaku_outline_width`           | `2`                | 弹幕描边宽度（**遗留键**，同上）                                               |
| `replay_enabled`                  | `true`             | 是否启用回放工具箱                                                             |
| `replay_work_dir`                 | `/data/replay`     | 回放处理工作目录默认值；实际文件路径优先使用环境变量 `REPLAY_WORK_DIR`         |
| `replay_queue_concurrency`        | `1`                | 回放队列并发数（当前强制最大 1）                                               |
| `replay_cron_enabled`             | `false`            | 是否启用回放定时任务                                                           |
| `replay_cron_expr`                | `0 3 * * *`        | 回放定时任务表达式                                                             |
| `replay_auto_upload`              | `false`            | 回放处理完成后是否自动投稿                                                     |
| `replay_max_count_per_run`        | `1`                | 单次主播回放批处理默认数量                                                     |
| `file_cleanup_enabled`            | `false`            | 是否启用文件自动清理                                                           |
| `file_cleanup_empty_dirs_enabled` | `false`            | 是否启用录制和回放目录空目录自动清理                                           |
| `file_cleanup_retention_days`     | `30`               | 文件清理保留天数                                                               |
| `file_cleanup_categories`         | ``                 | 清理的文件类别，逗号分隔                                                       |
| `file_cleanup_watermark_warn`     | `80`               | 磁盘空间告警阈值（%）                                                          |
| `file_cleanup_watermark_critical` | `90`               | 磁盘空间严重告警阈值（%）                                                      |
| `file_cleanup_suggestion_notify`  | `false`            | 是否发送文件清理建议通知                                                       |
| `webhook_enabled`                 | `false`            | 是否启用 Webhook 通知                                                          |
| `webhook_url`                     | ``                 | Webhook 推送 URL                                                               |
| `feishu_webhook_enabled`          | `false`            | 是否启用飞书通知（v1.7.0 细化，原 `MESSAGE_FEISHU_WEBHOOK` 环境变量仍兼容）    |
| `feishu_webhook_url`              | ``                 | 飞书 Webhook URL                                                               |
| `gotify_enabled`                  | `false`            | 是否启用 Gotify 通知                                                           |
| `gotify_server`                   | ``                 | Gotify 服务地址                                                                |
| `gotify_token`                    | ``                 | Gotify app token                                                               |
| `gotify_priority`                 | `5`                | Gotify 优先级                                                                  |

**v1.8.0 已删除的设置键**（启动迁移 `DELETE FROM settings` 自动清理，无需人工干预）：

- `auto_burn_danmaku`
- `prefer_danmaku_burned_video`
- `danmaku_preserve_clean_video`

---

## v1.8.0 已 DROP 的表与列

以下结构在 v1.8.0 随弹幕压制迁出 danmaku-tool 一并移除。DDL 写在 `server/db/migrate.js`，**服务启动时自动执行**（全部带 `IF EXISTS`，幂等）：

| 对象                               | 类型 | migrate.js 位置                    |
| ---------------------------------- | ---- | ---------------------------------- |
| `danmaku_burn_records`             | 表   | `DROP TABLE IF EXISTS`（约 L387）  |
| `danmaku_free_burn_records`        | 表   | `DROP TABLE IF EXISTS`（约 L459）  |
| `recording_files.danmaku_ass_path` | 列   | `DROP COLUMN IF EXISTS`（约 L328） |
| `danmaku_capture_records.ass_path` | 列   | `DROP COLUMN IF EXISTS`（约 L384） |

- 这是**不可逆的数据删除**，升级前请 `bash scripts/backup-db.sh` 或 `pg_dump` 备份。
- 列结构需从 `pg_dump` 备份还原（v1.8.3 起独立回滚脚本已移除，DROP 已稳定运行多版本）。
- 弹幕 JSONL 的存量路径迁移是**独立的手动步骤**，见 `scripts/migrate-danmaku-paths.js`（详见 `docs/DEV.md`）。

---

### danmaku_capture_records — 弹幕采集记录

**记录每个会话的弹幕采集生命周期。** 一个 `session_id` 可能对应多条采集记录（如中断后重连）。

v1.9.0 起该表同时承载**孤儿弹幕**记录（ADR-012）：无活跃采集会话时收到的弹幕批次以
`session_id = NULL` + `status = 'orphan_pending'` 落库，`raw_path` 指向孤儿 JSONL，
由 `OrphanDanmakuReconciler` 按时间戳回填到重叠的历史会话。

| 字段        | 类型          | 约束                | 说明                                                                                                                                              |
| ----------- | ------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| id          | SERIAL        | PRIMARY KEY         | 自增主键                                                                                                                                          |
| session_id  | INTEGER       |                     | 所属录制会话；孤儿记录为 NULL，回填后写入唯一命中的会话                                                                                           |
| room_id     | INTEGER       |                     | 关联房间；孤儿记录为 NULL                                                                                                                         |
| room_url    | VARCHAR(512)  | DEFAULT ''          | 直播间 URL（v1.9.0 新增）。孤儿记录 `session_id` 为空，无法 JOIN 取 room_url，回填匹配必须靠本列                                                   |
| platform    | VARCHAR(50)   | DEFAULT 'kuaishou'  | 平台标识                                                                                                                                          |
| status      | VARCHAR(20)   | DEFAULT 'recording' | `recording` → `completed` / `failed`；孤儿链路：`orphan_pending` → `orphan_processing` → `orphan_associated` / `orphan_discarded`                    |
| raw_path    | VARCHAR(1024) | DEFAULT ''          | 弹幕 JSONL 绝对路径，形如 `VIDEO_DOWNLOAD_DIR/danmaku/[sessionId].jsonl`（v1.8.0 起为扁平集中路径，由 `getDanmakuJsonlPath(sessionId)` 唯一推导） |
| event_count | INTEGER       | DEFAULT 0           | 采集到的弹幕事件总数；孤儿记录表示**尚未匹配**的剩余事件数                                                                                         |
| started_at  | TIMESTAMP     | DEFAULT NOW()       | 采集开始时间；孤儿记录为该批 `ts_abs_ms` 的最小值                                                                                                 |
| ended_at    | TIMESTAMP     |                     | 采集结束时间；孤儿记录为该批 `ts_abs_ms` 的最大值                                                                                                 |
| error       | TEXT          | DEFAULT ''          | 失败时的错误信息                                                                                                                                  |
| created_at  | TIMESTAMP     | DEFAULT NOW()       | 记录创建时间                                                                                                                                      |

**写入时机：**

| 场景                                | 操作                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------- |
| 录制会话启动弹幕采集                | INSERT，status = `recording`                                            |
| 录制正常结束                        | UPDATE status = `completed`，写入 event_count                           |
| 采集异常                            | UPDATE status = `failed`，写入 error                                    |
| 收到弹幕但无活跃采集会话（v1.9.0）  | 同日同房间已有 `orphan_pending` 记录则 UPDATE 累加 event_count 并扩展 started_at/ended_at 区间，否则 INSERT，session_id = NULL，写入 room_url |
| 回填抢占（v1.9.0）                  | UPDATE status `orphan_pending` → `orphan_processing`（原子占位，防并发重复回填；早退/失败时回退为 `orphan_pending`） |
| 回填命中会话（v1.9.0）              | UPDATE status = `orphan_associated`，event_count 改为剩余未匹配数        |
| 回填部分命中（v1.9.0）              | UPDATE 保持 `orphan_pending`，event_count 改为剩余未匹配数，供二次回填   |
| 人工丢弃孤儿记录（v1.9.0）          | UPDATE status = `orphan_discarded`，raw_path 指向 `_discarded/` 归档文件 |

**孤儿弹幕文件布局**（`ORPHAN_DIR_NAME` / `DISCARDED_DIR_NAME` 下划线前缀显式区别于 `{sessionId}.jsonl`，扫描逻辑天然跳过）：

```text
VIDEO_DOWNLOAD_DIR/danmaku/
├── 118.jsonl                          # 正常会话弹幕
├── _orphan/2026-08-13/{sha1(roomUrl).slice(0,12)}.jsonl   # 按天 + 房间分片
└── _discarded/{recordId}_{原文件名}.jsonl                  # 人工丢弃归档（不硬删）
```

**回填相关 settings：**

| key                           | 默认值               | 说明                                    |
| ----------------------------- | -------------------- | --------------------------------------- |
| `orphan_tolerance_ms`         | `120000`（2 分钟）   | 时间戳落在会话区间外的前后容差          |
| `orphan_confidence_threshold` | `0.8`                | 自动回填的最低置信度（命中数 / 总数）   |
| `orphan_max_session_ms`       | `28800000`（8 小时） | `ended_at IS NULL` 时的兜底区间上限     |
| `orphan_dedup_scan_lines`     | `200`                | 去重时扫描目标 JSONL 尾部的行数         |

> ⚠️ `recording_sessions.started_at` / `ended_at` 是 `TIMESTAMP`（**无时区**）。
> 回填匹配必须走 `DataService.getSessionsOverlappingWindow()`，它在 SQL 里用
> `EXTRACT(EPOCH FROM (col AT TIME ZONE current_setting('TimeZone'))) * 1000` 取
> epoch，避免 Node 进程时区与数据库时区不一致时整体偏移、把弹幕吸附到相邻会话。
> 禁止在业务代码里 `new Date(row.started_at).getTime()`。

---

### replay_records — 回放记录

记录快手主播回放的抓取、下载、剪切、修复、投稿和备份状态。`principal_id + replay_id` 在 `replay_id` 非空时保持唯一。

| 字段             | 类型          | 约束          | 说明                                                                                                                               |
| ---------------- | ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| id               | SERIAL        | PRIMARY KEY   | 自增主键                                                                                                                           |
| principal_id     | VARCHAR(128)  | NOT NULL      | 快手主播 ID                                                                                                                        |
| principal_name   | VARCHAR(255)  |               | 主播名称                                                                                                                           |
| replay_id        | VARCHAR(128)  |               | 平台回放 ID                                                                                                                        |
| play_url         | TEXT          |               | 回放播放页地址                                                                                                                     |
| m3u8_url         | TEXT          |               | 已提取的 m3u8 地址                                                                                                                 |
| poster           | TEXT          |               | 直播封面 URL                                                                                                                       |
| resolution       | VARCHAR(50)   |               | 视频分辨率（如 `1920x1080`）                                                                                                       |
| video_file_name  | VARCHAR(512)  |               | 原始视频文件名                                                                                                                     |
| raw_file_path    | VARCHAR(1024) |               | 下载后的原始文件路径                                                                                                               |
| cut_file_paths   | TEXT          | JSON 字符串   | 剪切后的文件路径数组                                                                                                               |
| fixed_file_paths | TEXT          | JSON 字符串   | 修复后的文件路径数组                                                                                                               |
| final_file_paths | TEXT          | JSON 字符串   | 最终可投稿文件路径数组                                                                                                             |
| file_size        | BIGINT        | DEFAULT 0     | 原始文件大小                                                                                                                       |
| bv_id            | VARCHAR(50)   |               | 投稿成功后的 BV 号                                                                                                                 |
| status           | VARCHAR(50)   |               | `pending` / `extracted` / `downloaded` / `cut` / `fixed` / `uploaded` / `completed` / `backed_up`（历史） / `cancelled` / `failed` |
| start_time       | TIMESTAMP     |               | 回放开始时间                                                                                                                       |
| duration         | INTEGER       | DEFAULT 0     | 回放时长（秒）                                                                                                                     |
| uploaded_at      | TIMESTAMP     |               | 投稿完成时间                                                                                                                       |
| backed_up_at     | TIMESTAMP     |               | 备份完成时间                                                                                                                       |
| completed_at     | TIMESTAMP     |               | 手动或投稿完成时间                                                                                                                 |
| error_message    | TEXT          |               | 失败原因                                                                                                                           |
| created_at       | TIMESTAMP     | DEFAULT NOW() | 创建时间                                                                                                                           |
| updated_at       | TIMESTAMP     | DEFAULT NOW() | 更新时间                                                                                                                           |

**状态流转：**

```
pending -> extracted -> downloaded -> cut -> fixed -> uploaded -> completed
                                       └──────────────────────────────> failed
```

`backed_up` 为历史状态保留，新流程终态为 `completed`。

`extract` 步骤通过 `KuaishouReplayClient.extractM3u8()` 提取 m3u8 流地址，采用两级降级策略：

1. **HTTP API 优先**：调用快手 `playback/detail` API 获取 playUrlV3，自动选择最佳清晰度（按分辨率 → H264 优先 → 码率排序）
2. **Playwright 浏览器兜底**：API 失败时自动降级到浏览器方案（`m3u8-extractor.js`），打开回放页面拦截 playback/detail API 响应或网络 m3u8 流

若记录已有 `m3u8_url` 则直接跳过提取。浏览器方案会顺带回填 `duration` 字段。

远端 `records` 增量同步只在 `ReplayService.updateRecordStatus()` 更新 `duration` 时发布
`replay_record_projection_changed` 事件。`sync-records.sh` 收到记录 ID 后重新查询本地
`replay_records`，将 `duration` 写入远端，并用 `start_time - duration` 派生
`start_live_time` / `start_live_time_text`。`resolution`、状态流转和投稿完成不再单独发布
远端 records 同步事件。

### replay_settings — 主播级回放配置

覆盖全局回放默认配置。

| 字段         | 类型         | 约束                           | 说明     |
| ------------ | ------------ | ------------------------------ | -------- |
| key          | VARCHAR(255) | PRIMARY KEY(key, principal_id) | 配置键   |
| principal_id | VARCHAR(128) | PRIMARY KEY(key, principal_id) | 主播 ID  |
| value        | TEXT         | DEFAULT ''                     | 配置值   |
| updated_at   | TIMESTAMP    | DEFAULT NOW()                  | 更新时间 |

允许的主播级配置：`upload_template_id`、`auto_upload`、`auto_backup`、`max_count_per_run`。

### replay_upload_records — 回放投稿记录

记录回放工具箱调用 biliup 投稿的执行结果，与普通录制投稿记录隔离。

约束：`idx_replay_upload_one_uploading` 限制同一 `replay_record_id` 同时只能有一条 `status='uploading'` 投稿记录。历史上同一回放可能已有多条 `success`，因此成功记录的重复拦截由 `ReplayUploadService` 在创建新投稿前检查。

| 字段             | 类型         | 约束                                         | 说明                                           |
| ---------------- | ------------ | -------------------------------------------- | ---------------------------------------------- |
| id               | SERIAL       | PRIMARY KEY                                  | 自增主键                                       |
| replay_record_id | INTEGER      | FK → replay_records(id) ON DELETE SET NULL   | 对应回放记录                                   |
| template_id      | INTEGER      | FK → upload_templates(id) ON DELETE SET NULL | 使用的投稿模板                                 |
| template_name    | VARCHAR(255) |                                              | 模板名称                                       |
| title            | VARCHAR(512) |                                              | 实际投稿标题                                   |
| status           | VARCHAR(20)  | DEFAULT 'pending'                            | `pending` / `uploading` / `success` / `failed` |
| command          | TEXT         |                                              | biliup 命令                                    |
| output           | TEXT         |                                              | 命令输出                                       |
| error_message    | TEXT         |                                              | 失败原因                                       |
| file_count       | INTEGER      | DEFAULT 0                                    | 投稿文件数量                                   |
| total_size       | BIGINT       | DEFAULT 0                                    | 投稿文件总大小                                 |
| bv_id            | VARCHAR(50)  |                                              | BV 号                                          |
| upload_files     | TEXT         | JSON 字符串                                  | 投稿文件路径数组                               |
| started_at       | TIMESTAMP    | DEFAULT NOW()                                | 开始时间                                       |
| completed_at     | TIMESTAMP    |                                              | 完成时间                                       |
| created_at       | TIMESTAMP    | DEFAULT NOW()                                | 创建时间                                       |

---

### managed_files — 文件管理索引

**文件管理模块的核心索引表。** 由文件扫描服务定期同步磁盘文件状态，用于安全删除决策和磁盘空间管理。

| 字段                | 类型          | 约束             | 说明                                                   |
| ------------------- | ------------- | ---------------- | ------------------------------------------------------ |
| id                  | SERIAL        | PRIMARY KEY      | 自增主键                                               |
| category            | VARCHAR(20)   | NOT NULL         | 文件分类（如 `recording`、`hls`、`danmaku`、`replay`） |
| file_type           | VARCHAR(30)   | NOT NULL         | 文件类型（如 `video`、`subtitle`、`playlist`、`data`） |
| source_table        | VARCHAR(50)   | NOT NULL         | 来源表名（如 `recording_files`、`replay_records`）     |
| source_id           | INTEGER       |                  | 来源记录 ID                                            |
| group_id            | VARCHAR(100)  |                  | 分组标识（如会话 ID）                                  |
| file_path           | VARCHAR(1024) | NOT NULL UNIQUE  | 文件绝对路径                                           |
| file_name           | VARCHAR(512)  | NOT NULL         | 文件名                                                 |
| extension           | VARCHAR(20)   |                  | 文件扩展名                                             |
| file_size           | BIGINT        |                  | 文件大小（字节）                                       |
| mtime               | TIMESTAMP     |                  | 文件最后修改时间                                       |
| exists_on_disk      | BOOLEAN       | DEFAULT TRUE     | 磁盘上是否仍然存在                                     |
| status              | VARCHAR(20)   | DEFAULT 'active' | 状态：`active` / `deleted` / `missing`                 |
| safe_to_delete      | BOOLEAN       | DEFAULT FALSE    | 是否可安全删除                                         |
| delete_block_reason | VARCHAR(100)  |                  | 不可删除原因说明                                       |
| created_at          | TIMESTAMP     | DEFAULT NOW()    | 创建时间                                               |
| updated_at          | TIMESTAMP     | DEFAULT NOW()    | 更新时间（触发器自动维护）                             |
| deleted_at          | TIMESTAMP     |                  | 删除时间                                               |

**索引：**

| 索引名                                   | 字段                               | 说明                   |
| ---------------------------------------- | ---------------------------------- | ---------------------- |
| `idx_managed_files_category_type_status` | `(category, file_type, status)`    | 分类/类型/状态联合查询 |
| `idx_managed_files_safe_size`            | `(safe_to_delete, file_size DESC)` | 可删除文件按大小排序   |
| `idx_managed_files_mtime`                | `(mtime DESC)`                     | 按修改时间排序         |
| `idx_managed_files_source`               | `(source_table, source_id)`        | 来源关联查询           |

**触发器：** `trg_managed_files_updated_at` — UPDATE 时自动设置 `updated_at = CURRENT_TIMESTAMP`

---

### file_delete_audit_logs — 文件删除审计日志

**记录所有文件删除操作的审计日志。** 包含删除前后的大小估算和实际释放空间。

| 字段                   | 类型          | 约束          | 说明                               |
| ---------------------- | ------------- | ------------- | ---------------------------------- |
| id                     | SERIAL        | PRIMARY KEY   | 自增主键                           |
| file_id                | INTEGER       |               | 关联 `managed_files.id`            |
| file_path              | VARCHAR(1024) |               | 被删除文件路径                     |
| file_size              | BIGINT        |               | 文件大小                           |
| category               | VARCHAR(20)   |               | 文件分类                           |
| source_table           | VARCHAR(50)   |               | 来源表名                           |
| source_id              | INTEGER       |               | 来源记录 ID                        |
| operator               | VARCHAR(100)  |               | 操作人                             |
| deleted_by             | VARCHAR(20)   |               | 删除方式（如 `user`、`system`）    |
| action                 | VARCHAR(20)   |               | 操作类型（如 `delete`、`cleanup`） |
| result                 | VARCHAR(20)   |               | 操作结果（如 `success`、`failed`） |
| estimated_release_size | BIGINT        |               | 预估释放空间                       |
| actual_release_size    | BIGINT        |               | 实际释放空间                       |
| delete_reason          | VARCHAR(20)   |               | HLS 删除原因：`user` / `retention` |
| recording_file_id      | INTEGER       |               | HLS 对应的 `recording_files.id`    |
| error_message          | TEXT          |               | 失败时的错误信息                   |
| created_at             | TIMESTAMP     | DEFAULT NOW() | 创建时间                           |

**索引：**

| 索引名                                  | 字段                | 说明           |
| --------------------------------------- | ------------------- | -------------- |
| `idx_file_delete_audit_logs_file_id`    | `(file_id)`         | 按文件 ID 查询 |
| `idx_file_delete_audit_logs_created_at` | `(created_at DESC)` | 按时间倒序查询 |

---

## 迁移

应用启动时 `db/migrate.js` 自动执行建表（`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS` + 默认设置 INSERT），无需手动操作。
