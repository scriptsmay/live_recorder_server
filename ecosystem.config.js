module.exports = {
  apps: [
    {
      name: 'live_recorder_server',
      script: './app.js',

      // --- 默认配置 (公共部分) ---
      instances: 1,
      autorestart: true,

      // --- 开发环境配置 (pm2 start ecosystem.config.js) ---
      watch: true,
      ignore_watch: ['node_modules', 'logs', 'backups', '.git', '*.log'],
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 1123,
        watch: false,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
