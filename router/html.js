const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const DataService = require('../services/DataService');
const { getActiveDownloader } = require('../lib/core/downloaders/DownloaderFactory');

// const md = require('../lib/utils/markdown');

router.get('/', (req, res) => {
  res.redirect('/dashboard');
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
      recentSessions: sessions.rows || sessions,
      recentUploads: uploadRecords.rows || uploadRecords,
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

router.get('/sessions', async (req, res) => {
  try {
    const roomFilter = req.query.room_url || '';
    const page = parseInt(req.query.page, 10) || 1;
    const limit = 50;

    const [sessionsResult, uploadResult, rooms, templates] = await Promise.all([
      DataService.getSessions({ room_url: roomFilter, page, limit }),
      DataService.getUploadRecords({ limit: 200 }),
      DataService.getRoomList(),
      DataService.getTemplates(),
    ]);

    const uploadMap = {};
    for (const u of uploadResult.rows) {
      if (!uploadMap[u.session_id]) uploadMap[u.session_id] = [];
      uploadMap[u.session_id].push(u);
    }

    const totalPages = Math.ceil(sessionsResult.total / limit);

    const downloader = getActiveDownloader().name;
    res.render('sessions', {
      title: '录制会话',
      sessions: sessionsResult.rows,
      downloader,
      uploadMap,
      rooms,
      templates,
      currentRoomUrl: roomFilter,
      pagination: { page, limit, total: sessionsResult.total, totalPages },
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
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
    });
  }
});

router.get('/rooms', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = 50;

    const [{ rows: rooms, total }, templates, { map: settingsMap }] = await Promise.all([
      DataService.getRooms({ page, limit }),
      DataService.getTemplates(),
      DataService.getSettings(),
    ]);
    const downloader = settingsMap.downloader || getActiveDownloader().name;
    const totalPages = Math.ceil(total / limit);
    res.render('rooms', {
      title: '直播间管理',
      rooms,
      templates,
      downloader,
      pagination: { page, limit, total, totalPages },
    });
  } catch (err) {
    console.error('[html] 直播间页加载失败:', err);
    res.status(500).render('rooms', {
      title: '直播间管理',
      rooms: [],
      templates: [],
      downloader: 'FFmpegDownloader',
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
    });
  }
});

router.get('/transcode', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = 50;

    const result = await DataService.getTranscodeRecords({ page, limit });
    const totalPages = Math.ceil(result.total / limit);
    res.render('transcode', {
      title: '转码记录',
      records: result.rows,
      pagination: { page, limit, total: result.total, totalPages },
    });
  } catch (err) {
    console.error('[html] 转码记录页加载失败:', err);
    res.status(500).render('transcode', {
      title: '转码记录',
      records: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
    });
  }
});

router.get('/recordings', async (req, res) => {
  try {
    const roomFilter = req.query.room_url || '';
    const page = parseInt(req.query.page, 10) || 1;
    const limit = 50;

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
  let content = fs.readFileSync(mdPath, 'utf-8');
  // try {
  //   const raw = fs.readFileSync(mdPath, 'utf-8');
  //   // content = md.render(raw);
  //   content = raw;
  // } catch (_) {
  //   content = '<div class="alert alert-danger">无法加载 API.md 文档</div>';
  // }
  res.render('apiview', { title: 'API 文档', content });
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
    const page = parseInt(req.query.page, 10) || 1;
    const limit = 50;

    const result = await DataService.getUploadRecords({ page, limit });
    const totalPages = Math.ceil(result.total / limit);
    res.render('upload_records', {
      title: '投稿记录',
      records: result.rows,
      pagination: { page, limit, total: result.total, totalPages },
    });
  } catch (err) {
    console.error('[html] 投稿记录页加载失败:', err);
    res.status(500).render('upload_records', {
      title: '投稿记录',
      records: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
    });
  }
});

module.exports = router;
