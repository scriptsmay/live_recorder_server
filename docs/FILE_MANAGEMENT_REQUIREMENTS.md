# 文件管理模块需求文档

## 背景

当前生产环境的视频文件主要落在以下目录：

- 直播录制：`VIDEO_DOWNLOAD_DIR`，生产挂载为 `/data/video_downloads`
- 回放下载：`REPLAY_OUTPUT_DIR`，生产挂载为 `/data/replay`
- 弹幕压制输出：`DANMAKU_OUTPUT_DIR`，生产挂载为 `/data/danmaku_output`

这些目录在 NAS 上对应 `/srv/nas-data/videos/live_records/*`。直播录制、HLS 分片、回放切片、弹幕压制产物都会产生大文件。当前前端只能查看录制、回放、转码、弹幕压制等业务记录，缺少统一的文件管理入口。用户如果要释放空间，只能直接登录 NAS 删除文件，这会带来几个问题：

- 前端无法判断文件是否仍被业务记录引用。
- 手动删除后数据库状态可能滞后，出现 `missing` 记录。
- 无法批量按日期、主播、文件类型、业务状态清理。
- 用户无法在删除前看到空间释放预估。
- 缺少防误删、操作审计和恢复窗口。

目标是新增一个文件管理模块，让用户在 Web UI 内安全查看、筛选、删除和清理视频文件，并保持数据库记录与磁盘状态一致。

## 目标

1. 提供统一的文件管理页面，覆盖直播录制、HLS、回放、弹幕压制输出和孤儿文件。
2. 支持按业务对象删除指定文件，例如某个录制分段、某条回放的原始文件/切片、某个弹幕压制成品。
3. 删除前展示文件大小、路径、引用关系、风险提示和预计释放空间。
4. 删除后同步更新数据库状态，避免文件系统和前端状态不一致。
5. 支持批量清理已完成、已投稿、已备份或超过保留期的文件。
6. 对所有删除动作做路径安全校验、任务状态校验和审计记录。

## 非目标

- 不做完整 NAS 文件浏览器，不允许浏览配置目录之外的任意路径。
- 不提供对 `.env`、日志、数据库备份、Docker 数据目录等非视频业务文件的删除入口。
- 第一版不实现跨设备归档、云备份或回收站还原。
- 第一版不直接清理 Docker 镜像，Docker 清理应作为运维动作单独处理。

## 文件范围

文件管理模块只管理以下 allowlist 根目录内的文件：

| 分类 | 容器路径 | 主要来源 |
| --- | --- | --- |
| 直播录制 | `VIDEO_DOWNLOAD_DIR` | FFmpeg 录制、HLS 生成、弹幕 JSONL/ASS |
| 回放文件 | `REPLAY_OUTPUT_DIR` | 回放下载、切片、修复、投稿 |
| 弹幕压制 | `DANMAKU_OUTPUT_DIR` | 手动触发的弹幕压制成品 |
| biliup 工作文件 | `BILIUP_WORK_DIR` 下项目专属目录 | 投稿缓存、cookies、临时配置 |

所有删除接口必须将真实路径解析为 absolute path，并确认它位于 allowlist 根目录内。符号链接、`..` 路径穿越、空路径和根目录删除必须拒绝。

## 信息架构

新增前端页面：`/files`

侧边栏名称：`文件管理`

页面结构：

- 顶部空间概览
  - `/data/video_downloads` 占用
  - `/data/replay` 占用
  - `/data/danmaku_output` 占用
  - 总占用与预计可清理空间
- 标签页
  - `全部文件`
  - `直播录制`
  - `回放文件`
  - `弹幕压制`
  - `孤儿文件`
  - `清理规则`
- 文件表格
  - 文件名
  - 类型
  - 大小
  - 所属主播/房间
  - 所属会话/回放
  - 状态
  - 最近修改时间
  - 引用来源
  - 操作

## 核心交互

### 文件列表

用户可以按以下条件筛选：

- 文件分类：直播录制、HLS、回放原始文件、回放切片、弹幕压制、弹幕数据、孤儿文件
- 业务状态：录制中、已完成、已投稿、已备份、缺失、孤儿
- 主播/房间
- 会话 ID
- 回放 ID
- 文件类型：`.ts`、`.mp4`、`.mkv`、`.m3u8`、`.jsonl`、`.ass`
- 时间范围
- 最小文件大小
- 是否可安全删除

