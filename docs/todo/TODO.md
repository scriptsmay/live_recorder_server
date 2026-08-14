# TODO

<!-- 这个目录存放后续开发计划文档。 -->

> 本清单由 Obsidian 知识库（`knowledge-personal/projects/live-recorder-server/`）的 archive_plans / changelog / decisions 全量梳理而来，并与实际代码交叉核对。
> 最后更新：2026-08-14（基线版本 v1.8.3）

## P0 — 功能缺口

1. **ADR-012 Phase 4：孤儿弹幕前端管理页**
   - 后端 4 个端点已就绪（`GET /api/danmaku/orphan`、`reconcile/:id`、`reconcile-all`、`DELETE /:id`），但 `frontend/src/views/` 下**没有** `Orphan.vue`，目前只能靠 curl/API 触发回填
   - 需要：列表 + 时间范围筛选 + 预览匹配结果 + 执行/丢弃按钮；侧边栏入口带未处理数量 badge；与 `SessionDanmaku.vue` 打通跳转
   - 来源：KB `decisions/adr-012-orphan-danmaku-recovery.md`（Phase 4）

2. **ADR-012 Phase 5：回填效果观测与阈值调优**
   - 上线一个直播周期后统计 `orphan_pending` / `orphan_associated` / `orphan_discarded` 分布与自动匹配成功率
   - 成功率 <80% 则 review `orphan_*` 容差配置；量级 >50/天 再考虑接入看门狗周期任务（当前默认不接）

3. **投稿使用直播间封面（模板级可选开关）** → 计划走 v1.9.0

   需求（已确认）：做成投稿模板里的一个 checkbox。部分直播间开播时拿不到封面，因此必须是可选 + 有兜底：**只有「模板勾选了用直播间封面」且「目录里确实存在封面文件」时才用它投稿，其余情况一律不带封面。**

   现状盘点（已核对代码）：
   - 直播侧封面**已经在下载**：`RecorderService.js:673-682` 从 `roomCover` 下载到会话目录，`recordingManager.updateSessionCover()` 写入 `recording_sessions.cover_path`（表已有 `cover_url` / `cover_path` 两列）
   - biliup 侧**已支持**：`biliup.js:63` 有 `if (cover) args.push('--cover', cover)`
   - `upload_templates` 已有 `cover VARCHAR(1024)` 列，但语义是「固定封面路径」，不是开关
   - **缺口 1**：模板没有"是否使用直播间封面"的布尔开关
   - **缺口 2**：回放侧只把 `poster` 存成 URL（`replay_records.poster`），从未下载成文件
   - **缺口 3**：投稿时 `UploadService.js:255,270` 与 `ReplayUploadService.js:277` 都只读 `tmpl.cover`，完全没用 `session.cover_path`

   实施要点：
   - DB：`upload_templates` 加 `use_room_cover BOOLEAN DEFAULT false`（migrate 里 `ADD COLUMN IF NOT EXISTS`）
   - 回放下载阶段：对齐直播侧行为，把 `record.poster` 下载到回放产物目录并落库路径字段（新增 `replay_records.poster_path` 或复用现有目录约定）
   - 投稿封面解析统一成一个 helper，优先级：`use_room_cover=true` 且封面文件 `existsSync` → 用该文件；否则 `tmpl.cover` 非空且文件存在 → 用它；否则不传 `--cover`。直播投稿与回放投稿共用同一套判定
   - 前端：`Templates.vue` 模板表单加 checkbox；`getUploadPreview()` / 投稿预览返回封面来源与是否命中，便于排查
   - 待确认细节：`RecorderService.js:676` 传的目标文件名是字面量 `'cover.ext'`，需确认 `downloadFile()` 是否按 content-type 推导真实扩展名，投稿侧解析封面路径时不能硬编码扩展名

4. **复核回填后 JSONL 时序对 danmaku-tool 的影响**
   - ADR-012 的实现是**追加写**，回填后目标 `danmaku/{sessionId}.jsonl` 内部不再全局按时间有序（仅追加块自身有序）
   - 需确认 danmaku-tool 的 ASS 生成是读入后排序而非依赖文件顺序，否则回填过的会话压制出的弹幕时序会错乱

## P1 — 已决策，待执行

5. **抽取转码模块为独立项目 + 本项目同步删除** ✅ 已决策（因生产硬件不足才关闭，非功能废弃）
   - 背景：生产 `auto_transcode=false` 仅因生产环境硬件条件不足，功能本身有效
   - 动作：另起新项目立项，提取转码模块（`TranscodeQueue.js` / `transcoder.js` + 边下边转码监听逻辑）
   - 本项目侧：规划一个版本，待新项目可用后同步删除转码相关代码、settings 键、转码记录页与端点
   - 依赖：需先完成 HLS 归属决策（见第 6 项，HLS 若移除并入同一新项目）

6. **HLS 自动生成配置** ✅ 已决策保留（原因同转码）
   - 生产 `auto_generate_hls=false` 是因暂不需要预览视频文件才关闭，功能保留
   - 若后续决定移除 HLS 模块，则**并入转码子系统的新建项目**（与第 5 项合并处理）
   - 短期：无需改动，仅保持配置现状

