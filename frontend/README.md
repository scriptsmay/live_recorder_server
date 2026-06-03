# 直播录制平台 - 前端

本项目是 `live_recorder_server` 的 Vue 3 SPA 前端，从原有 Express + EJS 服务端渲染逐步迁移而来。采用前后端渐进式迁移策略：已迁移的页面由 Vue Router 接管，未迁移的页面继续走 EJS 渲染，两套路由在同一 Express 服务中共存。

## 技术栈

| 分类 | 版本 | 说明 |
|------|------|------|
| Vue | 3.5 | Composition API + `<script setup>` |
| TypeScript | 6.0 | 严格模式，`erasableSyntaxOnly`、`noUnusedLocals`、`noUnusedParameters` |
| Vite | 8.0 | 开发服务器 + 生产构建 |
| Tailwind CSS | 4.3 | `@tailwindcss/vite` 插件 + `@theme` 声明自定义 token |
| Pinia | 3.0 | 全局状态管理（Composition API store） |
| Vue Router | 4.6 | history 模式，路由懒加载 |
| ESLint | 10.x | flat config，集成 TypeScript、Vue、Prettier 规则 |
| Prettier | 3.8 | 代码格式化（通过 ESLint 插件集成） |

## 目录结构

```
frontend/
├── index.html                    # Vite 入口 HTML
├── package.json                  # 脚本命令与依赖
├── vite.config.ts                # Vite 配置：Tailwind 插件、路径别名、开发代理、构建输出
├── tsconfig.json                 # TypeScript 项目引用（app + node）
├── tsconfig.app.json             # 前端代码 TS 配置（路径别名 @/、严格 lint）
├── tsconfig.node.json            # Node 端 TS 配置（vite.config.ts 用）
├── eslint.config.mjs             # ESLint flat config（JS/TS/Vue/Prettier）
├── .prettierrc                   # Prettier 格式化规则
│
├── src/
│   ├── main.ts                   # 入口：创建 Vue app，挂载 Pinia + Router
│   ├── App.vue                   # 根组件：Layout + RouterView + Toast + Confirm
│   ├── style.css                 # Tailwind v4 入口 + 暖橙主题 token + 全局样式
│   ├── env.d.ts                  # 环境类型声明
│   │
│   ├── router/
│   │   └── index.ts              # Vue Router 路由表（10 页面，懒加载，自动设置标题）
│   │
│   ├── stores/
│   │   ├── app.ts                # 全局 store：版本、健康状态、侧栏折叠
│   │   └── danmaku-toolbox.ts    # 弹幕工具箱专用 store
│   │
│   ├── types/
│   │   └── api.ts                # API 响应类型定义（Room、Session、Recording 等全部接口）
│   │
│   ├── utils/
│   │   ├── api.ts                # fetch 封装：apiGet / apiPost / apiPut / apiDelete + ApiError
│   │   ├── toast.ts              # Toast 通知：success / error / warning / info（响应式驱动）
│   │   └── confirm.ts            # 确认对话框：Promise<boolean>（替代 Bootstrap Modal）
│   │
│   ├── components/
│   │   ├── Layout.vue            # 页面布局骨架（Navbar + 内容区 + Footer）
│   │   ├── Navbar.vue            # 响应式导航栏（桌面横排 + 移动端折叠菜单）
│   │   ├── Pagination.vue        # 分页组件（props: current/total，emit: change）
│   │   ├── ToastContainer.vue    # Toast 容器（Teleport 到 body，进入/退出动画）
│   │   └── ConfirmDialog.vue     # 确认对话框（Teleport + 遮罩层 + 动画）
│   │
│   └── views/
│       ├── Dashboard.vue         # 仪表盘：统计卡片、活跃录制表、5s 自动刷新
│       ├── Rooms.vue             # 直播间：CRUD、状态筛选、暂停/恢复/停止操作
│       ├── rooms/
│       │   └── RoomFormModal.vue # 直播间表单弹窗（Teleport，活跃房间限制编辑模式）
│       ├── Sessions.vue          # 录制会话：状态/房间筛选、卡片列表、分页
│       ├── sessions/
│       │   ├── SessionCard.vue   # 会话卡片：录制信息 + 弹幕信息 + 烧录进度
│       │   ├── FilePanel.vue     # 文件面板：懒加载文件表格、HLS/弹幕状态
│       │   └── UploadModal.vue   # 上传弹窗：模板选择 + 确认提交
│       ├── Recordings.vue        # 录制文件：房间筛选、视频播放、转码/删除
│       ├── Transcode.vue         # 转码记录：概览统计条、活跃任务卡片、历史表格
│       ├── DanmakuToolbox.vue    # 弹幕工具箱：搜索会话、分段管理
│       ├── danmaku-toolbox/
│       │   ├── DanmakuSearchModal.vue  # 弹幕搜索弹窗
│       │   ├── SegmentsPanel.vue       # 分段管理面板
│       │   ├── SessionCard.vue         # 弹幕工具箱会话卡片
│       │   └── StatusCards.vue         # 状态卡片组
│       ├── Templates.vue         # 投稿模板：CRUD 表格、12 字段表单、Cookie 刷新
│       ├── UploadRecords.vue     # 投稿记录：分页表格、输出/文件弹窗
│       ├── Settings.vue          # 系统设置：分组卡片、批量保存
│       └── Logs.vue              # 日志查看：两栏布局、SSE 实时流、自动滚动/截断
```

