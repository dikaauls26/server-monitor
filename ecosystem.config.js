/**
 * PM2 process definition for Server Monitor.
 * Used by install.sh / start.sh via `pm2 start ecosystem.config.js`.
 */
module.exports = {
  apps: [
    {
      name: 'server-monitor',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
