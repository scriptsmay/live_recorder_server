module.exports = {
  apps: [
    {
      name: 'live_recorder_server',
      script: './app.js',

      // --- 默认配置 (公共部分) ---
      instances: 1,
      autorestart: true,

      // --- 开发环境配置 (pm2 start ecosystem.config.js) ---
      // 默认情况下，PM2 会读取这里的 env
      watch: true, // 开启监听
      ignore_watch: ['node_modules', 'logs', '.git', '*.log'],
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
        watch: false, // 生产环境务必关闭 watch，防止意外重启
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
