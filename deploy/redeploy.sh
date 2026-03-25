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
  npm run build
  echo "  Done."
  echo ""
fi

# ── Frontend ──
if $BUILD_FRONTEND; then
  echo "[4] Rebuilding frontend..."
  cd "$APP_DIR/frontend"
  npm ci --production
  npm run build
  echo "  Done."
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

# ── Restart ──
echo "[6] Restarting services..."
cd "$APP_DIR"

pm2 stop all 2>/dev/null || true
sleep 2
fuser -k 8000/tcp 2>/dev/null || true
fuser -k 8001/tcp 2>/dev/null || true
fuser -k 8002/tcp 2>/dev/null || true
sleep 1

pm2 delete all 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
sudo systemctl reload nginx 2>/dev/null || true

sleep 3

ELAPSED=$(( $(date +%s) - STARTED ))
echo ""
echo "╔════════════════════════════════════════╗"
echo "║  Redeploy complete (${ELAPSED}s)       ║"
echo "╚════════════════════════════════════════╝"
pm2 status
echo ""
echo "Health checks:"
echo -n "  API:    "; curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/api/health 2>/dev/null || echo "DOWN"; echo ""
echo -n "  Engine: "; curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/health 2>/dev/null || echo "DOWN"; echo ""
echo -n "  Bridge: "; curl -s -o /dev/null -w "%{http_code}" http://localhost:8001/health 2>/dev/null || echo "DOWN"; echo ""
