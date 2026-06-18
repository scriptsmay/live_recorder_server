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

| 用途       | Key 模式                        | TTL     | 说明                               |
| ---------- | ------------------------------- | ------- | ---------------------------------- |
| 直播间缓存 | `room:{room_url}`               | 5 分钟  | 减少 `getOrCreateRoom` 的 DB 查询  |
| 录制任务锁 | `active_task:{roomKey}`         | 24 小时 | 防止重复录制，替代内存 Map         |
| 转码队列   | `transcode_queue`               | 无      | Redis LIST，转码任务 FIFO 队列     |
| 转码并发   | `transcode_processing_count`    | 无      | 当前处理中转码任务计数             |
| 压制队列   | `danmaku_burn_queue`            | 无      | Redis LIST，弹幕压制任务 FIFO 队列 |
| 压制并发   | `danmaku_burn_processing_count` | 无      | 当前处理中压制任务计数             |

- 直播间写操作（创建/更新/删除/暂停/恢复/停止）后自动清除对应缓存
- 应用启动时自动清理残留的录制任务锁

---

## 表结构

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
| retry_count    | INTEGER       | DEFAULT 0                              | 崩溃恢复重试次数                                      |
| stream_url     | VARCHAR(1024) | DEFAULT ''                             | 实际直播流地址（用于重启后恢复 ffmpeg）               |
| deleted_at     | TIMESTAMP     |                                        | 软删除时间                                            |
| created_at     | TIMESTAMP     | DEFAULT NOW()                          |                                                       |

### recordings — 录制文件（已废弃）

> **注意**：此表已废弃，数据已迁移到 `recording_files` 表。新代码不再向此表写入数据，建议在确认系统稳定后删除此表。

### recording_files — 录制文件（主表）

**会话详情、投稿操作、流媒体播放、文件统计均以此表作为数据源。** 记录磁盘上每个录制文件的完整生命周期，支持启动时扫描比对磁盘实际状态。

| 字段              | 类型          | 约束                                           | 说明                                                                                                                                                         |
| ----------------- | ------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id                | SERIAL        | PRIMARY KEY                                    | 自增主键                                                                                                                                                     |
| session_id        | INTEGER       | FK → recording_sessions(id) ON DELETE SET NULL | 所属会话（孤文件为 NULL）                                                                                                                                    |
| room_url          | VARCHAR(512)  | FK → rooms(room_url) ON DELETE SET NULL        | 关联直播间                                                                                                                                                   |
| file_path         | VARCHAR(1024) | NOT NULL UNIQUE                                | 文件绝对路径                                                                                                                                                 |
| file_name         | VARCHAR(512)  |                                                | 文件名                                                                                                                                                       |
| file_size         | BIGINT        | DEFAULT 0                                      | 文件大小（字节）                                                                                                                                             |
| status            | VARCHAR(20)   | DEFAULT 'pending'                              | 状态流转见下                                                                                                                                                 |
| started_at        | TIMESTAMP     | DEFAULT NOW()                                  | 写入时间                                                                                                                                                     |
| ended_at          | TIMESTAMP     |                                                | 结束时间                                                                                                                                                     |
| completed_at      | TIMESTAMP     |                                                | 完成时间                                                                                                                                                     |
| checked_at        | TIMESTAMP     | DEFAULT NOW()                                  | 上次磁盘校验时间                                                                                                                                             |
| segment_index     | INTEGER       | DEFAULT 0                                      | 分片序号                                                                                                                                                     |
| duration_seconds  | INTEGER       | DEFAULT 0                                      | 时长（秒）                                                                                                                                                   |
| is_hls_ready      | BOOLEAN       | DEFAULT FALSE                                  | HLS 是否已生成                                                                                                                                               |
| hls_playlist_path | VARCHAR(1024) | DEFAULT ''                                     | HLS 播放列表路径                                                                                                                                             |
| hls_generated_at  | TIMESTAMP     |                                                | HLS 生成时间                                                                                                                                                 |
| segment_start_ms  | INTEGER       | DEFAULT 0                                      | 分段起始时间（毫秒）                                                                                                                                         |
| segment_end_ms    | INTEGER       | DEFAULT 0                                      | 分段结束时间（毫秒）                                                                                                                                         |
| danmaku_ass_path  | VARCHAR(1024) | DEFAULT ''                                     | 兼容字段。分段级 ASS 文件以确定性路径 `{session.output_dir}/danmaku/segments/{recording_files.id}.ass` 为准，生成接口会回填该列以兼容历史流程，DROP 推迟执行 |
| created_at        | TIMESTAMP     | DEFAULT NOW()                                  | 创建时间                                                                                                                                                     |

