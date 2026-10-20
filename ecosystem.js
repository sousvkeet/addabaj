module.exports = {
  apps: [
    {
      name: 'adda-khana',
      cwd: '/var/www/addabaj',
      script: 'server/src/index.js',
      interpreter: '/root/.nvm/versions/node/v20.16.0/bin/node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 4080,
      },
    },
  ],
};
