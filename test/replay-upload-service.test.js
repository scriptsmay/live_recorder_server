const fs = require('fs');

// Mock all dependencies before requiring the module under test
jest.mock('../server/db/index', () => ({ query: jest.fn() }));
jest.mock('../server/lib/core/biliup', () => ({ upload: jest.fn() }));
jest.mock('../server/lib/core/notify', () => ({
  uploadStart: jest.fn(),
  uploadComplete: jest.fn(),
  uploadFailed: jest.fn(),
}));
jest.mock('../server/lib/core/backup', () => ({ afterUpload: jest.fn() }));
jest.mock('../server/services/UploadService', () => ({
  getTemplateVars: jest.fn((room) => ({ room_name: room.room_name, streamer_name: room.room_name })),
  renderTemplate: jest.fn((tpl, vars = {}) =>
    tpl.replace(/\{room_name\}/g, vars.room_name || '').replace(/\{principal_name\}/g, vars.principal_name || '')
  ),
}));

const pool = require('../server/db/index');
const biliup = require('../server/lib/core/biliup');
const notify = require('../server/lib/core/notify');
const { afterUpload } = require('../server/lib/core/backup');
const UploadService = require('../server/services/UploadService');
const ReplayUploadService = require('../server/lib/core/replay/ReplayUploadService');

