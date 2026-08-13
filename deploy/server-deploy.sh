#!/bin/bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════
#  Capital Guard — On-Server Deployment Script
#  Run this directly ON the SSH server.
#
#  Usage:
#    ./deploy/server-deploy.sh                  # full deploy
#    ./deploy/server-deploy.sh --setup          # first-time: install all dependencies
#    ./deploy/server-deploy.sh --quick          # pull + rebuild + restart (no provisioning)
#    ./deploy/server-deploy.sh --server-only    # rebuild server + restart
#    ./deploy/server-deploy.sh --frontend-only  # rebuild frontend only
#    ./deploy/server-deploy.sh --status         # show service status
# ═══════════════════════════════════════════════════════════════

APP_DIR="$HOME/capital-guard"
REPO_URL="https://github.com/Nag451245/Paper-Port.git"
DOMAIN="${DOMAIN:-papertrade.duckdns.org}"
DB_USER="capitalguard"
DB_PASS="capitalguard_secure_2024"
DB_NAME="capitalguard"
MODE="${1:---full}"

print_banner() {
  echo ""
  echo "╔═══════════════════════════════════════════════╗"
  echo "║  Capital Guard — Deployment ($MODE)           ║"
  echo "╠═══════════════════════════════════════════════╣"
  echo "║  Repo:   $REPO_URL"
  echo "║  Dir:    $APP_DIR"
  echo "║  Domain: $DOMAIN"
  echo "╚═══════════════════════════════════════════════╝"
  echo ""
}

# ═══════════════════════════════════════════════════════════════
#  --status: Show current service health
# ═══════════════════════════════════════════════════════════════
if [[ "$MODE" == "--status" ]]; then
  echo ""
  echo "═══ PM2 Services ═══"
  pm2 status 2>/dev/null || echo "PM2 not running"
  echo ""
  echo "═══ System Services ═══"
  echo "  PostgreSQL: $(systemctl is-active postgresql 2>/dev/null || echo 'not installed')"
  echo "  Redis:      $(systemctl is-active redis-server 2>/dev/null || echo 'not installed')"
  echo "  Nginx:      $(systemctl is-active nginx 2>/dev/null || echo 'not installed')"
  echo ""
  echo "═══ Health Checks ═══"
  echo -n "  API (8000):          "; curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/api/health 2>/dev/null || echo "DOWN"
  echo ""
  echo -n "  Rust Engine (8080):  "; curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/health 2>/dev/null || echo "DOWN"
  echo ""
  echo -n "  Breeze Bridge (8001):"; curl -s -o /dev/null -w "%{http_code}" http://localhost:8001/health 2>/dev/null || echo "DOWN"
  echo ""
  echo -n "  Nginx (80):          "; curl -s -o /dev/null -w "%{http_code}" http://localhost 2>/dev/null || echo "DOWN"
  echo ""
  exit 0
fi

print_banner
STARTED=$(date +%s)

# ═══════════════════════════════════════════════════════════════
#  --setup: First-time server provisioning
# ═══════════════════════════════════════════════════════════════
if [[ "$MODE" == "--setup" ]]; then
  echo "═══ [SETUP] Installing all dependencies ═══"
  echo ""

  echo "[1/9] Updating system..."
  sudo apt update && sudo apt upgrade -y

  echo "[2/9] Installing Node.js 20..."
  if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
  fi
  echo "  Node: $(node -v) | npm: $(npm -v)"

  echo "[3/9] Installing PostgreSQL 16..."
  if ! command -v psql &>/dev/null; then
    sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
    sudo apt update && sudo apt install -y postgresql-16
  fi
  sudo systemctl enable postgresql && sudo systemctl start postgresql
  sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';" 2>/dev/null || true
  sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" 2>/dev/null || true
  sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;" 2>/dev/null || true
  echo "  PostgreSQL ready (db: $DB_NAME, user: $DB_USER)"

  echo "[4/9] Installing Redis..."
  if ! command -v redis-cli &>/dev/null; then
    sudo apt install -y redis-server
  fi
  sudo systemctl enable redis-server && sudo systemctl start redis-server
  echo "  Redis ready."

  echo "[5/9] Installing Nginx..."
  sudo apt install -y nginx
  sudo systemctl enable nginx
  echo "  Nginx ready."

  echo "[6/9] Installing PM2..."
  if ! command -v pm2 &>/dev/null; then
    sudo npm install -g pm2
    pm2 startup systemd -u "$USER" --hp "$HOME" 2>/dev/null | grep sudo | bash 2>/dev/null || true
  fi
  echo "  PM2 ready."

  echo "[7/9] Installing Rust toolchain..."
  if ! command -v cargo &>/dev/null; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
  fi
  echo "  Rust: $(rustc --version 2>/dev/null || echo 'installed — re-login to activate')"

  echo "[8/9] Installing Python3 (for Breeze Bridge)..."
  if ! command -v python3 &>/dev/null; then
    sudo apt install -y python3 python3-pip python3-venv
  fi
  echo "  Python: $(python3 --version)"

  echo "[9/9] Installing build tools + creating swap..."
  sudo apt install -y git build-essential pkg-config libssl-dev curl
  if [ ! -f /swapfile ]; then
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile && sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  fi
  echo "  Swap: $(free -h | grep Swap | awk '{print $2}')"

  ELAPSED=$(( $(date +%s) - STARTED ))
  echo ""
  echo "╔═══════════════════════════════════════════════╗"
  echo "║  Server provisioning complete! (${ELAPSED}s)   ║"
  echo "╠═══════════════════════════════════════════════╣"
  echo "║  Next: run ./deploy/server-deploy.sh --full   ║"
  echo "╚═══════════════════════════════════════════════╝"
  exit 0
