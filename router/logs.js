const express = require('express');
const fs = require('fs');
const LogFileService = require('../services/LogFileService');

const router = express.Router();
const logFiles = new LogFileService();

function sendLogError(res, err) {
  res.status(err.status || 500).json({ error: err.message || '日志读取失败' });
}

// GET /logs 页面已由 Vue SPA (Logs.vue) 接管，不再使用 EJS 渲染

router.get('/logs/files', async (req, res) => {
  try {
    const files = await logFiles.listFiles();
    res.json({ status: 'ok', data: files });
  } catch (err) {
    res.status(500).json({ status: 'Error', message: '获取文件列表失败' });
  }
});

router.get('/logs/content', async (req, res) => {
  try {
    const result = await logFiles.tailLines(req.query.file, req.query.tail);
    res.json({
      status: 'ok',
      data: {
        file: result.file,
        lines: result.lines,
        truncated: result.truncated,
        offset: result.offset,
      },
    });
  } catch (err) {
    sendLogError(res, err);
  }
});

router.get('/logs/stream', async (req, res) => {
  let offset = 0;
  let buffer = '';
  let timer = null;
  let closed = false;
  let reading = false;

  function writeEvent(event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  async function pushNewContent(fileName) {
    if (closed || reading) return;

    try {
      reading = true;
      const filePath = await logFiles.resolveLogPath(fileName);
      const stat = await fs.promises.stat(filePath);

      if (stat.size < offset) {
        offset = 0;
        buffer = '';
        writeEvent('reset', { reason: 'rotated' });
      }

      if (stat.size <= offset) return;

      const chunk = await logFiles.readRange(fileName, offset, stat.size - 1);
      offset = stat.size;
      buffer += chunk;

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        writeEvent('log', { line });
      }
    } catch (err) {
      writeEvent('log-error', { message: err.message || '日志读取失败' });
    } finally {
      reading = false;
    }
  }

  try {
    const fileName = req.query.file;
    const initial = await logFiles.tailLines(fileName, req.query.tail ?? 100);
    offset = initial.offset;

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    writeEvent('ready', {
      file: initial.file,
      truncated: initial.truncated,
      offset: initial.offset,
    });

    for (const line of initial.lines) {
      writeEvent('log', { line });
    }

    timer = setInterval(() => {
      pushNewContent(fileName);
    }, 1000);

    req.on('close', () => {
      closed = true;
      if (timer) clearInterval(timer);
    });
  } catch (err) {
    sendLogError(res, err);
  }
});

router.delete('/logs', async (req, res) => {
  try {
    const fileName = req.body?.file;
    const filePath = await logFiles.resolveLogPath(fileName);
    await fs.promises.unlink(filePath);
    res.json({ status: 'ok' });
  } catch (err) {
    sendLogError(res, err);
  }
});

module.exports = router;
