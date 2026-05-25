# HLS 视频播放功能实现方案

## 概述

本方案旨在优化视频转码功能，增加 HLS 索引，并利用 HLS 实现前端视频播放。由于部署服务器配备 Intel N100 处理器（支持硬件加速），我们将采用**容器转封装**方案，不进行重编码，速度极快且 CPU 占用低。

## 核心设计原则

1. **零重编码**：仅进行容器转换（TS/FLV → HLS），不改变内部音视频编码
2. **按需生成**：首次播放时生成 HLS 索引，避免不必要的计算
3. **分层存储**：HLS 文件与原视频文件分离存放
4. **状态追踪**：记录 HLS 生成状态，避免重复处理
5. **兼容性**：支持 HLS.js（现代浏览器）和 Safari 原生 HLS 播放

---

## 1. 数据库设计变更

### 1.1 新增表字段

#### 1.1.1 `recordings` 表新增字段

```sql
-- 记录 HLS 生成状态
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS is_hls_ready BOOLEAN DEFAULT FALSE;
-- HLS 播放列表文件路径
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS hls_playlist_path VARCHAR(1024) DEFAULT '';
-- HLS 生成时间
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS hls_generated_at TIMESTAMP;
```

#### 1.1.2 `recording_files` 表新增字段

```sql
-- 记录 HLS 生成状态
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS is_hls_ready BOOLEAN DEFAULT FALSE;
-- HLS 播放列表文件路径
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS hls_playlist_path VARCHAR(1024) DEFAULT '';
-- HLS 生成时间
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS hls_generated_at TIMESTAMP;
```

#### 1.1.3 新增默认配置（`settings` 表）

```javascript
['auto_generate_hls', 'true'],        // 自动生成 HLS
['hls_enabled', 'true'],              // HLS 功能启用
['hls_segment_duration', '10'],       // 分段时长（秒）
['hls_cleanup_days', '30'],           // HLS 文件保留天数
```

---

## 2. 目录结构设计

```
VIDEO_DOWNLOAD_DIR/
├── [roomId]/
│   ├── [sessionId]/
│   │   ├── video_001.ts              # 原视频文件
│   │   ├── video_002.ts
│   │   └── hls/                     # HLS 输出目录
│   │       ├── playlist.m3u8        # 主播放列表
│   │       ├── segment_000.ts       # HLS 分段
│   │       ├── segment_001.ts
│   │       └── ...
```

---

## 3. 后端实现

### 3.1 新增模块：`lib/core/hls-generator.js`

**功能**：HLS 索引生成器，使用 FFmpeg 进行容器转封装

```javascript
class HLSGenerator {
  /**
   * 生成 HLS 索引
   * @param {string} inputPath - 输入视频文件路径（TS/FLV）
   * @param {string} outputDir - HLS 输出目录
   * @param {string} sessionId - 会话 ID
   * @returns {Promise<Object>} 生成结果
   */
  async generate(inputPath, outputDir, sessionId)

  /**
   * 检查是否已生成 HLS
   * @param {string} outputDir - HLS 输出目录
   * @returns {boolean}
   */
  isHLSAvailable(outputDir)

  /**
   * 清理过期的 HLS 文件
   */
  async cleanupOldFiles()
}
```

### 3.2 修改 `lib/core/TranscodeQueue.js`

- 在转码完成后，可选地生成 HLS 索引
- 新增 HLS 生成队列，独立于转码队列

### 3.3 修改 `router/api.js`

新增接口：

```javascript
// 获取 HLS 播放列表
router.get('/recordings/:id/hls', ...)

// 获取 HLS 分段文件 (Express 5 RegExp 语法)
router.get(/\/hls\/(.+)/, ...)

// 触发 HLS 生成（异步）
router.post('/recordings/:id/generate-hls', ...)

// 修改 /recordings/:id/stream 接口，优先返回 HLS
```

### 3.4 修改 `services/RecorderService.js`

