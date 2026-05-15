const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const pool = require('../db/index');

// 日志目录
const logsDir = path.join(__dirname, '../logs');
const { LOG_ERR_HTML } = require('../config/template');
const md = require('../lib/markdown');

// 当访问根路径时，重定向
router.get('/', (req, res) => {
  res.redirect('/rooms');
});

router.get('/rooms', (req, res) => {
  res.render('rooms', { title: '直播间管理' });
});

router.get('/sessions', async (req, res) => {
  try {
    const roomFilter = req.query.room_url || '';
    const whereClause = roomFilter ? 'WHERE s.deleted_at IS NULL AND s.room_url = $1' : 'WHERE s.deleted_at IS NULL';
    const params = roomFilter ? [roomFilter] : [];
    const [sessResult, uploadResult, roomsResult, tmplResult] = await Promise.all([
      pool.query(
        `
        SELECT s.*, rm.room_name
        FROM recording_sessions s
        LEFT JOIN rooms rm ON s.room_url = rm.room_url
        ${whereClause}
        ORDER BY s.id DESC
        LIMIT 50
      `,
        params
      ),
      pool.query('SELECT * FROM upload_records ORDER BY id DESC LIMIT 200'),
      pool.query('SELECT room_url, room_name FROM rooms ORDER BY id DESC'),
      pool.query('SELECT * FROM upload_templates ORDER BY id DESC'),
    ]);

    const uploadMap = {};
    for (const u of uploadResult.rows) {
      if (!uploadMap[u.session_id]) uploadMap[u.session_id] = [];
      uploadMap[u.session_id].push(u);
    }

    res.render('sessions', {
      title: '录制会话',
      sessions: sessResult.rows,
      uploadMap,
      rooms: roomsResult.rows,
      templates: tmplResult.rows,
    });
  } catch (err) {
    console.error('[html] 会话页加载失败:', err);
    res.status(500).render('sessions', { title: '录制会话', sessions: [], uploadMap: {}, rooms: [], templates: [] });
  }
});

router.get('/templates', (req, res) => {
  res.render('templates', { title: '投稿模板' });
});

router.get('/upload_records', (req, res) => {
  res.render('upload_records', { title: '投稿记录' });
});

router.get('/recordings', (req, res) => {
  res.render('recordings', { title: '录制历史' });
});

router.get('/_/rooms/table', async (req, res) => {
  const result = await pool.query('SELECT * FROM rooms ORDER BY id DESC');
  res.render('partials/_rooms_table', { rooms: result.rows, layout: false });
});

router.get('/files', (req, res) => {
  res.render('files', { title: '文件管理' });
});

router.get('/settings', (req, res) => {
  res.render('settings', { title: '全局设置' });
});

router.get('/apiview', (req, res) => {
  const mdPath = path.join(__dirname, '..', 'docs', 'API.md');
  let content = '';
  try {
    const raw = fs.readFileSync(mdPath, 'utf-8');
    content = md.render(raw);
  } catch (_) {
    content = '<div class="alert alert-danger">无法加载 API.md 文档</div>';
  }
  res.render('apiview', {
    title: 'API 文档',
    apiContent: content,
  });
});

// 路由：查看 logs 目录下的 .log 文件
router.get('/logs', async (req, res) => {
  try {
    // 如果没有 logsDir 这个目录，则创建它
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir);
    }
    // 获取目录中的文件列表
    const files = fs.readdirSync(logsDir);
    const logFiles = files.filter((file) => file.endsWith('.log'));

    // 获取查询参数 ?file=xxx.log
    const requestedFile = req.query.file;
    let selectedFileContent = '';
    let selectedFileName = '';

    if (requestedFile && logFiles.includes(requestedFile)) {
      const filePath = path.join(logsDir, requestedFile);
      selectedFileContent = fs.readFileSync(filePath, 'utf-8');
      selectedFileName = requestedFile;
    }

    // 返回 HTML 页面展示日志文件列表和内容
    res.render('logs', {
      logFiles,
      selectedFileName,
      selectedFileContent,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send(LOG_ERR_HTML);
  }
});

// 路由：删除指定名称的日志文件
router.get('/logs/delete', async (req, res) => {
  try {
    // 获取目录中的文件列表
    const files = fs.readdirSync(logsDir);
    const logFiles = files.filter((file) => file.endsWith('.log'));

    // 获取查询参数 ?file=xxx.log
    const requestedFile = req.query.file;

    if (!requestedFile || !logFiles.includes(requestedFile)) {
      return res.status(400).send(LOG_ERR_HTML);
    }

    const filePath = path.join(logsDir, requestedFile);

    // 删除日志文件
    fs.unlink(filePath, (err) => {
      if (err) {
        console.error(`无法删除文件: ${err.message}`);
        return res.status(500).send(LOG_ERR_HTML);
      }
      console.log(`文件 ${requestedFile} 已成功删除`);
      res.redirect('/logs'); // 删除完成后重定向回日志页面
    });
  } catch (err) {
    console.error(err);
    res.status(500).send(LOG_ERR_HTML);
  }
});

module.exports = router;