fi

# ═══════════════════════════════════════════════════════════════
#  Source cargo env for Rust builds
# ═══════════════════════════════════════════════════════════════
source "$HOME/.cargo/env" 2>/dev/null || true

# ═══════════════════════════════════════════════════════════════
#  Clone / Pull the repository
# ═══════════════════════════════════════════════════════════════
echo "[1/8] Fetching code from $REPO_URL ..."
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR"
  git fetch origin main
  git reset --hard origin/main
  echo "  Pulled latest from origin/main."
else
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
  echo "  Cloned fresh."
fi
echo ""

# ═══════════════════════════════════════════════════════════════
#  Build Rust Engine
# ═══════════════════════════════════════════════════════════════
if [[ "$MODE" != "--server-only" && "$MODE" != "--frontend-only" ]]; then
  echo "[2/8] Building Rust engine (release mode)..."
  if [ -d "$APP_DIR/engine" ]; then
    cd "$APP_DIR/engine"
    cargo build --release 2>&1 | tail -5
    mkdir -p "$APP_DIR/server/bin"
    cp target/release/capital-guard-engine "$APP_DIR/server/bin/" 2>/dev/null || true
    echo "  Engine binary: $(ls -lh target/release/capital-guard-engine 2>/dev/null | awk '{print $5}')"
  else
    echo "  No engine directory found, skipping."
  fi
  echo ""
fi

# ═══════════════════════════════════════════════════════════════
#  Build Server (Node.js backend)
# ═══════════════════════════════════════════════════════════════
if [[ "$MODE" != "--frontend-only" ]]; then
  echo "[3/8] Building server..."
  cd "$APP_DIR/server"
  npm ci --omit=dev

  if [ ! -f .env ]; then
    if [ -f .env.example ]; then
      cp .env.example .env
    else
      touch .env
    fi
    JWT_SECRET=$(openssl rand -base64 32)
    ENCRYPTION_KEY=$(openssl rand -base64 32)

    cat >> .env <<ENV_BLOCK
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}"
DIRECT_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="$JWT_SECRET"
ENCRYPTION_KEY="$ENCRYPTION_KEY"
NODE_ENV="production"
CORS_ORIGINS="https://$DOMAIN"
RUST_ENGINE_URL="http://localhost:8080"
BREEZE_BRIDGE_URL="http://localhost:8001"
PORT=8000
ENV_BLOCK
    echo "  .env created — edit it to add your Breeze API keys:"
    echo "    nano $APP_DIR/server/.env"
  fi

  npx prisma generate
  npx prisma migrate deploy 2>/dev/null || {
    npx prisma migrate dev --name init --create-only 2>/dev/null || true
    npx prisma migrate deploy
  }
  npx -p typescript -y tsc
  echo "  Server built."
  echo ""
fi

# ═══════════════════════════════════════════════════════════════
#  Build Frontend
# ═══════════════════════════════════════════════════════════════
if [[ "$MODE" != "--server-only" ]]; then
  echo "[4/8] Building frontend..."
  cd "$APP_DIR/frontend"
  npm ci

  if [ ! -f .env.production ]; then
    cat > .env.production <<VITE_ENV
VITE_API_BASE_URL=https://$DOMAIN/api
VITE_WS_URL=wss://$DOMAIN/ws
VITE_ENV
  fi

  npx vite build
  rm -rf node_modules
  echo "  Frontend built."
  echo ""
fi

