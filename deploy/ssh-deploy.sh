#!/bin/bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════
#  Capital Guard — SSH Deployment Script
#  Run FROM your local machine (Git Bash / WSL / macOS / Linux)
#
#  Usage:
#    ./deploy/ssh-deploy.sh                    # uses defaults
#    ./deploy/ssh-deploy.sh user@1.2.3.4       # custom host
#    ./deploy/ssh-deploy.sh user@1.2.3.4 -i ~/.ssh/my_key
#    ./deploy/ssh-deploy.sh --setup            # first-time VM setup
#    ./deploy/ssh-deploy.sh --quick            # pull + restart only
# ═══════════════════════════════════════════════════════════════

# ── Configuration (edit these or pass as env vars) ────────────
SSH_USER="${SSH_USER:-}"
SSH_HOST="${SSH_HOST:-}"
SSH_KEY="${SSH_KEY:-}"
SSH_PORT="${SSH_PORT:-22}"
REMOTE_DIR="${REMOTE_DIR:-\$HOME/capital-guard}"
REPO_URL="${REPO_URL:-https://github.com/Nag451245/Paper-Port.git}"
DOMAIN="${DOMAIN:-papertrade.duckdns.org}"

# ── Parse arguments ──────────────────────────────────────────
MODE="deploy"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --setup)   MODE="setup"; shift ;;
    --quick)   MODE="quick"; shift ;;
    --https)   MODE="https"; shift ;;
    -i)        SSH_KEY="$2"; shift 2 ;;
    -p)        SSH_PORT="$2"; shift 2 ;;
    --repo)    REPO_URL="$2"; shift 2 ;;
    --domain)  DOMAIN="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [user@host] [options]"
      echo ""
      echo "Options:"
      echo "  --setup       First-time server provisioning (install Node, Postgres, etc.)"
      echo "  --quick       Quick deploy: git pull + rebuild + restart"
      echo "  --https       Setup Let's Encrypt SSL certificate"
      echo "  -i KEY        SSH private key file"
      echo "  -p PORT       SSH port (default: 22)"
      echo "  --repo URL    Git repository URL"
      echo "  --domain NAME Domain name (default: papertrade.duckdns.org)"
      echo ""
      echo "Examples:"
      echo "  $0 ubuntu@34.100.200.50"
      echo "  $0 ubuntu@34.100.200.50 -i ~/.ssh/gcp_key --setup"
      echo "  $0 --quick"
      echo ""
      echo "Environment variables:"
      echo "  SSH_USER, SSH_HOST, SSH_KEY, SSH_PORT, REMOTE_DIR, REPO_URL, DOMAIN"
      exit 0
      ;;
    *@*)       SSH_USER="${1%%@*}"; SSH_HOST="${1#*@}"; shift ;;
    *)         echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [[ -z "$SSH_HOST" ]]; then
  echo "Error: No SSH host specified."
  echo "Usage: $0 user@host [options]"
  echo "   or: export SSH_USER=ubuntu SSH_HOST=1.2.3.4 && $0"
  exit 1
fi

SSH_USER="${SSH_USER:-ubuntu}"

# Build SSH command
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -p $SSH_PORT"
[[ -n "$SSH_KEY" ]] && SSH_OPTS="$SSH_OPTS -i $SSH_KEY"
SSH_CMD="ssh $SSH_OPTS ${SSH_USER}@${SSH_HOST}"
SCP_CMD="scp $SSH_OPTS"

echo "╔════════════════════════════════════════════╗"
echo "║  Capital Guard — SSH Deploy ($MODE)        ║"
echo "╠════════════════════════════════════════════╣"
echo "║  Host:   ${SSH_USER}@${SSH_HOST}:${SSH_PORT}"
echo "║  Remote: ${REMOTE_DIR}"
echo "║  Repo:   ${REPO_URL}"
echo "╚════════════════════════════════════════════╝"
echo ""

# ── Test SSH connection ──────────────────────────────────────
echo "[0] Testing SSH connection..."
if ! $SSH_CMD "echo 'SSH OK'" 2>/dev/null; then
  echo "ERROR: Cannot connect to ${SSH_USER}@${SSH_HOST}:${SSH_PORT}"
  [[ -n "$SSH_KEY" ]] && echo "  Key: $SSH_KEY"
  exit 1
fi
echo "  Connected."
echo ""

# ═══════════════════════════════════════════════════════════════
#  MODE: setup — First-time server provisioning
# ═══════════════════════════════════════════════════════════════
if [[ "$MODE" == "setup" ]]; then
  echo "[SETUP] Provisioning server with required software..."
  $SSH_CMD 'bash -s' <<'SETUP_SCRIPT'
set -e

echo "[1/8] Updating system..."
sudo apt update && sudo apt upgrade -y

echo "[2/8] Installing Node.js 20..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi
echo "  Node: $(node -v) | npm: $(npm -v)"

echo "[3/8] Installing PostgreSQL 16..."
if ! command -v psql &>/dev/null; then
  sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
  sudo apt update && sudo apt install -y postgresql-16
