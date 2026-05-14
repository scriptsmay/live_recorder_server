require('dotenv').config({ quiet: true });
const path = require('path');

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const ejsLayouts = require('express-ejs-layouts');

const app = express();
const port = process.env.PORT || 3000;

// 路由
const htmlRouter = require('./router/html');
const apiRouter = require('./router/api');
const roomsRouter = require('./router/rooms');

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(ejsLayouts);

if (process.env.NODE_ENV === 'development') {
  app.set('view cache', false);
  app.disable('view cache');
}

app.use(express.static('public'));

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const morganFormat = 'dev';
app.use(morgan(morganFormat));

app.use((req, res, next) => {
  res.locals.path = req.path;
  res.locals.title = 'Live Recorder Server';
  next();
});

app.use('/', htmlRouter);
app.use('/api', apiRouter);
app.use('/api', roomsRouter);

const migrate = require('./db/migrate');

migrate()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
    });
  })
  .catch((err) => {
    console.error('[启动失败] 数据库迁移出错:', err);
    process.exit(1);
  });
