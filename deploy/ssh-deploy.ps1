<#
.SYNOPSIS
  Capital Guard — SSH Deployment Script (PowerShell)
  Run FROM your Windows machine to deploy via SSH.

.EXAMPLE
  .\deploy\ssh-deploy.ps1 -Host "34.100.200.50" -User "ubuntu"
  .\deploy\ssh-deploy.ps1 -Host "34.100.200.50" -User "ubuntu" -KeyFile "~\.ssh\gcp_key" -Mode setup
  .\deploy\ssh-deploy.ps1 -Host "34.100.200.50" -User "ubuntu" -Mode quick
#>

param(
    [Parameter(Mandatory)][string]$HostAddr,
    [string]$User = "ubuntu",
    [string]$KeyFile = "",
    [int]$Port = 22,
    [ValidateSet("deploy", "setup", "quick")][string]$Mode = "deploy",
    [string]$RepoUrl = "https://github.com/Nag451245/Paper-Port.git",
    [string]$Domain = "papertrade.duckdns.org",
    [string]$RemoteDir = '~/capital-guard'
)

$ErrorActionPreference = "Stop"

# Build SSH arguments
$sshArgs = @("-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", "-p", $Port)
if ($KeyFile) { $sshArgs += @("-i", $KeyFile) }
$target = "${User}@${HostAddr}"