fi
sudo systemctl enable postgresql && sudo systemctl start postgresql
sudo -u postgres psql -c "CREATE USER capitalguard WITH PASSWORD 'capitalguard_secure_2024';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE capitalguard OWNER capitalguard;" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE capitalguard TO capitalguard;" 2>/dev/null || true
echo "  PostgreSQL ready."

echo "[4/8] Installing Redis..."
if ! command -v redis-cli &>/dev/null; then
  sudo apt install -y redis-server
fi
sudo systemctl enable redis-server && sudo systemctl start redis-server
echo "  Redis ready."

echo "[5/8] Installing Nginx..."
sudo apt install -y nginx
sudo systemctl enable nginx
echo "  Nginx ready."

echo "[6/8] Installing PM2..."
if ! command -v pm2 &>/dev/null; then
  sudo npm install -g pm2
  pm2 startup systemd -u "$USER" --hp "$HOME" 2>/dev/null | grep sudo | bash 2>/dev/null || true
fi
echo "  PM2 ready."

echo "[7/8] Installing Rust toolchain..."
if ! command -v cargo &>/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi
echo "  Rust: $(rustc --version 2>/dev/null || echo 'installed, re-login to activate')"

echo "[8/8] Creating swap (for Rust compilation)..."
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi
echo "  Swap: $(free -h | grep Swap | awk '{print $2}')"

sudo apt install -y git build-essential pkg-config libssl-dev

echo ""
echo "══════════════════════════════════════"
echo "  Server provisioning complete!"
echo "══════════════════════════════════════"
SETUP_SCRIPT

  echo ""
  echo "Server is ready. Now run: $0 ${SSH_USER}@${SSH_HOST} to deploy the app."
  exit 0
fi

# ═══════════════════════════════════════════════════════════════
#  MODE: quick — Pull latest + rebuild + restart
# ═══════════════════════════════════════════════════════════════
if [[ "$MODE" == "quick" ]]; then
  echo "[QUICK DEPLOY] Pulling latest code and restarting..."
  $SSH_CMD "bash -s" <<QUICK_SCRIPT
set -e
cd $REMOTE_DIR

echo "[1/5] Pulling latest code..."
git pull origin main

echo "[2/5] Rebuilding server..."
cd $REMOTE_DIR/server
npm ci --production
npx prisma generate
npx prisma migrate deploy 2>/dev/null || true
npm run build

echo "[3/5] Rebuilding frontend..."
cd $REMOTE_DIR/frontend
npm ci --production
npm run build

echo "[4/5] Rebuilding Rust engine..."
if [ -d "$REMOTE_DIR/engine" ]; then
  cd $REMOTE_DIR/engine
  source "\$HOME/.cargo/env" 2>/dev/null || true
  cargo build --release 2>&1 | tail -3
  cp target/release/capital-guard-engine $REMOTE_DIR/server/bin/ 2>/dev/null || true
fi

echo "[5/5] Restarting services..."
pm2 restart all
sudo systemctl reload nginx

echo ""
sleep 2
pm2 status
echo ""
echo "Quick deploy complete!"
QUICK_SCRIPT
  exit 0
fi

# ═══════════════════════════════════════════════════════════════
#  MODE: https — Setup Let's Encrypt SSL
# ═══════════════════════════════════════════════════════════════
if [[ "$MODE" == "https" ]]; then
  echo "[HTTPS] Setting up SSL for $DOMAIN..."
  $SSH_CMD "bash -s" <<HTTPS_SCRIPT
set -e
DOMAIN="$DOMAIN"
APP_DIR="$REMOTE_DIR"

sudo apt install -y certbot python3-certbot-nginx

sudo tee /etc/nginx/sites-available/capital-guard > /dev/null <<'NGINX'
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\\\$host\\\$request_uri;
}