**状态流转：**

```
非分段：  recording ──→ completed         （ffmpeg 启动→关闭）
                          │
                          ├──→ interrupted  （ffmpeg 崩溃/手动停止）

分段：    completed                       （分片完成时直接 INSERT）

扫描：    orphaned                        （磁盘有文件但无记录）
          missing                         （DB 有记录但磁盘无文件）
```

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

| 字段                    | 类型          | 约束                                    | 说明                                                                                                                                                     |
| ----------------------- | ------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                      | SERIAL        | PRIMARY KEY                             |                                                                                                                                                          |
| name                    | VARCHAR(255)  | NOT NULL                                | 模板名称                                                                                                                                                 |
| room_url                | VARCHAR(512)  | FK → rooms(room_url) ON DELETE SET NULL | 关联直播间（可选）                                                                                                                                       |
| title_template          | VARCHAR(1024) |                                         | 标题模板，默认 `{room_name} 直播录像 {date}`                                                                                                             |
| desc_template           | TEXT          |                                         | 简介模板                                                                                                                                                 |
| tid                     | INTEGER       | DEFAULT 171                             | B站分区 ID                                                                                                                                               |
| tags                    | VARCHAR(1024) |                                         | 标签，逗号分隔                                                                                                                                           |
| copyright               | INTEGER       | DEFAULT 2                               | 1-自制 2-转载                                                                                                                                            |
| source                  | VARCHAR(1024) | DEFAULT `{room_url}`                    | 转载来源（支持模板变量）                                                                                                                                 |
| cover                   | VARCHAR(1024) |                                         | 封面路径                                                                                                                                                 |
| is_only_self            | INTEGER       | DEFAULT 0                               | 仅自己可见，0-关闭 1-开启                                                                                                                                |
| cookies_path            | VARCHAR(1024) |                                         | biliup 账户文件绝对路径（必填）                                                                                                                          |
| dtime                   | INTEGER       | DEFAULT 0                               | 延迟发布时间，10 位 Unix 时间戳                                                                                                                          |
| after_upload            | VARCHAR(20)   | DEFAULT 'none'                          | 投稿后处理方式：`none` 无操作、`backup` 备份到NAS、`delete` 删除本地文件、`backup_and_delete` 备份到NAS后删除本地文件；未配置 `NAS_*` 时备份类动作会跳过 |
| created_at / updated_at | TIMESTAMP     |                                         |                                                                                                                                                          |

**模板变量：** `{room_name}` `{room_url}` `{caption}` `{date}` `{datetime}` `{YYYY}` `{MM}` `{DD}` `{HH}` `{mm}` `{ss}`

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

| 键                           | 默认值             | 说明                                                       |
| ---------------------------- | ------------------ | ---------------------------------------------------------- |
| `pool_size`                  | `3`                | 下载线程池大小，限制最大同时录制数                         |
| `watchdog_interval`          | `30`               | 看门狗检查间隔（秒）                                       |
| `watchdog_timeout`           | `60`               | 录制状态检查超时（秒），超过则标记为完成                   |
| `filtering_threshold`        | `10`               | 碎片过滤阈值（MB），小于此大小的文件将被过滤               |
| `delay`                      | `60`               | 下播延迟检测（秒）                                         |
| `submit_api`                 | ``                 | biliup --submit 选项，留空为自动                           |
| `lines`                      | ``                 | 上传线路，留空为自动                                       |
| `threads`                    | `3`                | 单文件并发上传数                                           |
| `pool2_size`                 | `3`                | 上传线程池大小                                             |
| `max_upload_limit`           | `99`               | 上传重试次数上限（内存计数，重启后重置），建议设为 `2`-`3` |
| `max_resume_retries`         | `3`                | 会话崩溃后最大恢复重试次数                                 |
| `auto_transcode`             | `true`             | 是否自动转码 FLV 到 MP4                                    |
| `transcode_delete_originals` | `true`             | 转码后是否删除原 FLV 文件                                  |
| `transcode_concurrency`      | `3`                | 转码队列并发数，控制同时处理的转码任务数                   |
| `kuaishou_danmaku_enabled`   | `false`            | 是否启用快手弹幕采集                                       |
| `danmaku_burn_concurrency`   | `1`                | 弹幕压制队列并发数（强制最大 1）                           |
| `danmaku_density_per_second` | `20`               | ASS 字幕每秒最大弹幕密度                                   |
| `danmaku_font_family`        | `Noto Sans CJK SC` | ASS 字体                                                   |
| `danmaku_font_size`          | `32`               | ASS 字体大小                                               |
| `danmaku_opacity`            | `0.75`             | ASS 弹幕不透明度                                           |
| `replay_enabled`             | `true`             | 是否启用回放工具箱                                         |
| `replay_work_dir`            | `/data/replay`     | 回放处理工作目录默认值；实际文件路径优先使用环境变量 `REPLAY_WORK_DIR` |
| `replay_queue_concurrency`   | `1`                | 回放队列并发数（当前强制最大 1）                           |
| `replay_cron_enabled`        | `false`            | 是否启用回放定时任务                                       |
| `replay_cron_expr`           | `0 3 * * *`        | 回放定时任务表达式                                         |
| `replay_auto_upload`         | `false`            | 回放处理完成后是否自动投稿                                 |
| `replay_max_count_per_run`   | `1`                | 单次主播回放批处理默认数量                                 |

