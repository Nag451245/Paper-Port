#!/bin/bash
set -e

# ═══════════════════════════════════════════════════════════════
#  Capital Guard — Quick Redeploy (run ON the server)
#
#  Usage:
#    ./deploy/redeploy.sh              # full rebuild (all services)
#    ./deploy/redeploy.sh --skip-rust  # skip Rust compilation
#    ./deploy/redeploy.sh --server     # rebuild server only
#    ./deploy/redeploy.sh --frontend   # rebuild frontend only
#    ./deploy/redeploy.sh --bridge     # rebuild breeze bridge only
# ═══════════════════════════════════════════════════════════════

APP_DIR="$HOME/capital-guard"
BUILD_RUST=true
BUILD_SERVER=true
BUILD_FRONTEND=true
BUILD_BRIDGE=true

for arg in "$@"; do
  case "$arg" in
    --skip-rust)  BUILD_RUST=false ;;
    --server)     BUILD_FRONTEND=false; BUILD_RUST=false; BUILD_BRIDGE=false ;;
    --frontend)   BUILD_SERVER=false; BUILD_RUST=false; BUILD_BRIDGE=false ;;
    --bridge)     BUILD_SERVER=false; BUILD_RUST=false; BUILD_FRONTEND=false ;;
  esac
done

cd "$APP_DIR"
STARTED=$(date +%s)

echo "╔════════════════════════════════════════╗"
echo "║  Capital Guard — Redeploy              ║"
echo "╚════════════════════════════════════════╝"
echo ""

# ── Pull latest ──
echo "[1] Pulling latest code..."
git fetch origin main
git reset --hard origin/main
echo ""

# ── Rust engine ──
if $BUILD_RUST && [ -d "$APP_DIR/engine" ]; then
  echo "[2] Building Rust engine..."
  cd "$APP_DIR/engine"
  source "$HOME/.cargo/env" 2>/dev/null || true
  cargo build --release 2>&1 | tail -5
  mkdir -p "$APP_DIR/server/bin"
  cp target/release/capital-guard-engine "$APP_DIR/server/bin/" 2>/dev/null || true
  echo "  Done."
  echo ""
fi

# ── Server ──
if $BUILD_SERVER; then
  echo "[3] Rebuilding server..."
  cd "$APP_DIR/server"
  npm ci --production
  npx prisma generate
  npx prisma migrate deploy 2>/dev/null || true
  npx -y typescript tsc
  if [ $? -eq 0 ]; then
    echo "  Server build succeeded."
  else
    echo "  ERROR: Server build FAILED — check TypeScript errors above"
    exit 1
  fi
  echo ""
fi

# ── Frontend ──
if $BUILD_FRONTEND; then
  echo "[4] Rebuilding frontend..."
  cd "$APP_DIR/frontend"
  npm ci --production
  npx -y vite build
  if [ $? -eq 0 ]; then
    echo "  Frontend build succeeded."
  else
    echo "  ERROR: Frontend build FAILED"
    exit 1
  fi
  echo ""
fi

# ── Breeze Bridge ──
if $BUILD_BRIDGE && [ -d "$APP_DIR/server/breeze-bridge" ]; then
  echo "[5] Rebuilding Breeze Bridge..."
  cd "$APP_DIR/server/breeze-bridge"
  if [ ! -d "venv" ]; then
    python3 -m venv venv
  fi
  source venv/bin/activate
  pip install --upgrade pip -q
  [ -f requirements.txt ] && pip install -r requirements.txt -q
  deactivate
  echo "  Done."
  echo ""
fi

# ── ML Service ──
if [ -d "$APP_DIR/server/ml-service" ]; then
  echo "[5b] Checking ML Service..."
  cd "$APP_DIR/server/ml-service"
  if [ ! -d "venv" ]; then
    python3 -m venv venv
  fi
  source venv/bin/activate
  pip install --upgrade pip -q
  [ -f requirements.txt ] && pip install -r requirements.txt -q
  deactivate
  echo "  Done."
  echo ""
fi

# ── Ensure data directories exist ──
mkdir -p "$APP_DIR/logs"
mkdir -p "$APP_DIR/engine/data"
mkdir -p "$APP_DIR/server/data"

# ── Write ecosystem.config.cjs (always regenerate to stay in sync) ──
echo "[6] Writing ecosystem.config.cjs..."
cat > "$APP_DIR/ecosystem.config.cjs" <<'PM2_CONFIG'
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
PM2_CONFIG
echo "  Done."

# ── Restart ──
echo "[7] Restarting services..."
cd "$APP_DIR"

pm2 stop all 2>/dev/null || true
sleep 3
sudo fuser -k 8000/tcp 2>/dev/null || true
sudo fuser -k 8001/tcp 2>/dev/null || true
sudo fuser -k 8002/tcp 2>/dev/null || true
sudo fuser -k 8080/tcp 2>/dev/null || true
sleep 2

pm2 delete all 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
sudo systemctl reload nginx 2>/dev/null || true

sleep 5

ELAPSED=$(( $(date +%s) - STARTED ))
echo ""
echo "╔════════════════════════════════════════╗"
echo "║  Redeploy complete (${ELAPSED}s)       ║"
echo "╚════════════════════════════════════════╝"
pm2 status
echo ""
echo "═══ Health Checks ═══"
echo -n "  API (8000):    "; curl -sf http://localhost:8000/api/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'OK — phase: {d.get(\"market\",{}).get(\"phase\",\"?\")} | open: {d.get(\"market\",{}).get(\"isOpen\",\"?\")}')" 2>/dev/null || echo "DOWN"; echo ""
echo -n "  Bridge (8001): "; curl -sf -o /dev/null -w "%{http_code}" http://localhost:8001/health 2>/dev/null || echo "DOWN"; echo ""
echo ""
echo "═══ Orchestrator Log ═══"
pm2 logs capital-guard-api --lines 10 --nostream 2>/dev/null | grep -i "orchestrator\|phase\|holiday\|auto-start\|market" || echo "  (no orchestrator output yet — wait 15s for auto-start)"
echo ""
