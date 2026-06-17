'use strict';

jest.mock('fs/promises', () => ({
  unlink: jest.fn(),
}));

const { removeFiles } = require('../lib/core/replay/cleanup');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('cleanup.removeFiles', () => {
  test('删除单个文件成功', async () => {
    const fsPromises = require('fs/promises');
    fsPromises.unlink.mockResolvedValue(undefined);

    const result = await removeFiles('/tmp/test.mp4');

    expect(fsPromises.unlink).toHaveBeenCalledWith('/tmp/test.mp4');
    expect(result.deleted).toBe(1);
    expect(result.failed).toBe(0);
  });

  test('删除多个文件', async () => {
    const fsPromises = require('fs/promises');
    fsPromises.unlink.mockResolvedValue(undefined);

    const result = await removeFiles(['/tmp/a.mp4', '/tmp/b.mp4']);

    expect(fsPromises.unlink).toHaveBeenCalledTimes(2);
    expect(result.deleted).toBe(2);
    expect(result.failed).toBe(0);
  });

  test('文件不存在时静默忽略', async () => {
    const fsPromises = require('fs/promises');
    const enoent = new Error('ENOENT');
    enoent.code = 'ENOENT';
    fsPromises.unlink.mockRejectedValue(enoent);

    const result = await removeFiles('/tmp/missing.mp4');

    expect(result.deleted).toBe(0);
    expect(result.failed).toBe(0);
  });

  test('其他错误时计入 failed', async () => {
    const fsPromises = require('fs/promises');
    fsPromises.unlink.mockRejectedValue(new Error('EACCES'));

    const result = await removeFiles('/tmp/locked.mp4');

    expect(result.deleted).toBe(0);
    expect(result.failed).toBe(1);
  });

  test('空数组不执行删除', async () => {
    const fsPromises = require('fs/promises');

    const result = await removeFiles([]);

    expect(fsPromises.unlink).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    expect(result.failed).toBe(0);
  });
});