---

### danmaku_capture_records — 弹幕采集记录

**记录每个会话的弹幕采集生命周期。** 一个 `session_id` 可能对应多条采集记录（如中断后重连）。

| 字段        | 类型          | 约束                | 说明                                 |
| ----------- | ------------- | ------------------- | ------------------------------------ |
| id          | SERIAL        | PRIMARY KEY         | 自增主键                             |
| session_id  | INTEGER       |                     | 所属录制会话                         |
| room_id     | INTEGER       |                     | 关联房间                             |
| platform    | VARCHAR(50)   | DEFAULT 'kuaishou'  | 平台标识                             |
| status      | VARCHAR(20)   | DEFAULT 'recording' | `recording` → `completed` / `failed` |
| raw_path    | VARCHAR(1024) | DEFAULT ''          | `danmaku.jsonl` 文件绝对路径         |
| ass_path    | VARCHAR(1024) | DEFAULT ''          | 生成的 `danmaku.ass` 文件路径        |
| event_count | INTEGER       | DEFAULT 0           | 采集到的弹幕事件总数                 |
| started_at  | TIMESTAMP     | DEFAULT NOW()       | 采集开始时间                         |
| ended_at    | TIMESTAMP     |                     | 采集结束时间                         |
| error       | TEXT          | DEFAULT ''          | 失败时的错误信息                     |
| created_at  | TIMESTAMP     | DEFAULT NOW()       | 记录创建时间                         |

**写入时机：**

| 场景                 | 操作                                          |
| -------------------- | --------------------------------------------- |
| 录制会话启动弹幕采集 | INSERT，status = `recording`                  |
| 录制正常结束         | UPDATE status = `completed`，写入 event_count |
| 采集异常             | UPDATE status = `failed`，写入 error          |

---

### danmaku_burn_records — 弹幕压制记录

**记录每个分段的弹幕压制（FFmpeg 渲染）任务。** 每个 `recording_file_id` 最多一条记录（UNIQUE 约束）。压制产物输出到独立的 `DANMAKU_OUTPUT_DIR` 目录（默认 `VIDEO_DOWNLOAD_DIR/../danmaku_output`），与录制文件物理隔离。

