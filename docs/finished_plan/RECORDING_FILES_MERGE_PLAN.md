# recordings 和 recording_files 表合并方案

## 现状分析

### 两个表的字段对比

| 字段              | recordings | recording_files | 说明                                |
| ----------------- | ---------- | --------------- | ----------------------------------- |
| id                | ✅         | ✅              | 主键                                |
| session_id        | ✅         | ✅              | 关联会话                            |
| room_url          | ✅         | ✅              | 关联直播间                          |
| file_path         | ✅         | ✅              | 文件路径（两个表都有唯一约束）      |
| file_size         | ✅         | ✅              | 文件大小                            |
| status            | ✅         | ✅              | 状态                                |
| started_at        | ✅         | ✅              | 开始时间                            |
| ended_at          | ✅         | ❌              | 结束时间（只有 recordings 有）      |
| segment_index     | ✅         | ❌              | 分片索引（只有 recordings 有）      |
| duration_seconds  | ✅         | ❌              | 时长（只有 recordings 有）          |
| file_name         | ❌         | ✅              | 文件名（只有 recording_files 有）   |
| checked_at        | ❌         | ✅              | 检查时间（只有 recording_files 有） |
| is_hls_ready      | ✅         | ✅              | HLS 就绪状态                        |
| hls_playlist_path | ✅         | ✅              | HLS 播放列表路径                    |
| hls_generated_at  | ✅         | ✅              | HLS 生成时间                        |

### 实际使用场景分析

| 功能模块         | 使用 recordings | 使用 recording_files |
| ---------------- | --------------- | -------------------- |
| /recordings 页面 | ✅ 主要数据源   | ❌                   |
| HLS 生成         | ✅ 优先查询     | ✅ 备选              |
| 文件流播放       | ✅ 优先查询     | ✅ 备选              |
| 孤文件管理       | ❌              | ✅                   |
| 会话详情         | ❌              | ✅                   |
| 文件关联操作     | ✅ 同时更新     | ✅ 同时更新          |
| 转码功能         | ✅ 备选         | ✅ 主要数据源        |
| 上传功能         | ✅ 优先查询     | ✅ 备选              |
| 看门狗分片追踪   | ✅ 同时写入     | ✅ 同时写入          |
| 文件扫描         | ✅ 同时写入     | ✅ 同时写入          |

### 核心问题

1. **数据冗余严重**：90% 以上的字段重复
2. **维护成本高**：每次更新需要同步两个表
3. **逻辑复杂**：API 需要多次查询并回退
4. **状态同步容易出错**：两个表的 HLS 状态需要同时重置

---

## 合并方案

### 决策：保留 `recording_files` 表

保留 `recording_files` 表的原因：

- 它有 `orphaned` 状态管理，这是核心功能
- 有 `file_name` 和 `checked_at` 字段，更适合文件生命周期管理
- 是会话详情的主要数据源
- 更完整的文件追踪功能

### 合并后的表结构

```sql
CREATE TABLE recording_files (
    id SERIAL PRIMARY KEY,
    session_id INTEGER REFERENCES recording_sessions(id) ON DELETE SET NULL,
    room_url VARCHAR(512) REFERENCES rooms(room_url) ON DELETE SET NULL,
    file_path VARCHAR(1024) NOT NULL UNIQUE,
    file_name VARCHAR(512) DEFAULT '',
    file_size BIGINT DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending',  -- pending/recording/completed/interrupted/orphaned/missing/deleted
    started_at TIMESTAMP DEFAULT NOW(),
    ended_at TIMESTAMP,  -- 新增字段，来自 recordings
    segment_index INTEGER DEFAULT 0,  -- 新增字段，来自 recordings
    duration_seconds INTEGER DEFAULT 0,  -- 新增字段，来自 recordings
    checked_at TIMESTAMP DEFAULT NOW(),
    is_hls_ready BOOLEAN DEFAULT FALSE,
    hls_playlist_path VARCHAR(1024) DEFAULT '',
    hls_generated_at TIMESTAMP
);
```

### 迁移步骤

#### 阶段 1：数据库迁移（零风险）

1. 在 `db/migrate.js` 中添加字段到 `recording_files` 表：
   - `ended_at`
   - `segment_index`
   - `duration_seconds`

2. 执行迁移脚本，添加新字段

#### 阶段 2：数据同步（可选但推荐）

1. 将 `recordings` 表中存在但 `recording_files` 表缺少的数据同步过去
2. 确保数据完整性

#### 阶段 3：代码重构 - 逐步替换查询

##### 3.1 更新 DataService.js

- 修改 `getRecordings` 方法，改为查询 `recording_files` 表
- 保持相同的返回格式，确保兼容性

##### 3.2 更新 API 路由

- `/recordings/:id/stream` - 直接查询 `recording_files`
- `/recordings/:id/hls` - 直接查询 `recording_files`
- `/recordings/:id/generate-hls` - 直接查询 `recording_files`
- `/recording_files/:id/associate` - 移除 `recordings` 表的双写
- `/recordings/:id` - 删除操作改为删除 `recording_files`

##### 3.3 更新 HLS 生成器

- `hls-generator.js` - 移除双表查询逻辑
- 只操作 `recording_files` 表

##### 3.4 更新看门狗

- `watchdog.js` - 移除 `recordings` 表的双写逻辑
- 只操作 `recording_files` 表
- 更新 `checkSessionHLS` 方法