server {
    listen 443 ssl;
    server_name ${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    root ${APP_DIR}/frontend/dist;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
    gzip_min_length 256;

    location / {
        try_files \\\$uri \\\$uri/ /index.html;
    }

    location /api {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\\$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)\\\$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/capital-guard /etc/nginx/sites-enabled/capital-guard
sudo rm -f /etc/nginx/sites-enabled/default

if [ -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
  sudo certbot install --nginx --cert-name "${DOMAIN}" --non-interactive
else
  sudo certbot --nginx -d "${DOMAIN}" --register-unsafely-without-email --agree-tos --non-interactive
fi

sudo nginx -t && sudo systemctl restart nginx

cat > "${APP_DIR}/frontend/.env.production" <<ENV
VITE_API_BASE_URL=https://${DOMAIN}/api
VITE_WS_URL=wss://${DOMAIN}/ws
ENV

cd "${APP_DIR}/frontend" && npm run build

cd "${APP_DIR}/server"
[ -f .env ] && sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=\"https://${DOMAIN}\"|" .env
pm2 restart all

echo ""
echo "HTTPS setup complete! App live at: https://${DOMAIN}"
HTTPS_SCRIPT
  exit 0
fi

# ═══════════════════════════════════════════════════════════════
#  MODE: deploy — Full deployment
# ═══════════════════════════════════════════════════════════════
echo "[FULL DEPLOY] Starting deployment..."
$SSH_CMD "bash -s" <<DEPLOY_SCRIPT
set -e
source "\$HOME/.cargo/env" 2>/dev/null || true

APP_DIR="$REMOTE_DIR"
REPO_URL="$REPO_URL"
DOMAIN="$DOMAIN"

# ── 1. Clone or pull ──
echo "[1/7] Fetching code..."
if [ -d "\$APP_DIR" ]; then
  cd "\$APP_DIR" && git pull origin main
else
  git clone "\$REPO_URL" "\$APP_DIR"
  cd "\$APP_DIR"
fi

# ── 2. Build Rust engine ──
echo "[2/7] Building Rust engine..."
if [ -d "\$APP_DIR/engine" ]; then
  cd "\$APP_DIR/engine"
  cargo build --release 2>&1 | tail -5
  mkdir -p "\$APP_DIR/server/bin"
  cp target/release/capital-guard-engine "\$APP_DIR/server/bin/"
  echo "  Engine: \$(ls -lh target/release/capital-guard-engine | awk '{print \$5}')"
fi

# ── 3. Setup backend ──
echo "[3/7] Setting up backend..."
cd "\$APP_DIR/server"
npm ci --production

if [ ! -f .env ]; then
  cp .env.example .env
  JWT_SECRET=\$(openssl rand -base64 32)
  ENCRYPTION_KEY=\$(openssl rand -base64 32)
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=\"postgresql://capitalguard:capitalguard_secure_2024@localhost:5432/capitalguard\"|" .env
  sed -i "s|^DIRECT_URL=.*|DIRECT_URL=\"postgresql://capitalguard:capitalguard_secure_2024@localhost:5432/capitalguard\"|" .env
  sed -i "s|^REDIS_URL=.*|REDIS_URL=\"redis://localhost:6379\"|" .env
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=\"\$JWT_SECRET\"|" .env
  sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=\"\$ENCRYPTION_KEY\"|" .env
  sed -i "s|^NODE_ENV=.*|NODE_ENV=\"production\"|" .env
  sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=\"https://\$DOMAIN\"|" .env
  echo "  .env created — edit it to add API keys: nano \$APP_DIR/server/.env"
fi

npx prisma generate
npx prisma migrate deploy 2>/dev/null || {
  npx prisma migrate dev --name init --create-only 2>/dev/null || true
  npx prisma migrate deploy
}
npm run build

# ── 4. Setup frontend ──
echo "[4/7] Setting up frontend..."
cd "\$APP_DIR/frontend"
npm ci --production

if [ ! -f .env.production ]; then
  echo "VITE_API_BASE_URL=https://\$DOMAIN/api" > .env.production
  echo "VITE_WS_URL=wss://\$DOMAIN/ws" >> .env.production
fi

npm run build

# ── 5. Configure Nginx ──
echo "[5/7] Configuring Nginx..."
EXTERNAL_IP=\$(curl -s ifconfig.me)

sudo tee /etc/nginx/sites-available/capital-guard > /dev/null <<NGINX
server {
    listen 80;
    server_name \$DOMAIN \$EXTERNAL_IP _;

    root \$APP_DIR/frontend/dist;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
    gzip_min_length 256;

    location / {
        try_files \\\$uri \\\$uri/ /index.html;
    }

    location /api {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\\$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)\\\$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/capital-guard /etc/nginx/sites-enabled/capital-guard
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx

# ── 6. Start backend with PM2 ──
echo "[6/7] Starting backend with PM2..."
cd "\$APP_DIR"

cat > ecosystem.config.cjs <<'PM2'
module.exports = {
  apps: [{
    name: 'capital-guard-api',
    cwd: './server',
    script: 'dist/index.js',
    node_args: '--max-old-space-size=384',
    env: { NODE_ENV: 'production' },
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    max_memory_restart: '350M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true
  }]
};
PM2

mkdir -p logs
pm2 delete capital-guard-api 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

# ── 7. Verify ──
echo "[7/7] Verifying deployment..."
sleep 3

pm2 status

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  Deployment Complete!                      ║"
echo "╠════════════════════════════════════════════╣"
echo "║  App:     http://\$EXTERNAL_IP             "
echo "║  API:     http://\$EXTERNAL_IP/api         "
echo "║  Health:  http://\$EXTERNAL_IP/api/health  "
echo "╠════════════════════════════════════════════╣"
echo "║  Commands:                                 ║"
echo "║    pm2 status        — check status        ║"
echo "║    pm2 logs          — view logs           ║"
echo "║    pm2 restart all   — restart             ║"
echo "╚════════════════════════════════════════════╝"
DEPLOY_SCRIPT

echo ""
echo "Deployment finished! SSH into the server to add API keys:"
echo "  $SSH_CMD"
echo "  nano $REMOTE_DIR/server/.env"
echo "  pm2 restart all"
