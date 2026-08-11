# 文件管理规则（File Management Rules）

> 本文档说明 `live_recorder_server` 文件管理模块的两类核心规则：
>
> 1. **自动清理规则**（按保留天数定时清理）；
> 2. **删除安全校验 7 条规则**（`validateFileSafety`，任何用户/系统删除前都要过）。
>
> 配套表结构见 `DB.md` 的 `managed_files` / `file_delete_audit_logs`；接口见 `API.md` 的「文件管理」章节。

---

## 1. 概述

| 项           | 说明                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 核心服务     | `server/services/FileManageService.js`                                                                                                  |
| 自动清理调度 | `server/lib/core/FileCleanupScheduler.js`                                                                                               |
| HLS 目录删除 | `server/services/HLSCleanupService.js`                                                                                                  |
| 索引表       | `managed_files`（每次扫描同步磁盘状态；`safe_to_delete`、`delete_block_reason`、`mtime`、`status` 等字段决策的依据）                    |
| 路径白名单   | 来自 `lib/utils/path-safety` 的 `ALLOWLIST_ROOTS`（默认 `/data/video_downloads`、`/data/replay`；生产可能为其他挂载点，以代码配置为准） |

两类触发删除的操作：

- **自动清理**：系统定时任务，按「保留天数 + 可安全删除」生成删除计划并执行。
- **用户删除**：前端批量删除 / 单文件删除，先 `generateDeletePlan`（dry-run，拆成 `deletable` / `blocked`），用户确认后再异步执行。

---

## 2. 自动清理规则（保留天数）

### 2.1 触发与开关

- `FileCleanupScheduler` 每日执行一次（进程启动后延迟首次运行，之后每 24h）。
- 总开关：`file_cleanup_enabled`（默认 `false`）。关闭则整体跳过自动清理。
- 独立开关 `file_cleanup_empty_dirs_enabled`：控制「自下而上回收空目录」，与文件清理互不依赖。
- 建议通知开关：`file_cleanup_suggestion_notify`（默认 `false`）。

### 2.2 关键参数（`settings` 表）

| key                               | 默认    | 含义                                                                     |
| --------------------------------- | ------- | ------------------------------------------------------------------------ |
| `file_cleanup_retention_days`     | `30`    | 文件保留天数 `N`（超过则进入清理候选）                                   |
| `file_cleanup_categories`         | 空      | 限定清理的 category（逗号分隔）；为空 = 全部                             |
| `file_cleanup_empty_dirs_enabled` | `false` | 是否回收空目录                                                           |
| `file_cleanup_suggestion_notify`  | `false` | 是否发送清理建议通知                                                     |
| `hls_cleanup_days`                | `30`    | **HLS 目录独立**保留天数；`0` = 禁用，且不受 `file_cleanup_enabled` 控制 |

### 2.3 选择条件

自动清理调用 `generateDeletePlan({ filters })`，过滤条件为：

```
safe_to_delete = true
AND COALESCE(mtime, created_at) <= NOW() - INTERVAL 'N days'
AND status NOT IN ('deleted', 'missing')
```

- `safe_to_delete` 在**文件扫描**（scan）阶段根据业务状态打标，是进入候选的前提。
- `mtime` 在**扫描插入**时即写入：录制/回放/弹幕扫描从源表 `created_at` 取「创建时间」填入 `mtime`（HLS 目录扫描则取目录真实 `stat.mtime`），不再依赖事后回填。
- `older_than_days` 使用 `COALESCE(mtime, created_at)` 兜底：历史残留或磁盘文件已丢失（stat 不到）的记录退化为 `created_at`，避免永远命不中。
- **`safe_to_delete` / `delete_block_reason` 在刷新时按源终态自愈**（见 §7 问题 C）：`_refreshDiskStatus` 现在把 `status='missing'` 的记录也纳入刷新；当文件确认从磁盘消失（ENOENT）时，按业务源记录是否处于终态重新计算并写回这两个标记，避免历史残留的 `file_not_found` / `false` 永久阻挡删除。
- HLS 目录另有 `hls_cleanup_days` 策略，由 `HLSCleanupService.cleanupExpired()` 独立执行，逻辑与上面不同（见 §5）。

### 2.4 执行流程

```
runAutoCleanup()
  → 读取 retention_days / categories
  → generateDeletePlan({ filters: { safe_to_delete:true, older_than_days:N, category? } })   # dry-run
  → 若 deletable_count == 0 跳过
  → executeDelete(plan_id)  → 异步任务（最多等待 10 分钟轮询）
  → 发通知：删除 / 失败 / 无可清理
```

