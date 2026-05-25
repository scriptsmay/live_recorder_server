const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const DataService = require('../services/DataService');

const md = require('../lib/utils/markdown');

router.get('/', (req, res) => {
  res.redirect('/sessions');
});

router.get('/sessions', async (req, res) => {
  try {
    const roomFilter = req.query.room_url || '';
    const [sessions, uploadRecords, rooms, templates] = await Promise.all([
      DataService.getSessions({ room_url: roomFilter }),
      DataService.getUploadRecords({ limit: 200 }),
      DataService.getRoomList(),
      DataService.getTemplates(),
    ]);

    const uploadMap = {};
    for (const u of uploadRecords) {
      if (!uploadMap[u.session_id]) uploadMap[u.session_id] = [];
      uploadMap[u.session_id].push(u);
    }

    res.render('sessions', {
      title: '录制会话',
      sessions,
      uploadMap,
      rooms,
      templates,
      currentRoomUrl: roomFilter,
    });
  } catch (err) {
    console.error('[html] 会话页加载失败:', err);
    res.status(500).render('sessions', {
      title: '录制会话',
      sessions: [],
      uploadMap: {},
      rooms: [],
      templates: [],
      currentRoomUrl: '',
    });
  }
});

router.get('/rooms', async (req, res) => {
  try {
    const { rows: rooms } = await DataService.getRooms();
    res.render('rooms', { title: '直播间管理', rooms });
  } catch (err) {
    console.error('[html] 直播间页加载失败:', err);
    res.status(500).render('rooms', { title: '直播间管理', rooms: [] });
  }
});

router.get('/dashboard', async (req, res) => {
  try {
    const [rooms, sessions, uploadRecords] = await Promise.all([
      DataService.getRoomList(),
      DataService.getSessions({ limit: 10 }),
      DataService.getUploadRecords({ limit: 20 }),
    ]);

    res.render('dashboard', {
      title: '仪表盘',
      rooms,
      recentSessions: sessions,
      recentUploads: uploadRecords,
    });
  } catch (err) {
    console.error('[html] 仪表盘加载失败:', err);
    res.status(500).render('dashboard', {
      title: '仪表盘',
      rooms: [],
      recentSessions: [],
      recentUploads: [],
    });
  }
});

router.get('/transcode', async (req, res) => {
  try {
    const records = await DataService.getTranscodeRecords({ limit: 200 });
    res.render('transcode', { title: '转码记录', records });
  } catch (err) {
    console.error('[html] 转码记录页加载失败:', err);
    res.status(500).render('transcode', { title: '转码记录', records: [] });
  }
});

router.get('/recordings', async (req, res) => {
  try {
    const roomFilter = req.query.room_url || '';
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;

    const [result, rooms] = await Promise.all([
      DataService.getRecordings({
        room_url: roomFilter,
        page,
        limit,
      }),
      DataService.getRoomList(),
    ]);

    const totalPages = Math.ceil(result.total / limit);
    res.render('recordings', {
      title: '录制历史',
      recordings: result.rows,
      rooms,
      roomFilter,
      pagination: {
        page,
        limit,
        total: result.total,
        totalPages,
      },
    });
  } catch (err) {
    console.error('[html] 录制历史页加载失败:', err);
    res.status(500).render('recordings', {
      title: '录制历史',
      recordings: [],
      rooms: [],
      roomFilter: '',
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
    });
  }
});

router.get('/_/rooms/table', async (req, res) => {
  const { rows: rooms } = await DataService.getRooms();
  res.render('partials/_rooms_table', { rooms, layout: false });
});

router.get('/files', (req, res) => {
  res.render('files', { title: '文件管理' });
});

router.get('/settings', async (req, res) => {
  try {
    const { rows: settings } = await DataService.getSettings();
    res.render('settings', { title: '全局设置', settings });
  } catch (err) {
    console.error('[html] 设置页加载失败:', err);
    res.status(500).render('settings', { title: '全局设置', settings: [] });
  }
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
  res.render('apiview', { title: 'API 文档', content });
});

router.get('/logs', async (req, res) => {
  const logsDir = path.join(__dirname, '..', 'logs');
  let files = [];
  try {
    files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log')).sort().reverse();
  } catch (_) {}
  const logFile = req.query.file;
  let logContent = '';
  if (logFile && files.includes(logFile)) {
    try {
      logContent = fs.readFileSync(path.join(logsDir, logFile), 'utf-8');
      const maxLines = 2000;
      const lines = logContent.split('\n');
      if (lines.length > maxLines) {
        logContent = lines.slice(-maxLines).join('\n');
      }
    } catch (_) {}
  }
  if (req.xhr || req.headers.accept?.includes('json')) {
    res.json({ files, logFile, logContent });
  } else {
    res.render('logs', { title: '日志查看', files, logFile, logContent });
  }
});

router.delete('/logs', (req, res) => {
  const logsDir = path.join(__dirname, '..', 'logs');
  let { file } = req.body || {};
  if (!file) return res.status(400).json({ error: '缺少 file 参数' });
  const safeFile = path.basename(file);
  const fullPath = path.join(logsDir, safeFile);
  if (!fullPath.startsWith(logsDir)) return res.status(403).json({ error: '路径非法' });
  try {
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      res.json({ status: 'ok' });
    } else {
      res.status(404).json({ error: '文件不存在' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/templates', async (req, res) => {
  try {
    const templates = await DataService.getTemplates();
    res.render('templates', { title: '投稿模板', templates });
  } catch (err) {
    console.error('[html] 模板页加载失败:', err);
    res.status(500).render('templates', { title: '投稿模板', templates: [] });
  }
});

router.get('/upload_records', async (req, res) => {
  try {
    const records = await DataService.getUploadRecords({ limit: 200 });
    res.render('upload_records', { title: '投稿记录', records });
  } catch (err) {
    console.error('[html] 投稿记录页加载失败:', err);
    res.status(500).render('upload_records', { title: '投稿记录', records: [] });
  }
});

module.exports = router;
