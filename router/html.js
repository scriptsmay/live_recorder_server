const express = require('express');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');

const router = express.Router();

// 日志目录
const logsDir = path.join(__dirname, '../logs');
const { LOG_ERR_HTML } = require('../config/template');
const config = require('../config/config');

// 当访问根路径时，重定向
router.get('/', (req, res) => {
  res.redirect('/rooms');
});

router.get('/rooms', (req, res) => {
  res.render('rooms', { title: '直播间管理' });
});

router.get('/sessions', (req, res) => {
  res.render('sessions', { title: '录制会话' });
});

router.get('/recordings', (req, res) => {
  res.render('recordings', { title: '录制历史' });
});

router.get('/apiview', (req, res) => {
  res.render('apiview', {
    siteUrl: config.SITE_URL,
    now: dayjs().format('YYYY-MM-DD HH:mm:ss'),
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