## P2 — 测试与验证债

7. **ADR-010 的 5 项 HLS 集成/回归测试**（v1.7.20 计划挂回、v1.8.0 明确未纳入）
   - 超期/未超期 HLS 混合时清理只删旧目录
   - 文件管理删除 HLS 后 磁盘 / `recording_files` / `managed_files` / 审计四方一致
   - 一个会话多 HLS 目录时列表数 = 磁盘数
   - 重启后已删/已过期 HLS 不重新生成
   - 自动转码完成后仍能正常生成 HLS

8. **v1.7.19 看门狗日志修复的生产端确认**：代码已把心跳 `important` 降为 `info`，但"生产观察一个看门狗周期、确认扫描日志只进 `watchdog.log` 不进 `server.log`"这一步从未记录

9. **前端组件测试**：需引入 `@vue/test-utils`，侧边栏重构等 P2 项当时因此搁置

## P3 — 运维与编排

10. **compose 迁移到 base + prod override**
    - 仓库侧 v1.8.2 已整理为 base + build + prod + cron/browserless，但**现网仍是手工维护的单文件 `docker-compose.yml`**，与仓库模板脱节
    - 迁移前需把真实值搬进生产 `.env`：`APP_VERSION`、`EXTERNAL_NETWORK_NAME`、`DANMAKU_ARCHIVE_HOST_DIR`、`YTDLP_TEMP_HOST_DIR`

11. **空目录自动回收 Phase 3 生产灰度**（v1.7.15 起挂到现在）
    - 生产只读扫描统计两个根目录候选空目录数量 + 前 20 条样例路径
    - dryRun 跑一轮核对活跃录制 / 回放队列 / HLS 保护
    - 保持 `file_cleanup_enabled=false`，仅开 `file_cleanup_empty_dirs_enabled`

12. **HLS 匿名播放未纳入鉴权**：AUTH_LOGIN 计划遗留的安全缺口，缓解方案（反代 `auth_request`，或 `/hls/*` 仅监听 127.0.0.1）仍停留在文档建议层面

13. **发布流程补一条**：镜像升级时同步校对生产 compose 是否需要更新（KB `skills/release-workflow/SKILL.md`）

## P4 — 清理与技术债

14. **超大 service 拆分**：`FileManageService.js`（~1200 行）、`RecorderService.js`（~900 行）

15. **`recording_files` 重命名为 `recordings`**：双表合并已完成，表名优化 + 按查询模式补索引 + 清理双表操作残留代码

16. **文件管理 Task 7 缺项：删除前备份到 NAS 归档目录**（`FileManageService` 删除链路 + `backup.js`，与百度网盘备份不是同一条路线）

17. **EJS 中间件与依赖清理**：`server/router/html.js` 已全注释，相关依赖可移除以减小体积

18. **v1.6.0 code review 的 21 个 LOW 级遗留项**：非阻塞，一直延后，建议挑一版集中收口

19. **斗鱼平台功能性修复**：v1.8.2 只更正了文档表述，未动 `DouyuChecker.js` / `signers/douyu.js` / `douyu-vip.js`（生产零斗鱼房间，不阻塞）

20. **目录结构收尾（可选）**：`PollingManager.js` / `watchdog.js` 两处冗余 require 路径；`scripts/` 中纯后端脚本（`ensure-db.js`、`transcode-missed.js`）移入 `server/scripts/`

## 待起草

21. **ADR-013：扩展端弹幕本地持久化（IndexedDB）**
    - ADR-012 方案 D，作为孤儿弹幕的前置防线：chrome-live-listener 在推送失败时本地落盘 + Blob 导出
    - 涉及扩展侧 `core/state.js` / `core/danmaku-session.js` / `manifest.json`（需 `unlimitedStorage`）
    - 注：ADR-012 Phase 1 的扩展侧止血（409 回填 buffer）已闭环，无需重做


## 暂缓 / 条件触发（有明确触发条件才做）

- 日志页虚拟滚动 —— 触发条件：单文件 >100MB 且实际感到卡顿
- 孤儿文件列表虚拟滚动（`useVirtualList`）—— 触发条件：孤儿文件量级明显增长
- 限制单 IP 最大 SSE 连接数
- `auth_logs` 审计日志表（谁在何时登录）
- 百度网盘备份的陈旧度检测（同步停滞）—— 用户确认暂缓，当前只覆盖"挂载过期/不可写"
- 快手反爬自适应策略：连续 3 轮带 cookie 仍触发反爬时清除 cookie 重建 session
- HLS 进阶：QSV 硬件加速重编码、CDN 推送、多码率、加密 DRM
- 转码队列迁移到 BullMQ / Redis AOF-RDB 持久化 —— 归入转码新项目考虑，本项目不再演进（见 P1 第 5 项）
- 完整弹幕数据模型解耦 —— 若自由压制高频使用再考虑

## 已完成 / 已作废

> 已上线和已作废的历史记录不在本清单维护，完整归档见知识库：
> `knowledge-personal/projects/live-recorder-server/`（`changelog/` 逐版本发布记录 + `_index.md` 近期活动）。
> 本文件只保留待办与在途项。