# ═══════════════════════════════════════════════════════════════
#  Setup Breeze Bridge (Python microservice)
# ═══════════════════════════════════════════════════════════════
if [[ "$MODE" != "--server-only" && "$MODE" != "--frontend-only" ]]; then
  echo "[5/8] Setting up Breeze Bridge..."
  BRIDGE_DIR="$APP_DIR/server/breeze-bridge"
  if [ -d "$BRIDGE_DIR" ]; then
    cd "$BRIDGE_DIR"
    if [ ! -d "venv" ]; then
      python3 -m venv venv
    fi
    source venv/bin/activate
    pip install --upgrade pip -q
    if [ -f requirements.txt ]; then
      pip install -r requirements.txt -q
    fi
    deactivate
    echo "  Breeze Bridge ready."
  else
    echo "  No breeze-bridge directory found, skipping."
  fi
  echo ""
fi

# ═══════════════════════════════════════════════════════════════
#  Configure Nginx
# ═══════════════════════════════════════════════════════════════
echo "[6/8] Configuring Nginx..."
EXTERNAL_IP=$(curl -s ifconfig.me 2>/dev/null || echo "unknown")

sudo tee /etc/nginx/sites-available/capital-guard > /dev/null <<NGINX
server {
    listen 80;
    server_name $DOMAIN $EXTERNAL_IP _;

    root $APP_DIR/frontend/dist;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
    gzip_min_length 256;

    location / {
        try_files \$uri \$uri/ /index.html;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }

    location /api {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 60s;
        proxy_read_timeout 120s;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/capital-guard /etc/nginx/sites-enabled/capital-guard
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx
echo "  Nginx configured."
echo ""

# ═══════════════════════════════════════════════════════════════
#  Start all services with PM2
# ═══════════════════════════════════════════════════════════════
echo "[7/8] Starting services with PM2..."
cd "$APP_DIR"

cat > ecosystem.config.cjs <<'PM2_CONFIG'
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
      max_restarts: 5,
      min_uptime: 10000,
      restart_delay: 8000,
      kill_timeout: 10000,
      wait_ready: false,
      max_memory_restart: '450M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/api-error.log',
      out_file: './logs/api-out.log',
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
      error_file: './logs/engine-error.log',
      out_file: './logs/engine-out.log',
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
      error_file: './logs/bridge-error.log',
      out_file: './logs/bridge-out.log',
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
      error_file: './logs/ml-error.log',
      out_file: './logs/ml-out.log',
      merge_logs: true
    }
  ]
};
PM2_CONFIG

mkdir -p logs
mkdir -p "$APP_DIR/engine/data"
mkdir -p "$APP_DIR/server/data"

pm2 delete all 2>/dev/null || true

sudo fuser -k 8000/tcp 2>/dev/null || true
sudo fuser -k 8001/tcp 2>/dev/null || true
sudo fuser -k 8002/tcp 2>/dev/null || true
sudo fuser -k 8080/tcp 2>/dev/null || true
sleep 2

pm2 start ecosystem.config.cjs
pm2 save

echo "  Services started."
echo ""

# ═══════════════════════════════════════════════════════════════
#  Verify deployment
# ═══════════════════════════════════════════════════════════════
echo "[8/8] Verifying deployment..."
sleep 5

pm2 status

ELAPSED=$(( $(date +%s) - STARTED ))

echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║  Deployment Complete! (${ELAPSED}s)                       ║"
echo "╠═══════════════════════════════════════════════════════════╣"
echo "║                                                           ║"
echo "║  Frontend:      http://$EXTERNAL_IP                       "
echo "║  API:           http://$EXTERNAL_IP/api                   "
echo "║  API Health:    http://$EXTERNAL_IP/api/health            "
echo "║  Engine Health: curl http://localhost:8080/api/health      "
echo "║  Bridge Health: curl http://localhost:8001/health          "
echo "║                                                           ║"
echo "╠═══════════════════════════════════════════════════════════╣"
echo "║  Services (PM2):                                          ║"
echo "║    capital-guard-api  → Node.js server     (port 8000)    ║"
echo "║    rust-engine        → Rust scanner       (port 8080)    ║"
echo "║    breeze-bridge      → Python broker API  (port 8001)    ║"
echo "║                                                           ║"
echo "╠═══════════════════════════════════════════════════════════╣"
echo "║  Commands:                                                ║"
echo "║    pm2 status           — check all services              ║"
echo "║    pm2 logs             — view all logs                   ║"
echo "║    pm2 logs rust-engine — view engine logs                ║"
echo "║    pm2 restart all      — restart everything              ║"
echo "║    pm2 monit            — live monitoring dashboard       ║"
echo "║                                                           ║"
echo "║  Config:                                                  ║"
echo "║    nano $APP_DIR/server/.env                              "
echo "║    nano $APP_DIR/engine/engine.toml                       "
echo "║                                                           ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""
echo "  >>> Don't forget to add your Breeze API keys in .env <<<"
echo "      nano $APP_DIR/server/.env"
echo "      pm2 restart all"
