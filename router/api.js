const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const express = require('express');
const axios = require('axios');
const router = express.Router();
// 导入配置文件
const config = require('../config/config');
const dayjs = require('dayjs');

// 1. 定义一个绝对路径（不要放在项目代码文件夹内）
const DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR; // 或者你的 NAS 挂载路径

// 新增: GET /api 路由，返回欢迎信息
router.get('/', (req, res) => {
  res.status(200).json({
    message: '欢迎使用API服务。',
    status: 'ok',
    data: {
      apiList: [
        {
          name: '自动启动直播录制接口',
          description:
            `直播录制接口，请提供直播流URL和标题。录制文件将保存在目录：[${DOWNLOAD_DIR}]。` +
            `这个接口需要配合浏览器插件使用，仓库：https://github.com/scriptsmay/live_listener`,
          url: config.SITE_URL + 'api/notify/live_download',
          method: 'POST',
          params: [
            {
              name: 'url',
              description: '直播流URL',
              required: true,
            },
            {
              name: 'title',
              description: '直播标题',
              required: true,
            },
          ],
        },
      ],
    },
  });
});

const activeTasks = new Set(); // 存储当前正在录制的 URL
// 后端：按直播间标题锁定
const recordingTitles = new Set();

/**
 * POST /api/notify/live_download 直播录制接口
 * @param {*} req body { url: '直播流URL', title: '直播标题' }
 * @param {*} res 返回结果
 */
router.post('/notify/live_download', async (req, res) => {
  if (!req.body || !req.body.url || !req.body.title) {
    return res.status(400).json({
      status: 'Error',
      message: '请提供直播流URL和标题。',
    });
  }
  // 确保文件夹存在
  if (!DOWNLOAD_DIR) {
    return res.status(500).json({
      status: 'Error',
      message: '请设置 DOWNLOAD_DIR 环境变量，并确保该目录已存在。',
    });
  }
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }

  const { url, title } = req.body;

  // 如果该 URL 已经在录制中，直接返回成功，不重复开启 ffmpeg
  if (activeTasks.has(url)) {
    console.log(`[拦截] URL 已在录制列表中，跳过重复请求`);
    return res
      .status(400)
      .json({ status: 'Already recording', message: '请勿重复开启' });
  }
  // 提取核心标题（去掉时间戳，只保留 "AUTO_KSG无言..."）
  const roomKey = title.split('_').slice(0, 2).join('_');
  if (recordingTitles.has(roomKey)) {
    console.log(`[拒绝] 直播间 ${roomKey} 已经在录制中，不再开启新进程`);
    return res.status(400).json({
      status: 'Already recording',
      message: `[拒绝] 直播间 ${roomKey} 已经在录制中，不再开启新进程`,
    });
  }
  recordingTitles.add(roomKey);
  activeTasks.add(url);

  const timestamp = dayjs().format('YYYY-MM-DD_HH-mm-ss');
  const safeTitle = title.replace(/[^a-z0-9-_ ]/gi, '');
  // 2. 使用 path.join 生成绝对路径
  const outputFilePath = path.join(
    DOWNLOAD_DIR,
    `${timestamp}_${safeTitle}.mp4`
  );

  console.log(`[任务启动] 视频将保存至: ${outputFilePath}`);

  const ffmpeg = spawn('ffmpeg', [
    '-i',
    url,
    '-c',
    'copy',
    '-fflags',
    '+genpts',
    outputFilePath, // 使用绝对路径
  ]);

  // 防止 ffmpeg 启动失败导致 Node 崩溃
  ffmpeg.on('error', (err) => {
    console.error('FFmpeg 启动失败:', err);
  });

  ffmpeg.on('close', (code) => {
    activeTasks.delete(url); // 录制结束后，从记录中移除，允许下次再次录制
    console.log(`[${code}]录制结束，已释放 URL 锁定。路径: ${outputFilePath}`);
    // 此时调用后续脚本，传入 outputFilePath
  });

  res.status(200).json({ status: 'Recording started', path: outputFilePath });
});

module.exports = router;
