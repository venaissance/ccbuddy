module.exports = {
  apps: [{
    name: "ccbuddy",
    script: "scripts/start.sh",
    interpreter: "bash",
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    max_memory_restart: "500M",
    env: {
      NODE_ENV: "production",
      // Uncomment if you need a proxy:
      // HTTPS_PROXY: "http://127.0.0.1:7890",
      // HTTP_PROXY: "http://127.0.0.1:7890",
      // ALL_PROXY: "http://127.0.0.1:7890",
      // NO_PROXY: "127.0.0.1,localhost",
    },
  }],
};
