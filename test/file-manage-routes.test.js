// 文件管理路由 HTTP 层测试：覆盖 server/router/file-manage.js 的 8 个路由
// Service 层已由 file-manage-service.test.js 覆盖，这里只验证 HTTP 契约：
// 状态码、入参校验、响应包装、operator 透传、路由注册顺序。
jest.mock('../server/services/FileManageService', () => ({
  getFileSummary: jest.fn(),
  getFileList: jest.fn(),
  getFileDetail: jest.fn(),
  generateDeletePlan: jest.fn(),
  executeDelete: jest.fn(),
  getDeleteTaskStatus: jest.fn(),
  executeSingleDelete: jest.fn(),
  scanAllFiles: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const FileManageService = require('../server/services/FileManageService');
const fileManageRouter = require('../server/router/file-manage');

// 注入 req.auth 的中间件开关，用于验证 operator 透传
let authUser = null;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (authUser) {
      req.auth = { username: authUser };
    }
    next();
  });
  app.use('/api', fileManageRouter);
  return app;
}

let app;

beforeEach(() => {
  jest.clearAllMocks();
  authUser = null;
  app = createApp();
  // 静音路由的 console.error，避免失败分支污染测试输出
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

describe('GET /api/files/summary', () => {
  it('返回 200 和 service 的概览数据', async () => {
    FileManageService.getFileSummary.mockResolvedValue({ total_size: 1024, categories: [] });

    const res = await request(app).get('/api/files/summary');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', data: { total_size: 1024, categories: [] } });
  });

  it('service 抛错时返回 500 且不泄漏内部错误信息', async () => {
    FileManageService.getFileSummary.mockRejectedValue(new Error('db connection refused'));

    const res = await request(app).get('/api/files/summary');

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('Error');
    expect(res.body.message).toBe('查询空间概览失败');
    expect(JSON.stringify(res.body)).not.toContain('db connection refused');
  });

  it('summary 路由优先于 /files/:id 匹配，不会被当作 id 解析', async () => {
    FileManageService.getFileSummary.mockResolvedValue({ total_size: 0 });

    await request(app).get('/api/files/summary');

    expect(FileManageService.getFileSummary).toHaveBeenCalledTimes(1);
    expect(FileManageService.getFileDetail).not.toHaveBeenCalled();
  });
});

describe('GET /api/files', () => {
  beforeEach(() => {
    FileManageService.getFileList.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });
  });

  it('返回 200 并透出分页字段', async () => {
    FileManageService.getFileList.mockResolvedValue({
      data: [{ id: 1, file_name: 'a.mp4' }],
      total: 1,
      page: 2,
      limit: 10,
    });

    const res = await request(app).get('/api/files');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      data: [{ id: 1, file_name: 'a.mp4' }],
      total: 1,
      page: 2,
      limit: 10,
    });
  });

  it('只把出现的查询参数放进 filters，未传的键不出现', async () => {
    await request(app).get('/api/files').query({ category: 'recording', status: 'completed' });

    const [filters, pagination] = FileManageService.getFileList.mock.calls[0];
    expect(filters).toEqual({ category: 'recording', status: 'completed' });
    expect(filters).not.toHaveProperty('type');
    expect(filters).not.toHaveProperty('search');
    expect(pagination).toEqual({ page: undefined, limit: undefined, sort: undefined });
  });

  it('透传分页与排序参数', async () => {
    await request(app).get('/api/files').query({ page: '3', limit: '50', sort: 'file_size_desc' });

    const [, pagination] = FileManageService.getFileList.mock.calls[0];
    expect(pagination).toEqual({ page: '3', limit: '50', sort: 'file_size_desc' });
  });

  it.each([
    ['非数字', 'abc'],
    ['负数', '-1'],
  ])('min_size 为%s时返回 400', async (_label, minSize) => {
    const res = await request(app).get('/api/files').query({ min_size: minSize });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('min_size 必须为非负整数');
    expect(FileManageService.getFileList).not.toHaveBeenCalled();
  });

  it('min_size=0 通过校验并进入 filters（字符串 "0" 为真值）', async () => {
    const res = await request(app).get('/api/files').query({ min_size: '0' });

    expect(res.status).toBe(200);
    const [filters] = FileManageService.getFileList.mock.calls[0];
    expect(filters.min_size).toBe('0');
  });

  it.each([
    ['start_date', 'start_date 格式应为 YYYY-MM-DD'],
    ['end_date', 'end_date 格式应为 YYYY-MM-DD'],
  ])('%s 格式非法时返回 400', async (field, message) => {
    const res = await request(app)
      .get('/api/files')
      .query({ [field]: '2026/08/12' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
    expect(FileManageService.getFileList).not.toHaveBeenCalled();
  });

  it('合法日期区间进入 filters', async () => {
    await request(app).get('/api/files').query({ start_date: '2026-08-01', end_date: '2026-08-12' });

    const [filters] = FileManageService.getFileList.mock.calls[0];
    expect(filters).toEqual({ start_date: '2026-08-01', end_date: '2026-08-12' });
  });

  it('service 抛错时返回 500', async () => {
    FileManageService.getFileList.mockRejectedValue(new Error('boom'));

    const res = await request(app).get('/api/files');

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('查询文件列表失败');
  });
});