| 字段              | 类型          | 约束             | 说明                                                            |
| ----------------- | ------------- | ---------------- | --------------------------------------------------------------- |
| id                | SERIAL        | PRIMARY KEY      | 自增主键                                                        |
| session_id        | INTEGER       |                  | 所属录制会话                                                    |
| recording_file_id | INTEGER       | UNIQUE           | 关联的 `recording_files.id`                                     |
| segment_index     | INTEGER       | DEFAULT 0        | 分段序号                                                        |
| segment_start_ms  | INTEGER       | DEFAULT 0        | 分段起始时间（毫秒）                                            |
| segment_end_ms    | INTEGER       | DEFAULT 0        | 分段结束时间（毫秒）                                            |
| input_path        | VARCHAR(1024) | NOT NULL         | 输入视频路径                                                    |
| ass_path          | VARCHAR(1024) | NOT NULL         | ASS 字幕文件路径                                                |
| output_path       | VARCHAR(1024) | DEFAULT ''       | 压制输出视频路径，独立目录 `DANMAKU_OUTPUT_DIR/[sessionId]/` 下 |
| status            | VARCHAR(20)   | DEFAULT 'queued' | 状态流转见下                                                    |
| error             | TEXT          | DEFAULT ''       | 失败时的错误信息                                                |
| log_path          | VARCHAR(1024) | DEFAULT ''       | FFmpeg 压制日志路径                                             |
| session_ass_path  | VARCHAR(1024) | DEFAULT ''       | 会话级 ASS 路径（来源于 `danmaku_capture_records.ass_path`）    |
| jsonl_path        | VARCHAR(1024) | DEFAULT ''       | 弹幕 JSONL 原始数据路径                                         |
| enqueued_at       | TIMESTAMP     | DEFAULT NOW()    | 入队时间                                                        |
| started_at        | TIMESTAMP     |                  | 压制开始时间                                                    |
| completed_at      | TIMESTAMP     |                  | 压制完成/失败时间                                               |
| created_at        | TIMESTAMP     | DEFAULT NOW()    | 记录创建时间                                                    |

**状态流转：**

```
queued ──→ processing ──→ completed
                     └──→ failed
            queued ──→ skipped     （输入/ASS 文件不存在时跳过）
```

**写入时机：**

| 场景                  | 操作                                 |
| --------------------- | ------------------------------------ |
| 手动/自动加入压制队列 | INSERT，status = `queued`            |
| 压制队列开始处理      | UPDATE status = `processing`         |
| FFmpeg 压制成功       | UPDATE status = `completed`          |
| FFmpeg 压制失败       | UPDATE status = `failed`，写入 error |
| 输入/ASS 文件不存在   | UPDATE status = `skipped`            |

---

### replay_records — 回放记录

记录快手主播回放的抓取、下载、剪切、修复、投稿和备份状态。`principal_id + replay_id` 在 `replay_id` 非空时保持唯一。

| 字段             | 类型          | 约束          | 说明                                                                                           |
| ---------------- | ------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| id               | SERIAL        | PRIMARY KEY   | 自增主键                                                                                       |
| principal_id     | VARCHAR(128)  | NOT NULL      | 快手主播 ID                                                                                    |
| principal_name   | VARCHAR(255)  |               | 主播名称                                                                                       |
| replay_id        | VARCHAR(128)  |               | 平台回放 ID                                                                                    |
| play_url         | TEXT          |               | 回放播放页地址                                                                                 |
| m3u8_url         | TEXT          |               | 已提取的 m3u8 地址                                                                             |
| video_file_name  | VARCHAR(512)  |               | 原始视频文件名                                                                                 |
| raw_file_path    | VARCHAR(1024) |               | 下载后的原始文件路径                                                                           |
| cut_file_paths   | TEXT          | JSON 字符串   | 剪切后的文件路径数组                                                                           |
| fixed_file_paths | TEXT          | JSON 字符串   | 修复后的文件路径数组                                                                           |
| final_file_paths | TEXT          | JSON 字符串   | 最终可投稿文件路径数组                                                                         |
| file_size        | BIGINT        | DEFAULT 0     | 原始文件大小                                                                                   |
| bv_id            | VARCHAR(50)   |               | 投稿成功后的 BV 号                                                                             |
| status           | VARCHAR(50)   |               | `pending` / `extracted` / `downloaded` / `cut` / `fixed` / `uploaded` / `completed` / `backed_up`（历史） / `cancelled` / `failed` |
| start_time       | TIMESTAMP     |               | 回放开始时间                                                                                   |
| duration         | INTEGER       | DEFAULT 0     | 回放时长（秒）                                                                                 |
| uploaded_at      | TIMESTAMP     |               | 投稿完成时间                                                                                   |
| backed_up_at     | TIMESTAMP     |               | 备份完成时间                                                                                   |
| error_message    | TEXT          |               | 失败原因                                                                                       |
| created_at       | TIMESTAMP     | DEFAULT NOW() | 创建时间                                                                                       |
| updated_at       | TIMESTAMP     | DEFAULT NOW() | 更新时间                                                                                       |

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

## 迁移

应用启动时 `db/migrate.js` 自动执行建表（`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS` + 默认设置 INSERT），无需手动操作。