## 快速开始

### 开发模式

```bash
# 安装依赖（首次或依赖变更时）
npm install

# 启动 Vite 开发服务器（默认 :5173）
npm run dev
```

Vite 会自动将 `/api`、`/hls`、`/logs` 请求代理到后端 `localhost:3001`，热更新即时生效。后端需提前启动：

```bash
# 在根目录
npm run dev
```

### 生产构建

```bash
npm run build
```

构建产物输出到 `../public/frontend/`（后端 `public/` 静态目录），由 Express 自动接管。构建过程先执行 `vue-tsc -b` 类型检查，再执行 `vite build`。

### 代码检查

```bash
# 类型检查（不输出文件）
npm run typecheck

# ESLint 检查 + 自动修复
npm run lint

# Prettier 格式化
npm run format
```

## 架构设计

### 路由与后端集成

Vue Router 使用 `createWebHistory` 模式，路由表定义在 `src/router/index.ts`，所有页面组件均为懒加载。路由守卫会自动将 `meta.title` 设置到 `document.title`。

后端通过 `router/spa.js` 实现渐进式集成：

- 构建产物放在 `public/frontend/`，Express 以静态文件方式 serve
- 已迁移的路由（如 `/dashboard`、`/rooms`）返回 `index.html`，由 Vue Router 接管
- 未迁移的路由继续走原有 EJS 渲染逻辑
- API 路由（`/api/*`）、HLS 流（`/hls/*`）、SSE 流不受影响

当前全部 10 个页面均已迁移到 Vue，`spaRoutes` 列表包含：`/dashboard`、`/rooms`、`/sessions`、`/recordings`、`/transcode`、`/danmaku-toolbox`、`/templates`、`/upload-records`、`/settings`、`/logs`。

### API 请求封装

`utils/api.ts` 基于原生 fetch 封装了四个方法，所有 API 调用统一走此层：

```typescript
apiGet<T>(url)                        // GET 请求
apiPost<T>(url, data?)                // POST 请求
apiPut<T>(url, data?)                 // PUT 请求
apiDelete<T>(url, data?)              // DELETE 请求（body 传递 data）
```

响应统一为 `ApiResponse<T>` 接口 `{ status: string, data: T, message?: string }`，错误抛出 `ApiError` 实例（含 `statusCode` 和 `message`）。在页面中的典型用法：

```typescript
import { apiGet, ApiError } from '@/utils/api'

try {
  const res = await apiGet<Room[]>('/api/rooms')
  rooms.value = res.data
} catch (err) {
  toast.error(err instanceof ApiError ? err.message : '加载失败')
}
```

### 状态管理

使用 Pinia Composition API 风格定义 store：

- `stores/app.ts` — 全局应用状态：`appVersion`（从 `/api/health` 获取）、`isHealthy`、`sidebarCollapsed`
- `stores/danmaku-toolbox.ts` — 弹幕工具箱的专用状态（搜索条件、结果、分段数据等）

大部分页面的列表数据和表单状态使用组件内 `ref` 管理，仅在跨页面共享的场景下使用 Pinia store。

### UI 反馈机制

**Toast 通知**（`utils/toast.ts`）：通过响应式 `ref<ToastItem[]>` 驱动 `ToastContainer.vue` 渲染。`useToast()` 返回 `success` / `error` / `warning` / `info` 四个方法，错误类型默认 5 秒显示，其余 3 秒自动消失。

**确认对话框**（`utils/confirm.ts`）：`useConfirm()` 返回 `confirm(message, options?)` 异步方法，返回 `Promise<boolean>`。底层由 `ConfirmDialog.vue` 组件（Teleport 到 body）渲染，替代原有的 Bootstrap Modal。

### 主题样式

`style.css` 通过 Tailwind v4 的 `@theme` 指令声明暖橙色品牌色：

```css
@theme {
  --color-brand-50:  #fff7ed;   /* 最浅 */
  --color-brand-500: #f97316;   /* 主色 */
  --color-brand-600: #ea580c;   /* 悬停/强调 */
  --color-brand-900: #7c2d12;   /* 最深 */
  --color-surface:   #fdf8f3;   /* 页面背景 */
}
```

在模板中直接使用 `bg-brand-500`、`text-brand-700` 等 Tailwind 类名。

## 页面说明

### Dashboard（仪表盘）

展示平台运行概览：4 张渐变统计卡（活跃录制数、进程池大小、转码队列、待处理任务）、活跃录制详情表格。默认 5 秒轮询 `/api/dashboard/status` 和 `/api/health`，可手动暂停自动刷新。

