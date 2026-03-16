#!/bin/bash
set -e

# ═══════════════════════════════════════════════════════════════
#  Capital Guard — Quick Redeploy (run ON the server)
#
#  Usage:
#    ./deploy/redeploy.sh              # full rebuild
#    ./deploy/redeploy.sh --skip-rust  # skip Rust compilation
#    ./deploy/redeploy.sh --server     # rebuild server only
#    ./deploy/redeploy.sh --frontend   # rebuild frontend only
# ═══════════════════════════════════════════════════════════════

APP_DIR="$HOME/capital-guard"
BUILD_RUST=true
BUILD_SERVER=true
BUILD_FRONTEND=true

for arg in "$@"; do
  case "$arg" in
    --skip-rust)  BUILD_RUST=false ;;
    --server)     BUILD_FRONTEND=false; BUILD_RUST=false ;;
    --frontend)   BUILD_SERVER=false; BUILD_RUST=false ;;
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
git pull origin main
echo ""

# ── Rust engine ──
if $BUILD_RUST && [ -d "$APP_DIR/engine" ]; then
  echo "[2] Building Rust engine..."
  cd "$APP_DIR/engine"
  source "$HOME/.cargo/env" 2>/dev/null || true
  cargo build --release 2>&1 | tail -5
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

# ── Restart ──
echo "[5] Restarting services..."
pm2 restart all
sudo systemctl reload nginx 2>/dev/null || true

sleep 2

ELAPSED=$(( $(date +%s) - STARTED ))
echo ""
echo "╔════════════════════════════════════════╗"
echo "║  Redeploy complete (${ELAPSED}s)       ║"
echo "╚════════════════════════════════════════╝"
pm2 status
