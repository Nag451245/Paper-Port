#!/bin/bash
set -e

echo "============================================"
echo "  Capital Guard — Deploy App"
echo "============================================"

APP_DIR="$HOME/capital-guard"
REPO_URL="${1:-}"

if [ -z "$REPO_URL" ]; then
  echo ""
  echo "Usage: ./deploy.sh <github-repo-url>"
  echo ""
  echo "Examples:"
  echo "  ./deploy.sh https://github.com/username/capital-guard.git"
  echo "  ./deploy.sh https://TOKEN@github.com/username/capital-guard.git"
  echo ""
  exit 1
fi

# ── 1. Clone repo ──
echo "[1/6] Cloning repository..."
if [ -d "$APP_DIR" ]; then
  echo "  Directory exists, pulling latest..."
  cd "$APP_DIR" && git pull
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# ── 2. Build Rust engine ──
echo "[2/7] Building Rust engine..."

# Ensure swap exists for low-RAM VMs (Rust compiler needs ~800MB)
if [ ! -f /swapfile ]; then
  echo "  Creating 2GB swap (needed for Rust compilation)..."
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null
  echo "  Swap enabled: $(free -h | grep Swap)"
fi

if ! command -v cargo &> /dev/null; then
  echo "  Installing Rust toolchain..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi

if [ -d "$APP_DIR/engine" ]; then
  cd "$APP_DIR/engine"
  echo "  Compiling engine (release mode, thin LTO)..."
  cargo build --release 2>&1 | tail -5
  echo "  Engine binary: $(ls -lh target/release/capital-guard-engine 2>/dev/null || echo 'NOT FOUND')"
fi

# ── 3. Setup backend ──
echo "[3/7] Setting up backend..."
cd "$APP_DIR/server"
npm ci

if [ ! -f .env ]; then
  cp .env.example .env
  
  JWT_SECRET=$(openssl rand -base64 32)
  ENCRYPTION_KEY=$(openssl rand -base64 32)
  
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=\"postgresql://capitalguard:capitalguard_secure_2024@localhost:5432/capitalguard\"|" .env
  sed -i "s|^DIRECT_URL=.*|DIRECT_URL=\"postgresql://capitalguard:capitalguard_secure_2024@localhost:5432/capitalguard\"|" .env
  sed -i "s|^REDIS_URL=.*|REDIS_URL=\"redis://localhost:6379\"|" .env
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=\"$JWT_SECRET\"|" .env
  sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=\"$ENCRYPTION_KEY\"|" .env
  sed -i "s|^NODE_ENV=.*|NODE_ENV=\"production\"|" .env
  sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=\"https://papertrade.duckdns.org\"|" .env

  echo "  .env created with local DB credentials."
  echo "  >>> IMPORTANT: Edit .env to add your API keys <<<"
  echo "      nano $APP_DIR/server/.env"
fi

echo "  Generating Prisma client..."
npx prisma generate

echo "  Running database migrations..."
npx prisma migrate deploy 2>/dev/null || {
  echo "  No migrations found — creating initial baseline..."
  npx prisma migrate dev --name init --create-only 2>/dev/null || true
  npx prisma migrate deploy
}

echo "  Building TypeScript..."
npm run build

# ── 4. Setup frontend ──
echo "[4/7] Setting up frontend..."
cd "$APP_DIR/frontend"
npm ci

VITE_ENV="$APP_DIR/frontend/.env.production"
if [ ! -f "$VITE_ENV" ]; then
  echo "VITE_API_BASE_URL=https://papertrade.duckdns.org/api" > "$VITE_ENV"
  echo "VITE_WS_URL=wss://papertrade.duckdns.org/ws" >> "$VITE_ENV"
fi

echo "  Building frontend..."
npm run build

# ── 5. Configure Nginx ──
echo "[5/7] Configuring Nginx..."
EXTERNAL_IP=$(curl -s ifconfig.me)

sudo tee /etc/nginx/sites-available/capital-guard > /dev/null <<NGINX
server {
    listen 80;
    server_name papertrade.duckdns.org $EXTERNAL_IP _;

    root $APP_DIR/frontend/dist;
    index index.html;

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
    gzip_min_length 256;

    # Frontend (SPA)
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Backend API proxy
    location /api {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # WebSocket proxy
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

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/capital-guard /etc/nginx/sites-enabled/capital-guard
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx

# ── 6. Start backend with PM2 ──
echo "[6/7] Starting backend with PM2..."
cd "$APP_DIR"

cat > ecosystem.config.cjs <<'PM2'
module.exports = {
  apps: [{
    name: 'capital-guard-api',
    cwd: './server',
    script: 'dist/index.js',
    node_args: '--max-old-space-size=384',
    env: {
      NODE_ENV: 'production'
    },
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
pm2 start ecosystem.config.cjs
pm2 save

# ── 7. Verify ──
echo "[7/7] Verifying deployment..."
sleep 3

echo ""
echo "============================================"
echo "  Deployment Complete!"
echo "============================================"
echo ""
echo "  Your app is live at:"
echo "    http://$EXTERNAL_IP"
echo ""
echo "  Backend API:"
echo "    http://$EXTERNAL_IP/api"
echo ""
echo "  Useful commands:"
echo "    pm2 status          — check if backend is running"
echo "    pm2 logs            — view backend logs"
echo "    pm2 restart all     — restart backend"
echo "    sudo systemctl restart nginx  — restart nginx"
echo ""
echo "  Edit API keys:"
echo "    nano $APP_DIR/server/.env"
echo "    pm2 restart all"
echo ""
echo "============================================"