---

## 3. 删除安全校验 7 条规则（`validateFileSafety`）

无论是**自动清理**还是**用户删除**，在 `generateDeletePlan` 阶段都会对每一个候选文件调用一次
`validateFileSafety(fileRecord, { allowMissing: true })`。

> 规则按顺序短路求值：**任意一条不通过即返回 `{ safe:false, reason }`**，该文件被放入删除计划的 `blocked[]`，不会进入实际删除。

| #   | 规则                             | 校验方式                                                                           | 不通过时的 `reason`                                                           |
| --- | -------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | **路径在白名单内**               | `resolveAndValidate(file_path)`（path-safety）                                     | `outside_allowlist`（或 path-safety 返回的具体 reason）                       |
| 2   | **文件当前存在（磁盘）**         | `fs.promises.stat(file_path)`；ENOENT 时，**若非** `allowMissing` 才拦截           | `file_not_found`；其他 stat 错误 → `stat_error: <msg>`                        |
| 3   | **不是目录**（HLS 聚合目录除外） | `stat.isDirectory()` 且 `file_type !== 'hls_directory'`                            | `is_directory`                                                                |
| 4   | **不属于活跃任务**               | `isFileInActiveTask()`：录制中 / 转码中 / 投稿中                                   | `active_task_recording` / `active_task_transcoding` / `active_task_uploading` |
| 5   | **不属于进行中的录制会话**       | 当 `source_table=recording_files`，JOIN 查 `recording_sessions.status='recording'` | `active_recording_session`                                                    |
| 6   | **不在 Redis 待处理队列**        | `_isFileInRedisQueue()`：查 `transcode_queue_paths` 集合                           | `in_processing_queue`                                                         |
| 7   | **业务记录处于终态**             | 见下方「可删终态集合」                                                             | `recording_status_<status>` / `replay_status_<status>`                        |

### 规则 2 的 `allowMissing` 开关（易混淆点）

批量删除 / 自动清理传入 `allowMissing: true`，即**允许「磁盘文件已丢失」本身**——这是为清理索引孤儿记录而设计。
所以「文件不在磁盘」**不会**触发拦截；真正会把孤儿记录挡在 `blocked[]` 的，通常是规则 5/7（业务记录仍被视为「进行中/未结束」）。

### 规则 7 的可删终态集合

- `source_table = recording_files`：`status` ∈
  `completed, interrupted, missing, deleted, failed, cancelled, orphaned`
  （仅进行中状态如 `recording` 继续拦截）。
- `source_table = replay_records`：`status` ∈
  `completed, uploaded, backed_up, failed, cancelled`。

> 历史坑：早期版本规则 7 只放行 `completed` / `interrupted`，导致 `status='missing'`（录制丢失）的孤儿 HLS 目录被误判为不可删，reason 为 `recording_status_missing`。现已扩展终态集合（见 §7）。

---

## 4. 批量删除流程

```
前端选择文件
  → generateDeletePlan({ file_ids } 或 { filters })       # 同步，dry-run
       对每个文件跑 validateFileSafety
       safe  → deletable[];
       否则  → blocked[]（带 reason）
  → 返回 plan_id + deletable_count / blocked_count / total_size
  → 用户确认（前端二次确认）
  → executeDelete(plan_id)  → 返回 task_id（fire-and-forget，后台异步）
  → _processDeleteTask：逐文件 _deleteSingleFile → 实时更新 redis 任务状态
  → 审计：每次删除写 file_delete_audit_logs
```

- `file_ids` 模式单次上限 **200** 个；`filters` 模式上限 **2000** 个。
- 任务进度通过 `getDeleteTaskStatus(task_id)` 轮询。

---

## 5. HLS 目录删除的特殊路径

当 `file_type = 'hls_directory'` 且 `source_table = 'recording_files'` 时，单文件删除会**委托给
`HLSCleanupService.deleteForRecording(source_id, reason, operator)`**，不走普通 unlink 分支。

该服务按 `hls_status` / 会话状态决策：