beforeEach(() => {
  jest.clearAllMocks();
  UploadService.renderTemplate.mockImplementation((tpl, vars = {}) =>
    tpl.replace(/\{room_name\}/g, vars.room_name || '').replace(/\{principal_name\}/g, vars.principal_name || '')
  );
  // Default: statSync returns valid for any path
  jest.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true, size: 1024 * 1024 });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ReplayUploadService', () => {
  test('executeUpload 记录不存在时返回错误', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const result = await ReplayUploadService.executeUpload(999);
    expect(result.error).toBe(true);
    expect(result.message).toContain('不存在');
  });

  test('executeUpload 未配置模板时返回错误', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, principal_id: 'abc', play_url: 'http://test' }] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await ReplayUploadService.executeUpload(1);
    expect(result.error).toBe(true);
    expect(result.message).toContain('未配置');
  });

  test('executeUpload 模板不存在时返回错误', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, principal_id: 'abc', play_url: 'http://test' }] })
      .mockResolvedValueOnce({ rows: [{ value: '99' }] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await ReplayUploadService.executeUpload(1);
    expect(result.error).toBe(true);
    expect(result.message).toContain('不存在');
  });

  test('executeUpload 无文件时返回错误', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 1, principal_id: 'abc', play_url: 'http://test', principal_name: '主播', final_file_paths: '[]' }],
      })
      .mockResolvedValueOnce({ rows: [{ value: '1' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 1, name: '模板A', title_template: '{principal_name}', cookies_path: '/tmp/c' }],
      });

    fs.statSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = await ReplayUploadService.executeUpload(1);
    expect(result.error).toBe(true);
    expect(result.message).toContain('无可投稿文件');
  });

  test('executeUpload 成功时创建投稿记录并触发异步上传', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            principal_id: 'abc',
            principal_name: '主播',
            config_principal_name: '配置主播',
            room_name: '直播间主播',
            play_url: 'http://test',
            final_file_paths: '["/tmp/a.mp4"]',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ value: '1' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 1, name: '模板A', title_template: '{principal_name}', cookies_path: '/tmp/c' }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 10 }] });

    jest.spyOn(ReplayUploadService, '_runUpload').mockResolvedValue(undefined);

    const result = await ReplayUploadService.executeUpload(1);
    expect(result.error).toBe(false);
    expect(result.upload_record_id).toBe(10);
    expect(notify.uploadStart).toHaveBeenCalledWith('配置主播', '模板A', 1, 'http://test');
  });

  test('getUploadPreview 返回渲染后的投稿预览并截断简介', async () => {
    const longDesc = 'a'.repeat(120);
    UploadService.renderTemplate.mockImplementation((tpl) => {
      if (tpl === 'desc') return longDesc;
      return tpl;
    });
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            principal_id: 'abc',
            principal_name: '主播',
            config_principal_name: '',
            room_name: '直播间主播',
            play_url: 'http://test',
            start_time: '2026-06-16T20:00:00+08:00',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ value: '1' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            name: '模板A',
            title_template: 'title',
            desc_template: 'desc',
            tags: 'tag1,tag2',
          },
        ],
      });

    const result = await ReplayUploadService.getUploadPreview(1);

    expect(result.error).toBe(false);
    expect(result.preview.title).toBe('title');
    expect(result.preview.tags).toBe('tag1,tag2');
    expect(result.preview.desc).toHaveLength(103);
    expect(result.preview.desc_full).toHaveLength(120);
    expect(result.preview.template_name).toBe('模板A');
  });

  test('回放投稿变量优先配置名，否则回退 room_name 以复用直播模板', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            principal_id: 'abc',
            principal_name: '记录主播',
            config_principal_name: '',
            room_name: '直播间主播',
            play_url: 'http://test',
            start_time: '2026-06-16T20:00:00+08:00',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ value: '1' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            name: '模板A',
            title_template: '{room_name}-{principal_name}',
            desc_template: '',
            tags: '',
          },
        ],
      });

    const result = await ReplayUploadService.getUploadPreview(1);

    expect(result.preview.title).toBe('直播间主播-直播间主播');
    expect(UploadService.getTemplateVars).toHaveBeenCalledWith(
      { room_name: '直播间主播', room_url: 'http://test' },
      expect.any(Object)
    );
  });

  test('_runUpload 成功时更新状态为 success 并回填 bv_id', async () => {
    biliup.upload.mockResolvedValue({ success: true, output: 'done', bvId: 'BV123' });
    afterUpload.mockResolvedValue(null);
    pool.query.mockResolvedValue({ rows: [] });

    await ReplayUploadService._runUpload(
      10,
      { id: 1, principal_name: '主播', play_url: 'http://test' },
      { id: 1, name: '模板', cookies_path: '/tmp/c', after_upload: 'none' },
      ['/tmp/a.mp4'],
      '标题',
      '描述',
      'tag1',
      'http://source'
    );

    const successCall = pool.query.mock.calls.find((c) => c[0].includes("status='success'"));
    expect(successCall).toBeTruthy();
    expect(successCall[1]).toContain('BV123');
    expect(notify.uploadComplete).toHaveBeenCalled();
  });

  test('_runUpload 失败时更新状态为 failed', async () => {
    biliup.upload.mockResolvedValue({ success: false, output: 'err', error: '上传超时' });
    pool.query.mockResolvedValue({ rows: [] });

    await ReplayUploadService._runUpload(
      10,
      { id: 1, principal_name: '主播', play_url: 'http://test' },
      { id: 1, name: '模板', cookies_path: '/tmp/c' },
      ['/tmp/a.mp4'],
      '标题',
      '描述',
      'tag1',
      ''
    );

    const failedCall = pool.query.mock.calls.find((c) => c[0].includes("status='failed'"));
    expect(failedCall).toBeTruthy();
    expect(notify.uploadFailed).toHaveBeenCalled();
  });

  test('_runUpload 异常时更新状态为 failed', async () => {
    biliup.upload.mockRejectedValue(new Error('进程崩溃'));
    pool.query.mockResolvedValue({ rows: [] });

    await ReplayUploadService._runUpload(
      10,
      { id: 1, principal_name: '主播', play_url: 'http://test' },
      { id: 1, name: '模板', cookies_path: '/tmp/c' },
      ['/tmp/a.mp4'],
      '标题',
      '',
      '',
      ''
    );

    const failedCall = pool.query.mock.calls.find((c) => c[0].includes("status='failed'"));
    expect(failedCall).toBeTruthy();
    expect(failedCall[1]).toContain('进程崩溃');
  });

  test('模板渲染调用 UploadService', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            principal_id: 'abc',
            principal_name: '主播',
            play_url: 'http://test',
            final_file_paths: '["/tmp/a.mp4"]',
            start_time: '2026-06-16T20:00:00+08:00',
            duration: 7200,
            replay_id: 'r1',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ value: '1' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 1, name: '模板', title_template: '{principal_name}', cookies_path: '/tmp/c' }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 20 }] });

    jest.spyOn(ReplayUploadService, '_runUpload').mockResolvedValue(undefined);

    await ReplayUploadService.executeUpload(1);

    expect(UploadService.getTemplateVars).toHaveBeenCalled();
    expect(UploadService.renderTemplate).toHaveBeenCalled();
  });
});
