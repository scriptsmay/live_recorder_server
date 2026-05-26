const migrate = require('../../db/migrate');
const redis = require('../../db/redis');
const watchdog = require('./watchdog');
const { pollingManager } = require('./polling');
const RecorderService = require('../../services/RecorderService');
const transcodeQueue = require('./TranscodeQueue');
const { configureAccessLogger } = require('./logger');

async function bootstrap(app, port) {
  try {
    await migrate();

    const keys = await redis.keys('active_task:*');
    for (const key of keys) {
      await redis.del(key);
    }

    await RecorderService.cleanupStaleRecordings();
    await transcodeQueue.init();
    watchdog.start();

    app.listen(port, () => {
      console.log(`Live Recorder Server 已启动，端口 ${port}`);
    });

    pollingManager.start().catch((err) => {
      console.error('[PollingManager] 启动失败:', err.message);
    });
  } catch (err) {
    console.error('[启动失败] 初始化出错:', err);
    process.exit(1);
  }
}

async function gracefulShutdown(signal) {
  console.log(`[退出] 收到 ${signal}，正在关闭服务...`);

  try {
    await pollingManager.stop();

    const { getServerLogStream } = require('./logger');
    const serverLogStream = getServerLogStream();
    if (serverLogStream) {
      serverLogStream.end();
    }

    const { accessLogStream } = configureAccessLogger();
    if (accessLogStream) {
      accessLogStream.end();
    }

    console.log('[退出] 所有资源已清理');
  } catch (err) {
    console.error('[退出] 清理资源时出错:', err);
  } finally {
    process.exit(0);
  }
}

function registerShutdownHandlers() {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    console.error('[未捕获的异常]:', err);
    gracefulShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[未处理的Promise拒绝]:', reason);
    gracefulShutdown('unhandledRejection');
  });
}

module.exports = {
  bootstrap,
  gracefulShutdown,
  registerShutdownHandlers,
};