| 情况                                 | 结果                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `hls_status` ∈ `expired` / `deleted` | 补偿置 `managed_files` 为 `deleted`，返回 `success_noop`（视为已清理） |
| `hls_status` ≠ `ready`（且非上述）   | `blocked`，`error = hls_status_<status>`                               |
| 所属会话仍 `recording`               | `blocked`，`error = active_recording_session`                          |
| `hls_playlist_path` 缺失             | `blocked`，`error = hls_playlist_path_missing`                         |
| 路径越界（path-safety 不通过）       | `blocked`，`error = <reason>`                                          |
| 删除过程中状态被并发改变             | `blocked`，`error = hls_status_changed`                                |
| 源 `recording_files` 记录已不存在    | `blocked`，`error = recording_file_not_found`                          |

含义：**HLS 目录最终是否可删，由 `HLSCleanupService` 把关**；`validateFileSafety` 的规则 5/7 只是前置辅助拦截。
一个 `status='missing'` 的孤儿 HLS 目录，只要其 `hls_status='expired'`，走上面第一行就会 `success_noop` 清理掉，因此前置规则 7 放行后即可正常清理。

---

## 6. 「被阻止」reason 速查表

| reason                            | 触发规则    | 含义                                    | 处理建议                                            |
| --------------------------------- | ----------- | --------------------------------------- | --------------------------------------------------- |
| `outside_allowlist`               | 1           | 路径不在白名单根目录内                  | 检查文件实际路径；正常业务文件不应出现              |
| `file_not_found`                  | 2           | 文件不在磁盘（`allowMissing=false` 时） | 通常为单文件删除未开 allowMissing；批量删除不应触发 |
| `stat_error: <msg>`               | 2           | stat 抛非 ENOENT 错误                   | 查磁盘/权限问题                                     |
| `is_directory`                    | 3           | 目标是目录且非 HLS 聚合目录             | 目录删除需以 HLS 聚合形式走 `hls_directory`         |
| `active_task_recording`           | 4           | 该路径正被录制占用                      | 等录制结束                                          |
| `active_task_transcoding`         | 4           | 正转码中                                | 等转码完成                                          |
| `active_task_uploading`           | 4           | 正投稿上传中                            | 等上传完成                                          |
| `active_recording_session`        | 5           | 所属录制会话仍在 `recording`            | 等会话结束                                          |
| `in_processing_queue`             | 6           | 在 Redis 转码队列中                     | 等队列排空                                          |
| `recording_status_<status>`       | 7           | 录制业务记录未到终态（如 `recording`）  | 等录制结束；若为孤儿 `missing` 见 §7 修复           |
| `replay_status_<status>`          | 7           | 回放业务记录未到终态                    | 等回放流程结束                                      |
| `hls_status_<status>`             | 5（执行期） | HLS 未 ready / 未 expired               | 看 HLS 生成状态                                     |
| `recording_file_not_found`        | 5（执行期） | 源录制记录已删                          | 一般会自动补偿置 deleted                            |
| `hls_playlist_path_missing`       | 5（执行期） | 缺少播放列表路径                        | 数据不一致，需查源表                                |
| `hls_status_changed`              | 5（执行期） | 并发改变状态                            | 重试                                                |
| `file_locked` / `EBUSY` / `EPERM` | 执行期      | 文件被占用/无权限                       | 排查占用进程或权限                                  |
| `already_deleted_or_deleting`     | 执行期      | 记录已删除/删除中                       | 无需处理                                            |
| `file_record_not_found`           | 执行期      | 索引记录丢失                            | 一般会自动补偿                                      |

---

## 7. 已知问题与设计注意（截至 2026-07-30）

以下问题 A、B **已在 v1.7.17 部署生效**；问题 C（本次新增）**本地代码已修复，待下次发版部署**（线上现跑 `v1.7.17`）：

### 问题 A：自动清理永不命中（`mtime` 全为 NULL）

- **现象**：全局保留天数改为 10 天后，列表里仍残留 7/1 等旧文件；自动清理日志长期为「无可清理文件」。
- **根因**：录制/回放/弹幕扫描的 upsert 从不写 `mtime`，`managed_files.mtime` 全为 NULL；而清理条件 `mtime <= NOW() - N days` 对 NULL 永远不成立。
- **修复**（两层）：
  1. **扫描即写入**：录制/回放/弹幕扫描的 upsert 现从源表 `created_at` 写入 `mtime`（HLS 目录取目录 `stat.mtime`）。新数据与存量数据在扫描阶段即获得非 NULL 的 `mtime`，不再依赖事后回填。
  2. **`older_than_days` 兜底**：筛选条件改为 `COALESCE(mtime, created_at)`，覆盖磁盘文件已丢失、stat 不到导致 `mtime` 仍为 NULL 的孤儿记录。
  3. **`_refreshDiskStatus` 收敛为安全网**：仅当 `mtime` 为 NULL 时才回补（目录大小仍按偏差修正，但目录大小由 `_scanHlsDirectories` 聚合维护，不会被 `stat.size` 覆盖）。原先「漂移 >1s 即覆盖」的逻辑会冲掉扫描阶段写入的 `created_at`，已移除。