##### 3.5 更新文件扫描

- `scan-files.js` - 移除 `recordings` 表的双写逻辑

##### 3.6 更新上传服务

- `UploadService.js` - 移除 `recordings` 表的查询
- 直接查询 `recording_files`

##### 3.7 更新页面

- `recordings.ejs` - 不需要修改（通过 API 层抽象）

#### 阶段 4：最终清理（可选）

1. 删除 `recordings` 表
2. 清理相关的数据库迁移代码

---

## 详细实施步骤

### 步骤 1：数据库迁移

在 `db/migrate.js` 中添加：

```javascript
// 添加 recordings 表缺少的字段到 recording_files 表
await client.query(`
  ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP
`);
await client.query(`
  ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS segment_index INTEGER DEFAULT 0
`);
await client.query(`
  ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS duration_seconds INTEGER DEFAULT 0
`);
```

### 步骤 2：创建数据迁移脚本

创建 `scripts/migrate-recordings.js`：

```javascript
const pool = require('../db');

async function migrateData() {
  console.log('开始迁移 recordings 数据到 recording_files 表...');

  // 获取 recordings 表的所有数据
  const { rows: recordings } = await pool.query('SELECT * FROM recordings');

  let migratedCount = 0;
  for (const rec of recordings) {
    // 检查 recording_files 表是否已经有该文件
    const { rows: existing } = await pool.query('SELECT id FROM recording_files WHERE file_path = $1', [rec.file_path]);

    if (existing.length === 0) {
      // 如果不存在，插入
      await pool.query(
        `
        INSERT INTO recording_files (
          session_id, room_url, file_path, file_name, file_size, status,
          started_at, ended_at, segment_index, duration_seconds,
          is_hls_ready, hls_playlist_path, hls_generated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `,
        [
          rec.session_id,
          rec.room_url,
          rec.file_path,
          path.basename(rec.file_path),
          rec.file_size,
          rec.status,
          rec.started_at,
          rec.ended_at,
          rec.segment_index,
          rec.duration_seconds,
          rec.is_hls_ready,
          rec.hls_playlist_path,
          rec.hls_generated_at,
        ]
      );
      migratedCount++;
    } else {
      // 如果存在，更新缺少的字段
      await pool.query(
        `
        UPDATE recording_files
        SET ended_at = $1, segment_index = $2, duration_seconds = $3
        WHERE file_path = $4
      `,
        [rec.ended_at, rec.segment_index, rec.duration_seconds, rec.file_path]
      );
    }
  }

  console.log(`迁移完成，共处理 ${recordings.length} 条记录，新增 ${migratedCount} 条`);
  await pool.end();
}

migrateData().catch(console.error);
```

### 步骤 3：更新 DataService.getRecordings (已删除此方法)

修改 `services/DataService.js` 中的 `getRecordings` 方法

### 步骤 4：更新 API 路由

修改 `router/api.js` 中的相关端点：

1. `/recordings/:id/stream`
2. `/recordings/:id/hls`
3. `/recordings/:id/generate-hls`
4. `/recording_files/:id/associate` - 移除 recordings 表操作
5. `/recordings/:id` DELETE

### 步骤 5：更新 HLS 生成器

修改 `lib/core/hls-generator.js`：

- 移除 `recordingType` 参数
- 始终操作 `recording_files` 表

### 步骤 6：更新看门狗

修改 `lib/core/watchdog.js`：

- `scanActiveSegments` - 移除 recordings 表双写
- `checkSessionHLS` - 只查询 recording_files 表

### 步骤 7：更新文件扫描

修改 `lib/core/scan-files.js`：

- 移除 recordings 表的插入逻辑

### 步骤 8：更新上传服务

修改 `services/UploadService.js`：

- `executeUpload` - 只查询 recording_files 表
- `isSessionTranscodeComplete` - 只查询 recording_files 表

---

## 风险评估与回滚方案

### 风险点

1. **数据同步期间的写入冲突**
   - 缓解：在业务低峰期执行数据同步
   - 回滚：保留 recordings 表数据，随时可以回退

2. **API 兼容性问题**
   - 缓解：保持 API 接口不变，只修改内部实现
   - 回滚：回退代码版本

3. **功能缺失**
   - 缓解：逐步替换，每个阶段测试验证
   - 回滚：保留 recordings 表作为备用

### 回滚步骤

如果出现问题，可以快速回滚：

1. 回退代码到迁移前版本
2. recordings 表数据仍然存在，功能可以立即恢复
3. 后续再清理 recording_files 表中新增的字段（可选）

---

## 验证清单

迁移完成后需要验证以下功能：

- [ ] /recordings 页面正常显示
- [ ] HLS 视频播放功能正常
- [ ] 文件流播放功能正常
- [ ] 孤文件管理功能正常
- [ ] 会话详情页面正常
- [ ] 文件关联操作正常
- [ ] 转码功能正常
- [ ] 上传功能正常
- [ ] 看门狗分片追踪正常
- [ ] 文件扫描功能正常
- [ ] 新增的 HLS 自动生成正常

---

## 后续优化建议

1. 表名优化：考虑将 `recording_files` 重命名为更简洁的 `recordings`（在完全迁移后）
2. 索引优化：根据查询模式添加适当的索引
3. 清理冗余代码：移除所有双表操作的代码
