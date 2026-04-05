module.exports = {
  apps: [{
    name: "openclaw",
    script: "src/index.ts",
    interpreter: "bun",
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    max_memory_restart: "500M",
    env: {
      NODE_ENV: "production",
    },
  }],
};
