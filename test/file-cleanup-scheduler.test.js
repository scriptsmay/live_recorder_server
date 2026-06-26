jest.mock('../server/services/FileManageService', () => ({
  scanAllFiles: jest.fn(),
  getFileSummary: jest.fn(),
  generateDeletePlan: jest.fn(),
  executeDelete: jest.fn(),
  getDeleteTaskStatus: jest.fn(),
}));
jest.mock('../server/services/DataService', () => ({
  getSetting: jest.fn(),
}));
jest.mock('../server/lib/core/notify', () => ({
  send: jest.fn(),
}));

const FileManageService = require('../server/services/FileManageService');
const DataService = require('../server/services/DataService');
const { send } = require('../server/lib/core/notify');
const { runCleanupCheck, checkDiskWatermark } = require('../server/lib/core/FileCleanupScheduler');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runCleanupCheck', () => {
  test('无可清理文件时跳过建议通知', async () => {
    FileManageService.scanAllFiles.mockResolvedValue({ scanned: 10, created: 0, updated: 10, missing: 0 });
    DataService.getSetting.mockResolvedValue('false');
    FileManageService.getFileSummary.mockResolvedValue({
      total_size: 1000,
      safe_to_delete_size: 0,
      groups: [],
    });
    // checkDiskWatermark 内部 execSync 可能失败，mock 为 ok
    const childProcess = require('child_process');
    const origExecSync = childProcess.execSync;
    childProcess.execSync = jest.fn().mockReturnValue('/dev/sda1  100G  50G  50G  50% /data\n');

    await runCleanupCheck();

    // scanAllFiles 被调用
    expect(FileManageService.scanAllFiles).toHaveBeenCalled();
    // safe_to_delete_size=0 时不应发送建议通知
    expect(send).not.toHaveBeenCalledWith('文件管理 - 清理建议', expect.any(String));

    childProcess.execSync = origExecSync;
  });

  test('有可清理文件时发送建议通知', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production'; // sendCleanupSuggestion 在 test 环境下跳过通知

    FileManageService.scanAllFiles.mockResolvedValue({ scanned: 10, created: 0, updated: 10, missing: 0 });
    DataService.getSetting
      .mockResolvedValueOnce('80') // watermark_warn
      .mockResolvedValueOnce('90') // watermark_critical
      .mockResolvedValueOnce('false') // file_cleanup_enabled
      .mockResolvedValueOnce('true'); // file_cleanup_suggestion_notify
    FileManageService.getFileSummary.mockResolvedValue({
      total_size: 10000,
      safe_to_delete_size: 5000,
      groups: [{ type: 'recording', size: 5000, file_count: 5, root: '/data/video_downloads' }],
    });

    const childProcess = require('child_process');
    const origExecSync = childProcess.execSync;
    childProcess.execSync = jest.fn().mockReturnValue('/dev/sda1  100G  50G  50G  50% /data\n');

    await runCleanupCheck();

    expect(send).toHaveBeenCalledWith('file_cleanup_suggestion', '文件管理 - 清理建议', expect.stringContaining('总占用:'));
    expect(send).toHaveBeenCalledWith('file_cleanup_suggestion', '文件管理 - 清理建议', expect.stringContaining('可清理:'));

    childProcess.execSync = origExecSync;
    process.env.NODE_ENV = origNodeEnv;
  });

  test('自动清理启用时执行删除', async () => {
    FileManageService.scanAllFiles.mockResolvedValue({ scanned: 10, created: 0, updated: 10, missing: 0 });
    DataService.getSetting
      .mockResolvedValueOnce('80') // watermark_warn
      .mockResolvedValueOnce('90') // watermark_critical
      .mockResolvedValueOnce('true') // file_cleanup_enabled
      .mockResolvedValueOnce('30') // file_cleanup_retention_days
      .mockResolvedValueOnce(''); // file_cleanup_categories
    FileManageService.getFileSummary.mockResolvedValue({
      total_size: 10000,
      safe_to_delete_size: 5000,
      groups: [],
    });
    FileManageService.generateDeletePlan.mockResolvedValue({
      plan_id: 'test-plan-id',
      deletable_count: 5,
      blocked_count: 0,
      total_size: 5000,
      deletable: [],
      blocked: [],
    });
    FileManageService.executeDelete.mockResolvedValue({ task_id: 'test-task-id', status: 'processing' });
    FileManageService.getDeleteTaskStatus.mockResolvedValue({
      task_id: 'test-task-id',
      status: 'completed',
      deleted_count: 5,
      blocked_count: 0,
      failed_count: 0,
      actual_release_size: 5000,
    });

    const childProcess = require('child_process');
    const origExecSync = childProcess.execSync;
    childProcess.execSync = jest.fn().mockReturnValue('/dev/sda1  100G  50G  50G  50% /data\n');

    await runCleanupCheck();

    expect(FileManageService.generateDeletePlan).toHaveBeenCalledWith(
      { filters: { safe_to_delete: true, older_than_days: 30 } },
      'auto-scheduler'
    );
    expect(FileManageService.executeDelete).toHaveBeenCalledWith('test-plan-id', 'auto-scheduler');
    expect(send).toHaveBeenCalledWith('file_cleanup', '文件管理 - 自动清理', expect.stringContaining('删除 5 个文件'));

    childProcess.execSync = origExecSync;
  });

  test('水位超阈值时发送告警', async () => {
    FileManageService.scanAllFiles.mockResolvedValue({ scanned: 0, created: 0, updated: 0, missing: 0 });
    DataService.getSetting
      .mockResolvedValueOnce('80') // watermark_warn
      .mockResolvedValueOnce('90') // watermark_critical
      .mockResolvedValueOnce('false'); // file_cleanup_enabled
    FileManageService.getFileSummary.mockResolvedValue({
      total_size: 0,
      safe_to_delete_size: 0,
      groups: [],
    });

    const childProcess = require('child_process');
    const origExecSync = childProcess.execSync;
    // 模拟 95% 使用率
    childProcess.execSync = jest.fn().mockReturnValue('/dev/sda1  100G  95G  5G  95% /data\n');

    await runCleanupCheck();

    expect(send).toHaveBeenCalledWith('disk_watermark', '磁盘空间告警', expect.stringContaining('紧急'));

    childProcess.execSync = origExecSync;
  });
});