### Rooms（直播间）

完整的直播间管理页面：支持新增、编辑、删除直播间，按状态筛选（全部/空闲/录制中/暂停），显示统计卡片。操作按钮包括暂停录制、恢复录制、停止录制。活跃中的直播间编辑时进入限制模式（部分字段不可修改）。

子组件：`rooms/RoomFormModal.vue` — Teleport 弹窗表单。

### Sessions（录制会话）

以卡片列表展示录制会话，支持按状态和房间筛选。每张卡片显示录制信息（时长、大小、段数）和弹幕信息（事件数、烧录进度条），可展开查看文件详情。

子组件：`sessions/SessionCard.vue`（会话卡片）、`sessions/FilePanel.vue`（懒加载文件表格）、`sessions/UploadModal.vue`（投稿上传弹窗，选择模板后确认提交）。

### Recordings（录制文件）

文件级管理视图：按房间筛选录制文件，表格展示文件信息（大小、时长、HLS/弹幕状态），支持在线播放（视频播放器弹窗）、触发转码、删除文件。

### Transcode（转码记录）

转码任务监控页面：顶部概览统计条（总数、处理中、成功、失败），活跃任务以卡片形式展示（进度条 + 取消按钮），历史记录表格支持按类型筛选（全部/转码/烧录）和分页。

### DanmakuToolbox（弹幕工具箱）

弹幕搜索与管理工具：通过搜索弹窗定位会话，查看和管理弹幕分段数据。

子组件：`danmaku-toolbox/DanmakuSearchModal.vue`、`danmaku-toolbox/SegmentsPanel.vue`、`danmaku-toolbox/SessionCard.vue`、`danmaku-toolbox/StatusCards.vue`。

### Templates（投稿模板）

投稿模板的 CRUD 管理：表格展示模板列表，XL 尺寸弹窗表单包含 12 个字段（名称、Cookie 路径、标题模板、简介模板、标签、来源、分区、版权、仅自己可见、封面、定时发布、上传后操作）。支持复制模板、编辑、删除、刷新 Cookie 操作。

### UploadRecords（投稿记录）

投稿历史查询：分页表格展示投稿记录（状态、模板、BV 号），可查看详细输出和文件信息，支持删除记录。

### Settings（系统设置）

系统配置管理：4 个分组卡片（录制设置、转码设置、上传设置、通知设置），每个卡片内展示相关配置项。修改后批量调用 `PUT /api/settings` 保存。

### Logs（日志查看）

实时日志查看器：左侧文件列表，右侧日志内容区域。核心功能包括 SSE（`EventSource`）实时日志流、自动滚动到底部、日志行数超过 5000 行时自动截断保留最后 4000 行、删除日志文件。

## 共享组件

### Pagination

通用分页组件，用于 UploadRecords、Transcode、Sessions 等需要分页的页面。

```html
<Pagination :current="page" :total="totalCount" @change="handlePageChange" />
```

Props: `current`（当前页码）、`total`（总记录数），默认每页 50 条。Emits: `change(page)`。

### ToastContainer / ConfirmDialog

全局 UI 反馈组件，在 `App.vue` 中挂载，通过 `useToast()` 和 `useConfirm()` 驱动，无需手动管理 DOM。

## 开发注意事项

### Prettier 与 Vue 模板的冲突

Vue 模板中的多语句内联事件处理器需要分号分隔，但 Prettier 会自动移除分号，导致构建报错。解决方案是将多语句逻辑提取为独立的 handler 函数：

```html
<!-- 错误写法：Prettier 会移除分号 -->
<button @click="enabled = !enabled; toggle()" />

<!-- 正确写法：提取为命名函数 -->
<button @click="handleToggle" />
```

### TypeScript 严格模式

`tsconfig.app.json` 开启了 `noUnusedLocals` 和 `noUnusedParameters`，所有未使用的变量都会报编译错误。允许以 `_` 前缀命名来标记有意忽略的参数。`erasableSyntaxOnly` 要求只使用可擦除的 TypeScript 语法（不能用 `enum`、`namespace` 等运行时代码）。

### 后端 API 兼容

部分后端 API 的参数命名与前端不一致（如 Sessions 筛选使用 `room_url` 而非 `room_id`），页面中需要自行做映射转换。添加新页面时建议先确认后端 API 的实际参数格式。

### 构建产物路径

Vite 构建输出到 `../public/frontend/`，这是后端 `public/` 目录的子路径。Express 将 `public/` 作为静态目录 serve，因此构建后直接可通过 `http://host:port/frontend/assets/...` 访问。开发时不需要手动复制文件。

### Express 5 路由语法

后端使用 Express 5，通配符路由参数从旧版的 `*` 改为 `{*splat}` 语法（基于 `path-to-regexp` v8）。前端不涉及此差异，但在与后端联调时需注意。
