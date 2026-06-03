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
 * 2. 对于没有匹配的前端路由，回退到 index.html（支持 Vue Router history 模式）
 *
 * 迁移策略：
 * - 已迁移到 Vue 的页面会从 SPA 路由处理
 * - 未迁移的页面继续使用原有 EJS 路由
 * - 随着页面逐步迁移，将 EJS 路由从 router/html.js 移到这里
 */

// 检查 SPA 构建产物是否存在
const spaExists = fs.existsSync(INDEX_HTML);

if (spaExists) {
  // 前端静态资源（JS/CSS/图片等）
  router.use('/frontend', express.static(SPA_DIR));

  // Vue Router history 模式回退
  // 仅拦截非 API、非现有页面路由的请求
  // Express 5 使用 {*splat} 语法替代旧版 * 通配符
  router.get('/{*splat}', (req, res, next) => {
    // 跳过 API 路由
    if (req.path.startsWith('/api/')) return next();
    // 跳过 HLS 流
    if (req.path.startsWith('/hls/')) return next();
    // 跳过日志 SSE 流
    if (req.path.startsWith('/api/logs/stream')) return next();
    // 跳过静态资源（有扩展名的请求）
    if (path.extname(req.path)) return next();

    // 已迁移到 Vue 的路由列表 —— 全部页面已迁移
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

    // 未匹配的路由继续走 EJS
    next();
  });
}

module.exports = router;