function Invoke-SSH {
    param([string]$Script)
    $sshArgs + @($target, "bash -s") | ForEach-Object { $_ }
    $Script | ssh @sshArgs $target "bash -s"
    if ($LASTEXITCODE -ne 0) { throw "SSH command failed with exit code $LASTEXITCODE" }
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Capital Guard - SSH Deploy ($Mode)" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Host:   $target`:$Port"
Write-Host "  Remote: $RemoteDir"
Write-Host "  Repo:   $RepoUrl"
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# Test connection
Write-Host "[0] Testing SSH connection..." -ForegroundColor Yellow
$testResult = & ssh @sshArgs $target "echo SSH_OK" 2>&1
if ($testResult -notmatch "SSH_OK") {
    Write-Host "ERROR: Cannot connect to $target" -ForegroundColor Red
    exit 1
}
Write-Host "  Connected." -ForegroundColor Green
Write-Host ""

# ── SETUP MODE ──────────────────────────────────────────────
if ($Mode -eq "setup") {
    Write-Host "[SETUP] Provisioning server..." -ForegroundColor Yellow

    $setupScript = @'
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

echo "[4/8] Installing Redis..."
if ! command -v redis-cli &>/dev/null; then
  sudo apt install -y redis-server
fi
sudo systemctl enable redis-server && sudo systemctl start redis-server

echo "[5/8] Installing Nginx..."
sudo apt install -y nginx
sudo systemctl enable nginx

echo "[6/8] Installing PM2..."
if ! command -v pm2 &>/dev/null; then
  sudo npm install -g pm2
  pm2 startup systemd -u "$USER" --hp "$HOME" 2>/dev/null | grep sudo | bash 2>/dev/null || true
fi

echo "[7/8] Installing Rust toolchain..."
if ! command -v cargo &>/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi

echo "[8/8] Creating 2GB swap..."
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

sudo apt install -y git build-essential pkg-config libssl-dev

echo ""
echo "Server provisioning complete!"
'@

    $setupScript | ssh @sshArgs $target "bash -s"
    Write-Host ""
    Write-Host "Server ready. Run with -Mode deploy to deploy the app." -ForegroundColor Green
    exit 0
}

# ── QUICK MODE ──────────────────────────────────────────────
if ($Mode -eq "quick") {
    Write-Host "[QUICK DEPLOY] Pull + rebuild + restart..." -ForegroundColor Yellow

    $quickScript = @"
set -e
cd $RemoteDir

echo "[1/5] Pulling latest..."
git pull origin main

echo "[2/5] Rebuilding server..."
cd $RemoteDir/server
npm ci --production
npx prisma generate
npx prisma migrate deploy 2>/dev/null || true
npm run build

echo "[3/5] Rebuilding frontend..."
cd $RemoteDir/frontend
npm ci --production
npm run build

echo "[4/5] Rebuilding Rust engine..."
if [ -d "$RemoteDir/engine" ]; then
  cd $RemoteDir/engine
  source "`$HOME/.cargo/env" 2>/dev/null || true
  cargo build --release 2>&1 | tail -3
  cp target/release/capital-guard-engine $RemoteDir/server/bin/ 2>/dev/null || true
fi

echo "[5/5] Restarting..."
pm2 restart all
sudo systemctl reload nginx
sleep 2
pm2 status
echo "Quick deploy complete!"
"@

    $quickScript | ssh @sshArgs $target "bash -s"
    exit 0
}

# ── FULL DEPLOY MODE ───────────────────────────────────────
Write-Host "[FULL DEPLOY] Starting deployment..." -ForegroundColor Yellow

$deployScript = @"
set -e
source "`$HOME/.cargo/env" 2>/dev/null || true

APP_DIR="$RemoteDir"
REPO_URL="$RepoUrl"
DOMAIN="$Domain"

echo "[1/7] Fetching code..."
if [ -d "`$APP_DIR" ]; then
  cd "`$APP_DIR" && git pull origin main
else
  git clone "`$REPO_URL" "`$APP_DIR"
  cd "`$APP_DIR"
fi

echo "[2/7] Building Rust engine..."
if [ -d "`$APP_DIR/engine" ]; then
  cd "`$APP_DIR/engine"
  cargo build --release 2>&1 | tail -5
  mkdir -p "`$APP_DIR/server/bin"
  cp target/release/capital-guard-engine "`$APP_DIR/server/bin/"
fi

echo "[3/7] Setting up backend..."
cd "`$APP_DIR/server"
npm ci --production

if [ ! -f .env ]; then
  cp .env.example .env
  JWT_SECRET=`$(openssl rand -base64 32)
  ENCRYPTION_KEY=`$(openssl rand -base64 32)
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=\"postgresql://capitalguard:capitalguard_secure_2024@localhost:5432/capitalguard\"|" .env
  sed -i "s|^DIRECT_URL=.*|DIRECT_URL=\"postgresql://capitalguard:capitalguard_secure_2024@localhost:5432/capitalguard\"|" .env
  sed -i "s|^REDIS_URL=.*|REDIS_URL=\"redis://localhost:6379\"|" .env
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=\"`$JWT_SECRET\"|" .env
  sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=\"`$ENCRYPTION_KEY\"|" .env
  sed -i "s|^NODE_ENV=.*|NODE_ENV=\"production\"|" .env
  sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=\"https://`$DOMAIN\"|" .env
  echo "  .env created — add your API keys: nano `$APP_DIR/server/.env"
fi

npx prisma generate
npx prisma migrate deploy 2>/dev/null || {
  npx prisma migrate dev --name init --create-only 2>/dev/null || true
  npx prisma migrate deploy
}
npm run build

echo "[4/7] Setting up frontend..."
cd "`$APP_DIR/frontend"
npm ci --production
if [ ! -f .env.production ]; then
  echo "VITE_API_BASE_URL=https://`$DOMAIN/api" > .env.production
  echo "VITE_WS_URL=wss://`$DOMAIN/ws" >> .env.production
fi
npm run build

echo "[5/7] Configuring Nginx..."
EXTERNAL_IP=`$(curl -s ifconfig.me)

sudo tee /etc/nginx/sites-available/capital-guard > /dev/null <<NGINX
server {
    listen 80;
    server_name `$DOMAIN `$EXTERNAL_IP _;

    root `$APP_DIR/frontend/dist;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
    gzip_min_length 256;

    location / {
        try_files \\\`$uri \\\`$uri/ /index.html;
    }

    location /api {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \\\`$host;
        proxy_set_header X-Real-IP \\\`$remote_addr;
        proxy_set_header X-Forwarded-For \\\`$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\`$scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\\`$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \\\`$host;
        proxy_set_header X-Real-IP \\\`$remote_addr;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)\\\`$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/capital-guard /etc/nginx/sites-enabled/capital-guard
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx

echo "[6/7] Starting all services with PM2..."
cd "`$APP_DIR"

# Kill orphan processes on service ports
fuser -k 8000/tcp 2>/dev/null || true
fuser -k 8001/tcp 2>/dev/null || true
fuser -k 8002/tcp 2>/dev/null || true

cat > ecosystem.config.cjs <<'PM2'
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
      env: { RUST_LOG: 'info', ENGINE_PORT: '8080' },
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
      env: { PYTHONUNBUFFERED: '1' },
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
      env: { PYTHONUNBUFFERED: '1', ML_SERVICE_PORT: '8002' },
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
PM2

mkdir -p logs
pm2 delete all 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo "[7/7] Verifying..."
sleep 3
pm2 status

echo ""
echo "Deployment complete!"
echo "  App:  http://`$EXTERNAL_IP"
echo "  API:  http://`$EXTERNAL_IP/api/health"
echo ""
echo "  Add API keys: nano `$APP_DIR/server/.env && pm2 restart all"
"@

$deployScript | ssh @sshArgs $target "bash -s"

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  Deployment finished!" -ForegroundColor Green
Write-Host "  SSH in to add API keys:" -ForegroundColor Green
Write-Host "    ssh $($sshArgs -join ' ') $target" -ForegroundColor White
Write-Host "    nano $RemoteDir/server/.env" -ForegroundColor White
Write-Host "    pm2 restart all" -ForegroundColor White
Write-Host "================================================" -ForegroundColor Green
