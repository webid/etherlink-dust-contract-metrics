// pm2 ecosystem file — start both processes with: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name:          'dustwatch-indexer',
      script:        'indexer.js',
      args:          '--daemon',
      cwd:           __dirname,
      restart_delay: 10000,   // wait 10 s before restarting on crash
      max_restarts:  20,
      autorestart:   true,
    },
    {
      name:          'dustwatch-server',
      script:        'server.js',
      cwd:           __dirname,
      env:           { PORT: 3001 },
      restart_delay: 5000,
      max_restarts:  20,
      autorestart:   true,
    },
  ],
};