describe('checkDiskWatermark', () => {
  test('正常水位返回 ok', async () => {
    DataService.getSetting.mockResolvedValueOnce('80').mockResolvedValueOnce('90');

    const childProcess = require('child_process');
    const origExecSync = childProcess.execSync;
    childProcess.execSync = jest.fn().mockReturnValue('/dev/sda1  100G  50G  50G  50% /data\n');

    const result = await checkDiskWatermark();
    expect(result.level).toBe('ok');
    expect(result.percent).toBe(50);

    childProcess.execSync = origExecSync;
  });

  test('超警告阈值返回 warn', async () => {
    DataService.getSetting.mockResolvedValueOnce('80').mockResolvedValueOnce('90');

    const childProcess = require('child_process');
    const origExecSync = childProcess.execSync;
    childProcess.execSync = jest.fn().mockReturnValue('/dev/sda1  100G  85G  15G  85% /data\n');

    const result = await checkDiskWatermark();
    expect(result.level).toBe('warn');
    expect(result.percent).toBe(85);

    childProcess.execSync = origExecSync;
  });

  test('df 命令失败返回 null', async () => {
    const childProcess = require('child_process');
    const origExecSync = childProcess.execSync;
    childProcess.execSync = jest.fn().mockImplementation(() => {
      throw new Error('command failed');
    });

    const result = await checkDiskWatermark();
    expect(result).toBeNull();

    childProcess.execSync = origExecSync;
  });
});
