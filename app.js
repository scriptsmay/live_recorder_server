require('dotenv').config({ quiet: true });
const path = require('path');

const express = require('express');
const cors = require('cors'); // 引入 cors
const morgan = require('morgan'); // 引入morgan日志中间件
const ejsLayouts = require('express-ejs-layouts');

const app = express();
const port = process.env.PORT || 3000;

// 路由
const htmlRouter = require('./router/html');
const apiRouter = require('./router/api');

// 设置模板引擎
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
// 它会自动在 views 目录下寻找一个名为 layout.ejs 的文件作为默认布局模板
app.use(ejsLayouts);

// 开发环境禁用视图缓存
if (process.env.NODE_ENV === 'development') {
  app.set('view cache', false);
  // 或者更彻底的配置
  app.disable('view cache');
}

// 静态文件
app.use(express.static('public'));

// 1. 配置 CORS 中间件
// 允许所有来源（开发环境最方便），或者指定你的扩展权限
app.use(cors());
// 中间件：解析URL编码的查询参数
app.use(express.urlencoded({ extended: true }));
// 中间件：解析JSON请求体
app.use(express.json());

// 新增: 使用morgan记录访问日志
// 参数有 combined short dev
const morganFormat = 'dev';
app.use(morgan(morganFormat)); // 使用 combined 格式记录日志

// 中间件
app.use((req, res, next) => {
  res.locals.path = req.path;
  res.locals.title = 'Live Recorder Server';
  next();
});

// 使用路由
app.use('/', htmlRouter);
app.use('/api', apiRouter);

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
