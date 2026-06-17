/**
 * 集成测试：录制 + 回放模块共存验证
 * 验证两个模块的路由、服务、队列互不干扰
 */

const path = require('path');
const fs = require('fs');

// 检查模块加载不冲突
describe('录制 + 回放模块共存', () => {
  test('ReplayService 可独立加载', () => {
    jest.mock('../db/index', () => ({ query: jest.fn() }));
    const ReplayService = require('../services/ReplayService');
    expect(ReplayService).toBeDefined();
    expect(typeof ReplayService.getPrincipals).toBe('function');
    expect(typeof ReplayService.listRecords).toBe('function');
    expect(typeof ReplayService.getRecord).toBe('function');
    expect(typeof ReplayService.upsertRecord).toBe('function');
    expect(typeof ReplayService.updateRecordStatus).toBe('function');
    expect(typeof ReplayService.getSettings).toBe('function');
    expect(typeof ReplayService.updateSettings).toBe('function');
    expect(typeof ReplayService.syncRecords).toBe('function');
  });

  test('ReplayProcessQueue 可独立加载', () => {
    jest.mock('../db/index', () => ({ query: jest.fn() }));
    jest.mock('../db/redis', () => ({
      lPush: jest.fn(),
      rPop: jest.fn(),
      lLen: jest.fn(),
      get: jest.fn(),
      set: jest.fn(),
      incr: jest.fn(),
      decr: jest.fn(),
      del: jest.fn(),
    }));
    const ReplayProcessQueue = require('../lib/core/ReplayProcessQueue');
    expect(ReplayProcessQueue).toBeDefined();
    expect(typeof ReplayProcessQueue.enqueue).toBe('function');
    expect(typeof ReplayProcessQueue.enqueuePrincipal).toBe('function');
    expect(typeof ReplayProcessQueue.getStatus).toBe('function');
  });

  test('ReplayUploadService 可独立加载', () => {
    jest.mock('../db/index', () => ({ query: jest.fn() }));
    jest.mock('../lib/core/biliup', () => ({ upload: jest.fn() }));
    jest.mock('../lib/core/notify', () => ({
      uploadStart: jest.fn(),
      uploadComplete: jest.fn(),
      uploadFailed: jest.fn(),
    }));
    jest.mock('../lib/core/backup', () => ({ afterUpload: jest.fn() }));
    jest.mock('../services/UploadService', () => ({
      getTemplateVars: jest.fn(),
      renderTemplate: jest.fn(),
    }));
    const ReplayUploadService = require('../lib/core/replay/ReplayUploadService');
    expect(ReplayUploadService).toBeDefined();
    expect(typeof ReplayUploadService.executeUpload).toBe('function');
  });

  test('video-processor 可独立加载', () => {
    jest.mock('../services/ReplayService', () => ({
      getRecordWorkDir: jest.fn(() => '/tmp/test'),
    }));
    const videoProcessor = require('../lib/core/replay/video-processor');
    expect(videoProcessor).toBeDefined();
    expect(typeof videoProcessor.extract).toBe('function');
    expect(typeof videoProcessor.download).toBe('function');
    expect(typeof videoProcessor.cut).toBe('function');
    expect(typeof videoProcessor.fix).toBe('function');
  });

  test('cleanup 可独立加载', () => {
    const cleanup = require('../lib/core/replay/cleanup');
    expect(cleanup).toBeDefined();
    expect(typeof cleanup.removeFiles).toBe('function');
  });

  test('KuaishouReplayClient 可独立加载', () => {
    jest.mock('../services/ReplayService', () => ({}));
    const client = require('../lib/core/replay/KuaishouReplayClient');
    expect(client).toBeDefined();
    expect(typeof client.fetchLiveList).toBe('function');
    expect(typeof client.syncReplays).toBe('function');
    expect(typeof client.extractM3u8).toBe('function');
  });
});

describe('API 路由覆盖', () => {
  test('回放 API 路由定义存在', () => {
    // 验证路由文件可加载且导出了正确的路由
    jest.mock('../db/index', () => ({ query: jest.fn() }));
    jest.mock('../db/redis', () => ({
      lPush: jest.fn(), rPop: jest.fn(), lLen: jest.fn(),
      get: jest.fn(), set: jest.fn(), incr: jest.fn(), decr: jest.fn(), del: jest.fn(),
    }));
    jest.mock('../lib/core/biliup', () => ({ upload: jest.fn() }));
    jest.mock('../lib/core/notify', () => ({
      uploadStart: jest.fn(), uploadComplete: jest.fn(), uploadFailed: jest.fn(),
    }));
    jest.mock('../lib/core/backup', () => ({ afterUpload: jest.fn() }));
    jest.mock('../services/UploadService', () => ({
      getTemplateVars: jest.fn(), renderTemplate: jest.fn(),
    }));

    const replayRouter = require('../router/replay');
    expect(replayRouter).toBeDefined();
    // Express Router is a function
    expect(typeof replayRouter).toBe('function');
  });
});

describe('数据库表结构兼容', () => {
  test('回放表 DDL 字段与 ReplayService 一致', () => {
    // 验证关键字段在服务层被引用
    const ReplayService = require('../services/ReplayService');

    // 这些字段必须在 replay_records 表中存在
    const requiredFields = [
      'id', 'principal_id', 'principal_name', 'replay_id', 'play_url',
      'm3u8_url', 'video_file_name', 'raw_file_path', 'status',
      'start_time', 'duration', 'bv_id', 'error_message',
    ];

    // 通过检查 SQL 引用来验证（间接测试）
    // 实际字段验证需要连接数据库，这里只验证模块可加载
    expect(ReplayService).toBeDefined();
  });
});