默认排序：按文件大小倒序。

### 文件详情

点击文件打开详情抽屉：

- 完整路径
- 文件大小
- 创建/修改时间
- 所属业务记录
- 是否存在于磁盘
- 是否存在数据库引用
- 是否处于活跃任务中
- 删除风险说明
- 可执行操作

### 单文件删除

删除按钮默认只对可安全删除文件启用。点击后弹出确认对话框：

- 展示文件名、大小、路径、引用记录
- 展示删除后数据库更新动作
- 要求二次确认

删除成功后：

- 文件从磁盘删除。
- 对应 `recording_files.status` 更新为 `deleted`。
- 对应回放记录的路径字段保留历史值，但可增加删除标记或在文件详情中显示缺失。
- 弹幕压制记录可选删除记录或保留记录并显示 `file_deleted=true`。
- 写入审计日志。

### 批量删除

批量删除支持两种模式：

- 勾选列表中的文件后删除。
- 使用筛选条件生成清理计划后删除。

批量删除必须先执行 dry-run：

- 返回匹配文件数量
- 总大小
- 按文件类型分组
- 不可删除文件列表及原因
- 会被更新的数据库记录数量

用户确认后才执行真实删除。

### 清理规则

第一版建议支持手动触发，不先做自动定时清理：

- 删除超过 N 天的 HLS 分片。
- 删除超过 N 天且已投稿的直播录制原始文件。
- 删除超过 N 天且已完成的弹幕压制输出。
- 删除超过 N 天且已投稿/已完成的回放中间文件。
- 标记数据库中已缺失的文件。

后续再增加自动清理：

- 每日定时 dry-run
- 发送清理建议通知
- 用户确认后执行
- 或配置明确策略后自动执行

## 删除安全规则

文件只有满足以下条件才允许直接删除：

1. 路径位于 allowlist 根目录内。
2. 文件当前存在。
3. 文件不是目录。
4. 文件没有被当前进程以写模式打开。
5. 不属于正在录制、正在转码、正在回放下载、正在弹幕压制或正在投稿的任务。
6. 不属于 `recording_sessions.status = 'recording'` 的会话。
7. 不属于 Redis 队列中的待处理任务。
8. 对应业务记录已完成、失败、取消、已投稿或已备份。

风险较高但可手动强制删除的情况：

- 已完成但未投稿的直播录制文件。
- 已完成但未备份的回放成品。
- 弹幕 JSONL/ASS 文件。

禁止删除的情况：

- 录制中的 TS/HLS 文件。
- 转码/压制/回放下载正在处理的输入或输出文件。
- allowlist 根目录本身。
- 不在业务目录下的任意文件。

## 后端 API 设计

### GET `/api/files/summary`

返回文件空间概览。

```json
{
  "status": "ok",
  "data": {
    "total_size": 77309411328,
    "groups": [
      {
        "type": "recording",
        "root": "/data/video_downloads",
        "size": 35433480192,
        "file_count": 1686
      }
    ]
  }
}
```

### GET `/api/files`

查询文件列表。

参数：

- `type`
- `status`
- `room_id`
- `session_id`
- `replay_record_id`
- `ext`
- `min_size`
- `start_date`
- `end_date`
- `safe_to_delete`
- `page`
- `limit`
- `sort`

### GET `/api/files/:id`

查询文件详情。`id` 建议使用后端生成的稳定 ID，不直接暴露未签名路径作为路由参数。

### POST `/api/files/delete-plan`

生成删除计划，不执行删除。

请求：

```json
{
  "file_ids": ["..."],
  "filters": {
    "type": "hls",
    "older_than_days": 7
  }
}
```

响应：

```json
{
  "status": "ok",
  "data": {
    "deletable_count": 120,
    "blocked_count": 3,
    "total_size": 12884901888,
    "blocked": [
      {
        "file_id": "...",
        "reason": "active_recording"
      }
    ]
  }
}
```

### POST `/api/files/delete`

执行删除计划。

请求必须携带 `plan_id`，避免前端确认和后端执行使用不同条件。

```json
{
  "plan_id": "20260623-abc",
  "confirm": true
}
```

### POST `/api/files/scan`

重新扫描业务目录，刷新文件索引和缺失状态。应复用现有文件扫描能力，但扩展到 replay 和 danmaku output。