describe('GET /api/files/:id', () => {
  it('命中时返回 200 和文件详情', async () => {
    FileManageService.getFileDetail.mockResolvedValue({ id: 7, file_name: 'v.mp4' });

    const res = await request(app).get('/api/files/7');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', data: { id: 7, file_name: 'v.mp4' } });
    expect(FileManageService.getFileDetail).toHaveBeenCalledWith(7);
  });

  it('id 非数字时返回 400 且不查库', async () => {
    const res = await request(app).get('/api/files/not-a-number');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('无效的文件 ID');
    expect(FileManageService.getFileDetail).not.toHaveBeenCalled();
  });

  it('文件不存在时返回 404', async () => {
    FileManageService.getFileDetail.mockResolvedValue(null);

    const res = await request(app).get('/api/files/999');

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('文件不存在');
  });

  it('service 抛错时返回 500', async () => {
    FileManageService.getFileDetail.mockRejectedValue(new Error('boom'));

    const res = await request(app).get('/api/files/1');

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('查询文件详情失败');
  });
});

describe('POST /api/files/delete-plan', () => {
  beforeEach(() => {
    FileManageService.generateDeletePlan.mockResolvedValue({ plan_id: 'p1', files: [] });
  });

  it('传 file_ids 时返回 200 并透传 operator', async () => {
    authUser = 'alice';
    app = createApp();

    const res = await request(app)
      .post('/api/files/delete-plan')
      .send({ file_ids: [1, 2, 3] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', data: { plan_id: 'p1', files: [] } });
    expect(FileManageService.generateDeletePlan).toHaveBeenCalledWith(
      { file_ids: [1, 2, 3], filters: undefined },
      'alice'
    );
  });

  it('未登录时 operator 落为 unknown', async () => {
    await request(app)
      .post('/api/files/delete-plan')
      .send({ file_ids: [1] });

    expect(FileManageService.generateDeletePlan).toHaveBeenCalledWith(expect.anything(), 'unknown');
  });

  it('只传 filters 也允许', async () => {
    const res = await request(app)
      .post('/api/files/delete-plan')
      .send({ filters: { category: 'recording' } });

    expect(res.status).toBe(200);
    expect(FileManageService.generateDeletePlan).toHaveBeenCalledWith(
      { file_ids: undefined, filters: { category: 'recording' } },
      'unknown'
    );
  });

  it('file_ids 非数组时返回 400', async () => {
    const res = await request(app).post('/api/files/delete-plan').send({ file_ids: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('file_ids 必须是数组');
    expect(FileManageService.generateDeletePlan).not.toHaveBeenCalled();
  });

  it.each([
    ['含 0', [0]],
    ['含负数', [-1]],
    ['含小数', [1.5]],
    ['含字符串', ['1']],
  ])('file_ids %s 时返回 400', async (_label, fileIds) => {
    const res = await request(app).post('/api/files/delete-plan').send({ file_ids: fileIds });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('file_ids 中包含无效 ID');
    expect(FileManageService.generateDeletePlan).not.toHaveBeenCalled();
  });

  it('既无 file_ids 也无 filters 时返回 400', async () => {
    const res = await request(app).post('/api/files/delete-plan').send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('必须提供 file_ids 或 filters');
  });

  it('空 body 时返回 400（req.body 缺失也不抛异常）', async () => {
    const res = await request(app).post('/api/files/delete-plan');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('必须提供 file_ids 或 filters');
  });

  it('file_ids 为空数组且无 filters 时返回 400', async () => {
    const res = await request(app).post('/api/files/delete-plan').send({ file_ids: [] });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('必须提供 file_ids 或 filters');
  });

  it('file_ids 超过 200 个时返回 400', async () => {
    const fileIds = Array.from({ length: 201 }, (_, i) => i + 1);

    const res = await request(app).post('/api/files/delete-plan').send({ file_ids: fileIds });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('单次最多处理 200 个文件');
    expect(FileManageService.generateDeletePlan).not.toHaveBeenCalled();
  });

  it('file_ids 正好 200 个时放行', async () => {
    const fileIds = Array.from({ length: 200 }, (_, i) => i + 1);

    const res = await request(app).post('/api/files/delete-plan').send({ file_ids: fileIds });

    expect(res.status).toBe(200);
    expect(FileManageService.generateDeletePlan).toHaveBeenCalledTimes(1);
  });

  it('service 抛错时返回 500', async () => {
    FileManageService.generateDeletePlan.mockRejectedValue(new Error('boom'));

    const res = await request(app)
      .post('/api/files/delete-plan')
      .send({ file_ids: [1] });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('生成删除计划失败');
  });
});

describe('POST /api/files/delete', () => {
  beforeEach(() => {
    FileManageService.executeDelete.mockResolvedValue({ task_id: 't1' });
  });

  it('plan_id + confirm=true 时返回 200 和 task_id', async () => {
    authUser = 'bob';
    app = createApp();

    const res = await request(app).post('/api/files/delete').send({ plan_id: 'p1', confirm: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', data: { task_id: 't1' } });
    expect(FileManageService.executeDelete).toHaveBeenCalledWith('p1', 'bob');
  });

  it('缺少 plan_id 时返回 400', async () => {
    const res = await request(app).post('/api/files/delete').send({ confirm: true });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('缺少 plan_id');
    expect(FileManageService.executeDelete).not.toHaveBeenCalled();
  });

  it.each([
    ['缺省', {}],
    ['为 false', { confirm: false }],
    ['为字符串 true', { confirm: 'true' }],
    ['为 1', { confirm: 1 }],
  ])('confirm %s 时返回 400，拒绝执行删除', async (_label, extra) => {
    const res = await request(app)
      .post('/api/files/delete')
      .send({ plan_id: 'p1', ...extra });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('需要 confirm: true 才能执行删除');
    expect(FileManageService.executeDelete).not.toHaveBeenCalled();
  });

  it('计划不存在或已过期时返回 404', async () => {
    FileManageService.executeDelete.mockRejectedValue(new Error('删除计划不存在或已过期'));

    const res = await request(app).post('/api/files/delete').send({ plan_id: 'gone', confirm: true });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('删除计划不存在或已过期');
  });

  it('其他异常返回 500', async () => {
    FileManageService.executeDelete.mockRejectedValue(new Error('boom'));

    const res = await request(app).post('/api/files/delete').send({ plan_id: 'p1', confirm: true });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('执行删除失败');
  });
});

describe('GET /api/files/delete-tasks/:taskId', () => {
  it('返回 200 和任务进度', async () => {
    FileManageService.getDeleteTaskStatus.mockResolvedValue({ task_id: 't1', progress: 50 });

    const res = await request(app).get('/api/files/delete-tasks/t1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', data: { task_id: 't1', progress: 50 } });
    expect(FileManageService.getDeleteTaskStatus).toHaveBeenCalledWith('t1');
  });

  it('任务不存在时返回 404', async () => {
    FileManageService.getDeleteTaskStatus.mockResolvedValue(null);

    const res = await request(app).get('/api/files/delete-tasks/missing');

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('删除任务不存在或已过期');
  });

  it('该路径不会被 GET /files/:id 抢占', async () => {
    FileManageService.getDeleteTaskStatus.mockResolvedValue({ task_id: 't1' });

    await request(app).get('/api/files/delete-tasks/t1');

    expect(FileManageService.getFileDetail).not.toHaveBeenCalled();
  });

  it('service 抛错时返回 500', async () => {
    FileManageService.getDeleteTaskStatus.mockRejectedValue(new Error('boom'));

    const res = await request(app).get('/api/files/delete-tasks/t1');

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('查询删除任务失败');
  });
});

describe('POST /api/files/:id/delete', () => {
  it('返回 200 并把查到的 file 交给 executeSingleDelete', async () => {
    authUser = 'carol';
    app = createApp();
    const file = { id: 5, file_path: '/data/video_downloads/5/a.mp4' };
    FileManageService.getFileDetail.mockResolvedValue(file);
    FileManageService.executeSingleDelete.mockResolvedValue({ deleted: true });

    const res = await request(app).post('/api/files/5/delete');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', data: { deleted: true } });
    expect(FileManageService.getFileDetail).toHaveBeenCalledWith(5);
    expect(FileManageService.executeSingleDelete).toHaveBeenCalledWith(file, 'carol');
  });

  it('id 非数字时返回 400 且不删除', async () => {
    const res = await request(app).post('/api/files/abc/delete');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('无效的文件 ID');
    expect(FileManageService.getFileDetail).not.toHaveBeenCalled();
    expect(FileManageService.executeSingleDelete).not.toHaveBeenCalled();
  });

  it('文件不存在时返回 404 且不删除', async () => {
    FileManageService.getFileDetail.mockResolvedValue(null);

    const res = await request(app).post('/api/files/404/delete');

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('文件不存在');
    expect(FileManageService.executeSingleDelete).not.toHaveBeenCalled();
  });

  it('删除失败时返回 500', async () => {
    FileManageService.getFileDetail.mockResolvedValue({ id: 5 });
    FileManageService.executeSingleDelete.mockRejectedValue(new Error('EACCES'));

    const res = await request(app).post('/api/files/5/delete');

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('单文件删除失败');
  });
});

describe('POST /api/files/scan', () => {
  it('返回 200 和扫描结果', async () => {
    FileManageService.scanAllFiles.mockResolvedValue({ scanned: 12, orphaned: 1 });

    const res = await request(app).post('/api/files/scan');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', data: { scanned: 12, orphaned: 1 } });
  });

  it('service 抛错时返回 500', async () => {
    FileManageService.scanAllFiles.mockRejectedValue(new Error('boom'));

    const res = await request(app).post('/api/files/scan');

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('文件扫描失败');
  });
});
