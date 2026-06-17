# 测试用例文档

#### 测试命令

```bash
npm run test           # 运行所有测试
npm run test:watch     # 监听模式（修改文件自动重新运行）
npm run test:coverage  # 生成覆盖率报告（输出到 coverage/ 目录）
npm run test:api       # 运行 API 集成测试（test/api-coverage.test.js）
```

#### 测试文件结构

```
test/
├── huya-downloader.test.js          # 虎牙下载器测试
├── notify-backup.test.js            # 通知备份测试
├── api-coverage.test.js             # API 覆盖率测试
├── redis-service.test.js            # Redis 服务测试
├── response.test.js                 # 响应测试
├── kuaishou-replay-client.test.js   # 快手回放客户端测试
├── m3u8-extractor.test.js           # Playwright m3u8 提取器测试
├── replay-service.test.js           # 回放服务测试
├── replay-upload-service.test.js    # 回放投稿服务测试
├── replay-integration.test.js       # 回放模块集成测试
├── replay-process-queue.test.js     # 回放处理队列测试
├── replay-cleanup.test.js           # 回放清理测试
├── danmaku-burner.test.js           # 弹幕压制测试
├── danmaku-burn-queue.test.js       # 弹幕压制队列测试
├── polling-kuaishou.test.js         # 快手轮询测试
└── ...
```

#### 测试覆盖率要求

- **核心模块**：覆盖率 ≥ 80%
- **工具函数**：覆盖率 ≥ 90%
- **API 端点**：全覆盖（每个端点至少一个成功用例 + 一个失败用例）

#### 测试编写要求

**必须为以下场景编写测试用例**：

1. **工具函数**：`lib/utils/` 下的通用工具函数必须编写单元测试
   - 文件路径生成（`generateOutputPath`、`getSessionDir`、`getRoomDir`）
   - 文件名模板解析（`templateToStrftime`、`generateFilename`）
   - 字符串处理（`sanitizeFilename`）

2. **核心模块**：`lib/core/` 下的独立模块必须编写测试
   - 下载器参数构建（`FFmpegDownloader.buildArgs`）
   - 看门狗扫描逻辑（`scanActiveSegments`、`cleanupFragmentFiles`）
   - 转码队列（`TranscodeQueue` 入队/出队）
   - 回放模块（`KuaishouReplayClient`、`m3u8-extractor`、`ReplayProcessQueue`、`ReplayUploadService`）

3. **API 端点**：所有 `router/` 下的 API 端点必须编写集成测试
   - 使用 `api-coverage.test.js` 结构
   - 测试成功/失败场景
   - 测试参数验证

#### 测试示例结构

```javascript
describe('模块名称', () => {
  describe('功能描述', () => {
    it('应该正确执行某操作', () => {
      // Arrange - 准备测试数据
      const input = 'test_input';

      // Act - 执行被测函数
      const result = module.function(input);

      // Assert - 验证结果
      expect(result).toBe('expected_output');
    });

    it('应该在输入无效时抛出错误', () => {
      // 测试错误处理
      expect(() => module.function(null)).toThrow();
    });
  });
});
```

#### API 测试示例

```javascript
describe('API 端点', () => {
  describe('POST /api/endpoint', () => {
    it('应该返回 200 并正确处理请求', async () => {
      const response = await request(app).post('/api/endpoint').send({ key: 'value' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
    });

    it('应该在参数缺失时返回 400', async () => {
      const response = await request(app).post('/api/endpoint').send({});

      expect(response.status).toBe(400);
    });
  });
});
```