## 数据模型建议

第一版可以不立即新增全量文件索引表，先组合以下来源生成列表：

- `recording_files`
- `recording_sessions`
- `replay_records`
- `danmaku_burn_records`
- 文件系统扫描结果

但为了支持分页、审计和高效筛选，建议新增两张表。

### `managed_files`

记录业务文件索引。

字段建议：

- `id`
- `category`
- `source_table`
- `source_id`
- `file_path`
- `file_name`
- `extension`
- `file_size`
- `mtime`
- `exists_on_disk`
- `status`
- `safe_to_delete`
- `delete_block_reason`
- `created_at`
- `updated_at`
- `deleted_at`

`file_path` 需要唯一索引。

### `file_delete_audit_logs`

记录删除审计。

字段建议：

- `id`
- `file_id`
- `file_path`
- `file_size`
- `category`
- `source_table`
- `source_id`
- `operator`
- `action`
- `result`
- `error_message`
- `created_at`

## 状态同步规则

### `recording_files`

- 文件删除成功后更新为 `deleted`。
- 文件扫描发现不存在时更新为 `missing`。
- 用户手动确认不再需要时允许从列表隐藏，但不建议物理删除记录。

### `replay_records`

回放记录可能包含多个路径字段：

- `raw_file_path`
- `cut_file_paths`
- `fixed_file_paths`
- `final_file_paths`

删除时不建议清空原字段，避免丢失历史链路。建议额外通过 `managed_files` 或审计表记录删除状态。

### `danmaku_burn_records`

删除压制输出文件时：

- 保留压制记录。
- 增加文件缺失状态展示。
- 如后续需要重压制，可继续使用原输入文件和 ASS 文件重新生成。

## 前端状态

文件操作需要覆盖以下状态：

- loading
- empty
- scan running
- delete plan generating
- deleting
- partial success
- failed
- blocked

批量删除可能出现部分成功，前端必须展示：

- 成功删除数量
- 失败数量
- 失败文件及原因
- 实际释放空间

## 权限与审计

文件管理接口必须走现有登录鉴权。后续如果引入角色权限，删除文件应属于高风险权限。

审计日志至少记录：

- 操作用户
- 操作时间
- 文件路径
- 文件大小
- 删除原因
- 删除结果

## MVP 范围

第一阶段只做最小可用版本：

1. 新增 `/files` 页面。
2. 展示 `downloads`、`replay`、`danmaku_output` 三类文件占用。
3. 支持按文件类型、大小、时间、业务类型筛选。
4. 支持单文件删除和批量 dry-run。
5. 删除直播录制文件时同步更新 `recording_files.status = 'deleted'`。
6. 删除回放/弹幕文件时写审计日志并在列表中显示缺失。
7. 禁止删除活跃任务文件。

第二阶段：

1. 增加清理规则页面。
2. 增加 `managed_files` 索引表。
3. 增加按主播/会话/回放聚合的删除计划。
4. 增加定时扫描和清理建议通知。

第三阶段：

1. 支持自动清理策略。
2. 支持保留策略模板。
3. 支持删除前备份到 NAS 归档目录。
4. 支持空间水位告警。

## 验收标准

- 用户可以在前端看到三类视频文件的真实占用。
- 用户可以删除指定文件，无需登录 NAS。
- 删除前能看到预计释放空间和风险说明。
- 正在录制、下载、转码、压制、投稿的文件无法删除。
- 删除后刷新页面，文件状态与磁盘一致。
- 删除直播录制文件后，`recording_files` 状态正确变为 `deleted`。
- 批量删除支持 dry-run，且 dry-run 与执行结果可追踪。
- 所有删除动作都有审计记录。

## 实现注意事项

- 不要直接信任前端传入的路径。
- 删除前后都要 `stat` 文件，避免 TOCTOU 风险。
- 批量删除要限制单次数量，避免长时间阻塞请求。
- 大批量删除建议异步任务化，通过 Redis 队列执行。
- 文件扫描和删除都应避免跨 allowlist 根目录。
- 对中文文件名和空格路径做端到端测试。
- HLS 目录中 `.m3u8` 与 `segment_*.ts` 应作为一个可聚合对象展示，避免用户只删 playlist 或只删部分 segment。
- 回放记录的 `final_file_paths` 是 JSON 字符串，解析失败时要降级展示原始文本并禁止自动删除。
