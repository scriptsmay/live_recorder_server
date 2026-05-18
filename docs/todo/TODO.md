# TODO: EJS 后端渲染改造 + 公共数据服务提取

> **状态：已完成**（2026-05-18）

## 目标

1. 将 templates.ejs、rooms.ejs、settings.ejs 改为后端 EJS 渲染
2. 提取公共数据服务，消除 html.js 和 API 路由的重复 pool.query
3. dashboard.ejs 和 files.ejs 保留前端 fetch（轮询/交互需求）

## Task 1: 新建 `services/DataService.js` — 公共数据查询服务 ✅

提取以下重复查询为独立方法：

```js
// services/DataService.js
class DataService {
  static async getTemplates()           // SELECT * FROM upload_templates ORDER BY id
  static async getRooms(options)        // rooms 列表，支持 status 筛选/分页
  static async getRoomById(id)          // 单个 room 详情
  static async getSettings()            // SELECT * FROM settings，返回 { rows, map }
  static async getSetting(key)          // 单个 setting 值
  static async getSessions(options)     // sessions 列表，支持 room_url 筛选
  static async getUploadRecords(options) // upload_records 列表
  static async getRecordings(options)   // recordings 列表
}
```

**文件**: 新建 `services/DataService.js`

## Task 2: API 路由调用 DataService 替代直接 pool.query ✅

涉及文件:

- `router/upload.js` — `GET /api/upload_templates` 改用 `DataService.getTemplates()`
- `router/rooms.js` — `GET /api/rooms`、`GET /api/rooms/:id`、`GET /api/sessions` 改用 DataService
- `router/settings.js` — `GET /api/settings` 改用 DataService
- `router/api.js` — `GET /api/recording_files`、`GET /api/notify/status`、`GET /api/dashboard/status` 等改用 DataService

**注意**: 写操作（POST/PUT/DELETE）保留在路由中不变，只改读操作。

## Task 3: templates.ejs 改为后端渲染 ✅

- `router/html.js` 的 `GET /templates` 改为 async，查 `DataService.getTemplates()` 传给 EJS
- `views/templates.ejs` 删除 `fetch('/api/upload_templates')` 和 JS 动态渲染，改用 EJS 循环 `<% templates.forEach(t => { %>`
- 前端 JS 只保留：编辑弹窗填充数据、保存/删除/复制/刷新Cookie 的操作逻辑

## Task 4: rooms.ejs 改为后端渲染 ✅

- `router/html.js` 的 `GET /rooms` 改为 async，查 `DataService.getRooms()` + `DataService.getTemplates()` + downloader 信息
- `views/rooms.ejs` 删除 `loadRooms()`、`loadDownloaderInfo()`、`loadTemplateSelect()` 三个 fetch 调用，改用 EJS 渲染
- 前端 JS 只保留：编辑弹窗、操作按钮（暂停/恢复/停止/删除）

## Task 5: settings.ejs 改为后端渲染 ✅

- `router/html.js` 的 `GET /settings` 改为 async，查 `DataService.getSettings()`
- `views/settings.ejs` 删除 `loadSettings()` fetch 调用，EJS 直接渲染表单
- 前端 JS 只保留：`saveSettings()` 保存逻辑

## Task 6: html.js 现有后端渲染页面改用 DataService ✅

- `GET /sessions` — 改用 DataService
- `GET /upload_records` — 改用 DataService
- `GET /recordings` — 改用 DataService
- `GET /_/rooms/table` — 改用 DataService

## Task 7: Lint + 逻辑验证 ✅

对所有修改文件执行 `npx eslint` 确保无错误。

执行 tests 中的 api 测试用例，保证 api 接口没有缺失。

## Task 8: 项目文档更新 ✅

检查本次代码更新是否涉及到项目文档更新，保证 agents.md 和 docs/ 下的文档都是最新版本。

## 文件变更总结

| 文件                      | 操作                                                    |
| ------------------------- | ------------------------------------------------------- |
| `services/DataService.js` | 新建                                                    |
| `router/html.js`          | 重构（templates/rooms/settings 改 async + DataService） |
| `router/upload.js`        | 重构 GET 路由用 DataService                             |
| `router/rooms.js`         | 重构 GET 路由用 DataService                             |
| `router/settings.js`      | 重构 GET 路由用 DataService                             |
| `router/api.js`           | 重构部分 GET 路由用 DataService                         |
| `views/templates.ejs`     | 重构为后端渲染                                          |
| `views/rooms.ejs`         | 重构为后端渲染                                          |
| `views/settings.ejs`      | 重构为后端渲染                                          |
