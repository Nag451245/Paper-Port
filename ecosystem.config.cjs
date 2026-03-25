module.exports = {
  apps: [
    {
      name: 'capital-guard-api',
      cwd: './server',
      script: 'dist/index.js',
      exec_mode: 'fork',
      node_args: '--max-old-space-size=512',
      env: { NODE_ENV: 'production' },
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_memory_restart: '450M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '../logs/api-error.log',
      out_file: '../logs/api-out.log',
      merge_logs: true
    },
    {
      name: 'rust-engine',
      cwd: './engine',
      script: '../server/bin/capital-guard-engine',
      interpreter: 'none',
      exec_mode: 'fork',
      env: {
        RUST_LOG: 'info',
        ENGINE_PORT: '8080'
      },
      instances: 1,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 3000,
      kill_timeout: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '../logs/engine-error.log',
      out_file: '../logs/engine-out.log',
      merge_logs: true
    },
    {
      name: 'breeze-bridge',
      cwd: './server/breeze-bridge',
      script: './venv/bin/python',
      args: 'app.py',
      interpreter: 'none',
      exec_mode: 'fork',
      env: {
        PYTHONUNBUFFERED: '1'
      },
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '../logs/bridge-error.log',
      out_file: '../logs/bridge-out.log',
      merge_logs: true
    },
    {
      name: 'ml-service',
      cwd: './server/ml-service',
      script: './venv/bin/python',
      args: '-m uvicorn app:app --host 0.0.0.0 --port 8002',
      interpreter: 'none',
      exec_mode: 'fork',
      env: {
        PYTHONUNBUFFERED: '1',
        ML_SERVICE_PORT: '8002'
      },
      instances: 1,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 10000,
      kill_timeout: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '../logs/ml-error.log',
      out_file: '../logs/ml-out.log',
      merge_logs: true
    }
  ]
};
