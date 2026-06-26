jest.mock('axios');
jest.mock('../server/db/index', () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

describe('notification and backup fallbacks', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('sends Gotify notifications when Gotify config is present', async () => {
    process.env.NODE_ENV = 'production';
    process.env.MESSAGE_GOTIFY_SERVER = 'https://gotify.example.com/';
    process.env.MESSAGE_GOTIFY_TOKEN = 'token-123';
    process.env.MESSAGE_GOTIFY_PRIORITY = '7';

    const axios = require('axios');
    axios.post.mockResolvedValue({ status: 200 });
    const notify = require('../server/lib/core/notify');

    await notify.send('test_event', '标题', '内容');

    expect(axios.post).toHaveBeenCalledWith(
      'https://gotify.example.com/message',
      {
        title: '标题',
        message: '内容',
        priority: 7,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Gotify-Key': 'token-123',
        },
        timeout: 5000,
      }
    );
  });

  test('sends webhook notification when webhook is enabled in DB', async () => {
    process.env.NODE_ENV = 'production';
    const db = require('../server/db/index');
    db.query.mockResolvedValue({
      rows: [
        { key: 'webhook_enabled', value: 'true' },
        { key: 'webhook_url', value: 'https://hooks.example.com/notify' },
      ],
    });

    const axios = require('axios');
    axios.post.mockResolvedValue({ status: 200 });
    const notify = require('../server/lib/core/notify');

    await notify.send('test_event', '标题', '内容');

    expect(axios.post).toHaveBeenCalledWith(
      'https://hooks.example.com/notify',
      expect.objectContaining({
        event: 'test_event',
        title: '标题',
        content: '内容',
        source: 'k-recorder',
      }),
      expect.any(Object)
    );
  });

  test('replayPipelineComplete uses user-facing replay completion copy', async () => {
    process.env.NODE_ENV = 'production';
    process.env.MESSAGE_FEISHU_WEBHOOK = 'https://feishu.example.com/webhook';

    const db = require('../server/db/index');
    db.query.mockResolvedValue({ rows: [] });

    const axios = require('axios');
    axios.post.mockResolvedValue({ status: 200 });
    const notify = require('../server/lib/core/notify');

    await notify.replayPipelineComplete('主播A', 'download', 12, {
      status: 'downloaded',
      raw_file_path: '/tmp/replay/a.mp4',
    });

    expect(axios.post).toHaveBeenCalledWith(
      'https://feishu.example.com/webhook',
      {
        msg_type: 'text',
        content: {
          text: expect.stringContaining('✅ 直播回放处理完成'),
        },
      },
      expect.any(Object)
    );
    expect(axios.post.mock.calls[0][1].content.text).toContain('主播：主播A');
    expect(axios.post.mock.calls[0][1].content.text).toContain('步骤：download');
  });

  test('skips backup_and_delete without deleting files when NAS config is absent', async () => {
    process.env.NAS_HOST = '';
    process.env.NAS_USER = '';
    process.env.NAS_BACKUP_DIR = '';

    const { afterUpload } = require('../server/lib/core/backup');

    const result = await afterUpload(
      'backup_and_delete',
      ['/tmp/live-recorder-test.mp4'],
      1,
      '模板',
      2,
      '直播间',
      'https://live.example.com/room'
    );

    expect(result).toEqual({
      action: 'backup_and_delete',
      status: 'skipped',
      reason: 'NAS 配置未设置，跳过备份',
    });
  });
});
