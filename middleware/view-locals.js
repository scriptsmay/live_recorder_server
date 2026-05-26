const dayjs = require('dayjs');
const { appVersion, dockerImageVersion, startTime } = require('../config/app-info');

function formatDate(date, format = 'YYYY-MM-DD HH:mm:ss') {
  if (!date) return '-';

  if (typeof date === 'string' && /^\d+$/.test(date)) {
    date = parseFloat(date);
  }

  let parsedDate;
  if (typeof date === 'number') {
    if (date > 10000000000) {
      parsedDate = dayjs(date);
    } else {
      parsedDate = dayjs.unix(date);
    }
  } else {
    parsedDate = dayjs(date);
  }

  if (!parsedDate.isValid()) {
    return '-';
  }

  return parsedDate.format(format);
}

function viewLocalsMiddleware(req, res, next) {
  res.locals.path = req.path;
  res.locals.title = 'Live Recorder Server';
  res.locals.dayjs = dayjs;
  res.locals.formatDate = formatDate;
  res.locals.serverStartTime = startTime;
  res.locals.appVersion = appVersion;
  res.locals.dockerImageVersion = dockerImageVersion;
  next();
}

module.exports = viewLocalsMiddleware;
