const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const DataService = require('../services/DataService');

// 日志目录
const logsDir = path.join(__dirname, '../logs');
const { LOG_ERR_HTML } = require('../config/template');
const md = require('../lib/utils/markdown');

// 当访问根路径时，重定向
router.get('/', (req, res) => {
  res.redirect('/dashboard');
});

router.get('/dashboard', (req, res) => {
  res.render('dashboard', { title: '仪表盘' });
});

router.get('/rooms', async (req, res) => {
  try {
    const [{ rows: rooms }, templates, { map: settingsMap }] = await Promise.all([
      DataService.getRooms(),
      DataService.getTemplates(),
      DataService.getSettings(),
    ]);
    const downloader = settingsMap.downloader || 'ffmpeg';
    res.render('rooms', {
      title: '直播间管理',
      rooms,
      templates,
      downloader,
    });
  } catch (err) {
    console.error('[html] 直播间页加载失败:', err);
    res.status(500).render('rooms', {
      title: '直播间管理',
      rooms: [],
      templates: [],
      downloader: 'ffmpeg',
    });
  }
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
    const [records, templates] = await Promise.all([
      DataService.getUploadRecords({ limit: 100 }),
      DataService.getTemplates(),
    ]);

    res.render('upload_records', {
      title: '投稿记录',
      records,
      templates,
    });
  } catch (err) {
    console.error('[html] 投稿记录页加载失败:', err);
    res.status(500).render('upload_records', { title: '投稿记录', records: [], templates: [] });
  }
});

router.get('/transcode', async (req, res) => {
  try {
    const records = await DataService.getTranscodeRecords({ limit: 100 });
    res.render('transcode', {
      title: '转码记录',
      records,
    });
  } catch (err) {
    console.error('[html] 转码记录页加载失败:', err);
    res.status(500).render('transcode', { title: '转码记录', records: [] });
  }
});

router.get('/recordings', async (req, res) => {
  try {
    const roomFilter = req.query.room_url || '';

    const [recordings, rooms] = await Promise.all([
      DataService.getRecordings({
        room_url: roomFilter,
      }),
      DataService.getRoomList(),
    ]);
    res.render('recordings', {
      title: '录制历史',
      recordings,
      rooms,
      roomFilter,
    });
  } catch (err) {
    console.error('[html] 录制历史页加载失败:', err);
    res.status(500).render('recordings', { title: '录制历史', recordings: [], rooms: [], roomFilter: '' });
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