- **状态**：✅ 已在 v1.7.17 部署生效。

### 问题 B：孤儿 HLS 目录被误拦（`recording_status_missing`）

- **现象**：批量删除 `file_id` 结果为「被阻止」，reason = `recording_status_missing`。
- **根因**：`validateFileSafety` 规则 7 原只允许 `completed` / `interrupted`；而对应录制 `status='missing'`（录制丢失，终态）被误判不可删，在 `generateDeletePlan` 阶段就进 `blocked[]`。
- **修复**：规则 7 终态集合扩展为 `completed, interrupted, missing, deleted, failed, cancelled, orphaned`；活跃状态（如 `recording`）仍拦截。
- **状态**：✅ 已在 v1.7.17 部署生效。

### 问题 C：陈旧 `file_not_found` 标记导致 `safe_to_delete=false` 永久阻挡删除

- **现象**：`file_id`（如 5309、5298）已是 `status='missing'`、`delete_block_reason='file_not_found'`、`safe_to_delete=false`，但源业务记录已是终态（`deleted`/`missing`），用户在 UI 上看到「不可删除」，自动清理也筛不到它。
- **根因（两段式）**：
  1. 早期版本 `_refreshDiskStatus` 在 ENOENT 时只设 `exists_on_disk=false, status='missing'`，**不触碰** `safe_to_delete` / `delete_block_reason`。
  2. 而 `status='missing'` 的记录随后被所有扫描/刷新查询的 `WHERE status NOT IN (...,'missing')` 排除，**永不再被重新评估**，于是陈旧标记永久保留。`v1.7.x` 全代码树已无任何地方再写 `delete_block_reason='file_not_found'`，证明它是历史残留的死值。
- **关键认知**：真正决定是否可删的是运行期 `validateFileSafety`（**不看 `safe_to_delete` 列**），所以这类记录在 v1.7.17 下「其实能删」——只是陈旧的列值误导了 UI 展示与自动清理的候选筛选。
- **修复（本次，本地 `FileManageService.js`）**：
  1. `_refreshDiskStatus` 查询**不再剔除 `status='missing'`**，使这类记录也能被重新评估。
  2. ENOENT 时调用新增的 `_evaluateMissingSafety(row)`，按源记录终态重新计算并写回标记：
     - 源为终态（`RF_DELETABLE_STATUSES` / `REPLAY_DELETABLE_STATUSES`）或**无业务来源（孤儿索引）** → `safe_to_delete=true, delete_block_reason=NULL`；
     - 源仍进行中（如 `recording`） → 保留 `safe_to_delete=false, delete_block_reason='file_not_found'`（仍由运行期校验二次把关，不会误删）。
  3. 若 `missing` 记录的文件重新出现，恢复 `exists_on_disk=true, status='active'`，避免「missing 但磁盘存在」的僵死状态。
  4. 同时把可删终态集合抽成模块级常量 `RF_DELETABLE_STATUSES` / `REPLAY_DELETABLE_STATUSES`，`validateFileSafety` 与 `_evaluateMissingSafety` 共用，避免两套定义漂移。
- **线上存量处理（2026-07-30，一次性补丁，非代码）**：先备份 `managed_files` 到 `/tmp/mf_backup_20260730.sql`，再对 `delete_block_reason='file_not_found' AND status NOT IN ('deleted','deleting')` 的 **19 行**置为 `safe_to_delete=true, delete_block_reason=NULL`（其余 13 行本就是 `deleted`/`deleting` 僵尸记录，未动）。该补丁仅为治标；本修复为治本，发版后任何新出现的 missing 记录都会在下一轮扫描自动自愈，**无需再手动打补丁**。
- **状态**：⏳ 本地代码已修复，待下次发版部署。

> 部署新版本后：问题 A 的 `mtime` 在扫描阶段即写入（存量数据首轮扫描也会补全），次日定时任务即可正常清理；问题 B 的孤儿 HLS 目录即可进入 `deletable` 并被 `HLSCleanupService` 以 `success_noop` 清理；问题 C 的陈旧 `file_not_found` 标记会在扫描刷新时自动清零，UI 与自动清理候选随之恢复正确。
