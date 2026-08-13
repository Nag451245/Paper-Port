#!/bin/bash
set -e

echo "============================================"
echo "  Breeze Bridge — Python Microservice Setup"
echo "============================================"

APP_DIR="$HOME/capital-guard/server/breeze-bridge"

if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: $APP_DIR not found. Run deploy.sh first."
  exit 1
fi

cd "$APP_DIR"

# Install Python3 + pip if missing
if ! command -v python3 &>/dev/null; then
  echo "[1/3] Installing Python3..."
  sudo apt-get update -qq && sudo apt-get install -y python3 python3-pip python3-venv
else
  echo "[1/3] Python3 already installed: $(python3 --version)"
fi

# Create virtual environment
echo "[2/3] Setting up virtual environment..."
if [ ! -d "venv" ]; then
  python3 -m venv venv
fi
source venv/bin/activate
pip install --upgrade pip -q
pip install -r requirements.txt -q

echo "[3/3] Starting Breeze Bridge with PM2..."

# Check if pm2 is available
if ! command -v pm2 &>/dev/null; then
  echo "ERROR: pm2 not found. Install it: sudo npm i -g pm2"
  exit 1
fi

# Stop existing instance if running
pm2 delete breeze-bridge 2>/dev/null || true

# Start with PM2
pm2 start "$APP_DIR/venv/bin/python" \
  --name "breeze-bridge" \
  --interpreter none \
  -- "$APP_DIR/app.py"

pm2 save

echo ""
echo "============================================"
echo "  Breeze Bridge is running on port 8001"
echo "============================================"
echo ""
echo "Check status:  pm2 status"
echo "View logs:     pm2 logs breeze-bridge"
echo "Health check:  curl http://localhost:8001/health"
echo ""
