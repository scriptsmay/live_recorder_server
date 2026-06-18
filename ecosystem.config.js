module.exports = {
  apps: [
    {
      name: 'live_recorder_server',
      script: './server/app.js',

      // --- 默认配置 (公共部分) ---
      instances: 1,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
