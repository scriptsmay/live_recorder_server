const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const logsRouter = require('../router/logs');

describe('logs API routes', () => {
  const logsDir = path.join(process.cwd(), 'logs');
  const fileName = 'jest_logs_contract.log';
  const filePath = path.join(logsDir, fileName);
  let server;
  let baseUrl;

  beforeAll(async () => {
    await fs.promises.mkdir(logsDir, { recursive: true });
    await fs.promises.writeFile(filePath, 'one\ntwo\nthree\n');

    const app = express();
    app.use(express.json());
    app.use(logsRouter);

    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(filePath, { force: true });
  });

  test('GET /api/logs/content returns standard ApiResponse data payload', async () => {
    const res = await fetch(`${baseUrl}/api/logs/content?file=${fileName}&tail=2`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      status: 'ok',
      data: expect.objectContaining({
        file: fileName,
        lines: ['two', 'three'],
        truncated: true,
        offset: expect.any(Number),
      }),
    });
  });
});
