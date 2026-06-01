require('./config/env').initEnv();

const express = require('express');
const cors = require('cors');
const ejsLayouts = require('express-ejs-layouts');
const createAccessLogMiddleware = require('./middleware/access-log');
const viewLocalsMiddleware = require('./middleware/view-locals');
const routes = require('./router');
const { bootstrap, registerShutdownHandlers } = require('./lib/core/lifecycle');

const app = express();
const port = process.env.PORT || 3000;

app.set('views', `${__dirname}/views`);
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
app.use(createAccessLogMiddleware());
app.use(viewLocalsMiddleware);
app.use(routes);

bootstrap(app, port);
registerShutdownHandlers();
