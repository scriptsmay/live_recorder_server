const { configureAccessLogger } = require('../lib/core/logger');

function createAccessLogMiddleware() {
  const { middleware } = configureAccessLogger();
  return middleware;
}

module.exports = createAccessLogMiddleware;
