const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Vue SPA 前端构建产物目录
const SPA_DIR = path.join(__dirname, '..', 'public', 'frontend');
const INDEX_HTML = path.join(SPA_DIR, 'index.html');

/**
 * Vue SPA 静态资源 + 路由回退
 *
 * 当 Vue 前端构建完成后（npm run build 输出到 public/frontend/），
 * 此路由会：
 * 1. 将 /frontend/* 映射到 public/frontend/ 下的静态文件
 * 2. 旧路径重定向（兼容 EJS 时代的 URL）
 * 3. 对于已迁移的 Vue 路由，回退到 index.html（支持 history 模式）
 */

// 检查 SPA 构建产物是否存在
const spaExists = fs.existsSync(INDEX_HTML);

if (spaExists) {
  // 前端静态资源（JS/CSS/图片等）
  router.use('/frontend', express.static(SPA_DIR));

  // EJS 旧路径 → Vue 新路径重定向
  router.get('/upload_records', (req, res) => {
    res.redirect(301, '/upload-records');
  });

  // Vue Router history 模式回退
  // 仅拦截非 API、非现有页面路由的请求
  // Express 5 使用 {*splat} 语法替代旧版 * 通配符
  router.get('/{*splat}', (req, res, next) => {
    // 跳过 API 路由
    if (req.path.startsWith('/api/')) return next();
    // 跳过 HLS 流
    if (req.path.startsWith('/hls/')) return next();
    // 跳过静态资源（有扩展名的请求）
    if (path.extname(req.path)) return next();

    // 已迁移到 Vue 的路由列表
    const spaRoutes = [
      '/dashboard',
      '/rooms',
      '/sessions',
      '/recordings',
      '/transcode',
      '/danmaku-toolbox',
      '/templates',
      '/upload-records',
      '/settings',
      '/logs',
    ];

    // 动态路由模式匹配
    const spaDynamicPatterns = [
      /^\/sessions\/\d+\/danmaku$/,
    ];

    if (spaRoutes.includes(req.path) || spaDynamicPatterns.some((p) => p.test(req.path))) {
      return res.sendFile(INDEX_HTML);
    }

    // 未匹配的路由返回 404
    next();
  });
}

module.exports = router;
