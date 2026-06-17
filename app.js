require('./config/env').initEnv();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const createAccessLogMiddleware = require('./middleware/access-log');
const routes = require('./router');
const { bootstrap, registerShutdownHandlers } = require('./lib/core/lifecycle');

const app = express();
const port = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.static('public'));
app.use(cors({ credentials: true }));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(createAccessLogMiddleware());
app.use(routes);

bootstrap(app, port);
registerShutdownHandlers();
