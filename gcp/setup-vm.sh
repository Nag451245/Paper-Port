#!/bin/bash
set -e

echo "============================================"
echo "  Capital Guard — GCP VM Setup (No Docker)"
echo "============================================"
echo ""

# ── 1. System update ──
echo "[1/7] Updating system packages..."
sudo apt update && sudo apt upgrade -y

# ── 2. Install Node.js 20 ──
echo "[2/7] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
echo "  Node: $(node -v) | npm: $(npm -v)"

# ── 3. Install PostgreSQL 16 ──
echo "[3/7] Installing PostgreSQL 16..."
sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
sudo apt update
sudo apt install -y postgresql-16
sudo systemctl enable postgresql
sudo systemctl start postgresql

echo "  Setting up database and user..."
sudo -u postgres psql -c "CREATE USER capitalguard WITH PASSWORD 'capitalguard_secure_2024';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE capitalguard OWNER capitalguard;" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE capitalguard TO capitalguard;" 2>/dev/null || true
echo "  PostgreSQL ready."

# ── 4. Install Redis 7 ──
echo "[4/7] Installing Redis..."
sudo apt install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
echo "  Redis ready."

# ── 5. Install Nginx ──
echo "[5/7] Installing Nginx..."
sudo apt install -y nginx
sudo systemctl enable nginx
echo "  Nginx ready."

# ── 6. Install PM2 + build tools ──
echo "[6/7] Installing PM2 and build tools..."
sudo npm install -g pm2 typescript
pm2 startup systemd -u "$USER" --hp "/home/$USER" | tail -1 | sudo bash
echo "  PM2 ready."

# ── 7. Install Git ──
echo "[7/7] Installing Git..."
sudo apt install -y git
echo "  Git ready."

echo ""
echo "============================================"
echo "  All software installed successfully!"
echo "============================================"
echo ""
echo "  Node.js:    $(node -v)"
echo "  npm:        $(npm -v)"
echo "  PostgreSQL: $(psql --version | head -1)"
echo "  Redis:      $(redis-cli --version)"
echo "  Nginx:      $(nginx -v 2>&1)"
echo "  PM2:        $(pm2 -v)"
echo "  Git:        $(git --version)"
echo ""
echo "  Database: capitalguard"
echo "  DB User:  capitalguard"
echo "  DB Pass:  capitalguard_secure_2024"
echo ""
echo "  Next: Run ./deploy.sh to clone and deploy your app"
echo "============================================"
