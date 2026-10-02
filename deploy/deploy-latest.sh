#!/bin/bash
# Deploy the latest code from GitHub on the GCP VM.
#
#   ~/deploy-latest.sh            # deploy main
#   ~/deploy-latest.sh <branch>   # deploy another branch
#
# Stops at the first error. Until step 7 the running app is untouched, so a
# failed test or build leaves the live site exactly as it was.
set -euo pipefail
BRANCH="${1:-main}"
APP=~/capital-guard
UNIVERSE=engine/data/nse_universe.json
cd "$APP"

echo "== [1/8] Get $BRANCH from GitHub"
# The engine rewrites its stock list while it runs; keep the VM's copy.
cp "$UNIVERSE" /tmp/nse_universe.vm.json 2>/dev/null || true
git checkout -- "$UNIVERSE" 2>/dev/null || true
if [ -n "$(git status --porcelain --untracked-files=no -- . ':!server/dist' ':!frontend/dist' ':!engine/data')" ]; then
  echo "STOP: code was edited directly on the VM:"; git status --short --untracked-files=no; exit 1
fi
PREV=$(git log --oneline -1)
git fetch origin
git checkout -f -B "$BRANCH" "origin/$BRANCH"
cp /tmp/nse_universe.vm.json "$UNIVERSE" 2>/dev/null || true
echo "   was: $PREV"
echo "   now: $(git log --oneline -1)"

echo "== [2/8] Back up the database"
mkdir -p ~/backups
DB_URL=$(grep -E '^DATABASE_URL=' server/.env | cut -d= -f2- | tr -d '"' | sed 's/?.*//')
pg_dump "$DB_URL" | gzip > ~/backups/db-$(date +%F-%H%M).sql.gz
ls -lh ~/backups | tail -1

echo "== [3/8] Rust engine: test, build, swap in"
source ~/.cargo/env
cd "$APP/engine"
cargo test --release
cargo build --release
cp target/release/capital-guard-engine "$APP/server/bin/capital-guard-engine.new"
mv -f "$APP/server/bin/capital-guard-engine.new" "$APP/server/bin/capital-guard-engine"

echo "== [4/8] Backend"
cd "$APP/server"
npm ci
npm run build

echo "== [5/8] Database migrations"
npx prisma migrate deploy

echo "== [6/8] Frontend"
cd "$APP/frontend"
npm ci
npx vite build
rm -rf node_modules

echo "== [7/8] Restart"
cd "$APP"
pm2 restart all --update-env
sudo systemctl reload nginx
sleep 15
pm2 status

echo "== [8/8] Health"
curl -sf http://localhost:8000/api/health | head -c 300 && echo || echo "API NOT HEALTHY: run  pm2 logs capital-guard-api --lines 50"
echo
echo "Deployed $(git log --oneline -1)"