- 录制完成后，可选地自动触发 HLS 生成

---

## 4. 前端实现

### 4.1 修改 `views/partials/_video_player.ejs`

**新增功能**：

1. 引入 `hls.js` 库
2. 支持 HLS 流播放
3. 检测浏览器兼容性（Safari 原生支持，其他浏览器使用 HLS.js）

### 4.2 修改 `views/sessions.ejs`

- 点击播放按钮时，优先请求 HLS 流
- 如果 HLS 未就绪，提示用户并在后台生成

---

## 5. FFmpeg 命令设计

### 5.1 HLS 生成命令（零重编码）

```bash
ffmpeg -i input.ts \
  -c copy \
  -f hls \
  -hls_time 10 \
  -hls_list_size 0 \
  -hls_segment_filename "segment_%03d.ts" \
  playlist.m3u8
```

**参数说明**：

- `-c copy`：直接复制音视频流，不重新编码
- `-f hls`：输出格式为 HLS
- `-hls_time 10`：每个分段 10 秒
- `-hls_list_size 0`：保留所有分段（不限制播放列表长度）
- `-hls_segment_filename`：分段文件命名模式

### 5.2 硬件加速支持（可选，未来扩展）

```bash
ffmpeg -hwaccel qsv -i input.ts ...
```

---

## 6. 工作流程

### 6.1 HLS 生成流程

```
用户点击播放
    ↓
检查 HLS 是否就绪
    ↓
  ┌─ 是 → 直接播放 HLS
  │
  └─ 否 → 显示加载中，后台触发 HLS 生成
           ↓
        完成后自动更新状态
           ↓
        自动开始播放
```

### 6.2 后台自动生成流程（可选）

```
视频录制/转码完成
    ↓
检查 auto_generate_hls 配置
    ↓
  ┌─ 是 → 后台异步生成 HLS
  │
  └─ 否 → 等待用户首次播放时生成
```

---

## 7. 文件清单（需要修改/新增）

### 新增文件

- `lib/core/hls-generator.js` - HLS 生成器
- `docs/HLS_PLAYBACK_PLAN.md` - 本方案文档

### 修改文件

1. `db/migrate.js` - 数据库迁移
2. `lib/core/TranscodeQueue.js` - 转码队列集成 HLS
3. `router/api.js` - 新增 HLS 相关 API
4. `services/RecorderService.js` - 录制完成后触发 HLS 生成
5. `views/partials/_video_player.ejs` - 前端播放器升级
6. `views/sessions.ejs` - 播放按钮逻辑优化
7. `views/settings.ejs` - 添加 HLS 配置项

---

## 8. 测试计划

1. **单元测试**：测试 HLSGenerator 类
2. **集成测试**：测试完整的 HLS 生成和播放流程
3. **兼容性测试**：Chrome/Firefox/Safari/Edge
4. **性能测试**：大文件生成速度和资源占用

---

## 9. 后续优化方向

1. **硬件加速**：利用 N100 的 QSV 进行重编码（如需压缩）
2. **CDN 支持**：将 HLS 文件推送到 CDN
3. **多码率支持**：生成不同清晰度的 HLS 流
4. **HLS 加密**：支持 DRM 保护

---

## 10. 风险评估

| 风险             | 影响 | 概率 | 缓解措施                            |
| ---------------- | ---- | ---- | ----------------------------------- |
| FFmpeg 命令失败  | 高   | 低   | 完善错误处理和日志记录              |
| 磁盘空间占用增加 | 中   | 高   | 设置过期清理策略                    |
| 首次播放延迟     | 中   | 中   | 后台预生成或显示加载提示            |
| 浏览器兼容性     | 低   | 低   | 使用 HLS.js + Safari 原生支持双方案 |

---

## 总结

本方案采用容器转封装技术，在几乎零 CPU 占用的情况下实现流畅的 HLS 视频播放，特别适合 Intel N100 这样的低功耗服务器。
