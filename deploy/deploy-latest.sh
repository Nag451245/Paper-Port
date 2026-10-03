#!/bin/bash
# Deploy the latest code from GitHub on the GCP VM.
#
#   ~/deploy-latest.sh            # deploy main
#   ~/deploy-latest.sh <branch>   # deploy another branch
#
# Stops at the first error. Until step 7 the running app is untouched, so a
# failed test or build leaves the live site exactly as it was.
#
# Builds go to a side folder and are swapped in only when complete, so the
# site never serves a half-built, missing or out-of-date copy mid-deploy.
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
# Keep the builds that are serving the site right now. Older commits tracked a
# stale copy of these folders in Git, and switching commits put that old
# website back on the live site until the new build finished.
rm -rf /tmp/pp-live && mkdir -p /tmp/pp-live
if [ -d frontend/dist ]; then cp -a frontend/dist /tmp/pp-live/frontend-dist; fi
if [ -d server/dist ]; then cp -a server/dist /tmp/pp-live/server-dist; fi
git fetch origin
git checkout -f -B "$BRANCH" "origin/$BRANCH"
cp /tmp/nse_universe.vm.json "$UNIVERSE" 2>/dev/null || true
if [ -d /tmp/pp-live/frontend-dist ]; then rm -rf frontend/dist; cp -a /tmp/pp-live/frontend-dist frontend/dist; fi
if [ -d /tmp/pp-live/server-dist ]; then rm -rf server/dist; cp -a /tmp/pp-live/server-dist server/dist; fi
echo "   was: $PREV"
echo "   now: $(git log --oneline -1)"

echo "== [2/8] Back up the database"
chmod +x deploy/backup-db.sh
deploy/backup-db.sh
# Nightly at 02:00 server time, keeping 14 days (installed once, kept up to date).
( crontab -l 2>/dev/null | grep -v 'backup-db.sh' || true ; echo "0 2 * * * $APP/deploy/backup-db.sh >> $HOME/backups/backup.log 2>&1" ) | crontab -

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
npx prisma generate
npx tsc --outDir dist-new
rm -rf dist-old; if [ -d dist ]; then mv dist dist-old; fi; mv dist-new dist; rm -rf dist-old

echo "== [5/8] Database migrations"
npx prisma migrate deploy

echo "== [6/8] Frontend"
cd "$APP/frontend"
npm ci
npx vite build --outDir dist-new --emptyOutDir
rm -rf dist-old; if [ -d dist ]; then mv dist dist-old; fi; mv dist-new dist; rm -rf dist-old
rm -rf node_modules

echo "== [7/8] Restart"
cd "$APP"
# Internal services listen on the server only; nginx (443) is the public entry.
if grep -q '^HOST=.*0.0.0.0' server/.env 2>/dev/null; then
  sed -i 's/^HOST=.*/HOST="127.0.0.1"/' server/.env && echo "  API now listens on 127.0.0.1 only"
fi
if pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).find(x=>x.name==="ml-service");process.exit(p&&String(p.pm2_env.args).includes("0.0.0.0")?0:1)})'; then
  pm2 delete ml-service >/dev/null && pm2 start ecosystem.config.cjs --only ml-service >/dev/null && pm2 save >/dev/null && echo "  ML service now listens on 127.0.0.1 only"
fi
# Rotate PM2 logs so they cannot fill the disk again (unrotated logs once reached
# 14 GB and stopped SSH logins). Installed once; settings re-applied every deploy.
pm2 describe pm2-logrotate >/dev/null 2>&1 || pm2 install pm2-logrotate >/dev/null 2>&1 || echo "  (could not install pm2-logrotate)"
pm2 set pm2-logrotate:max_size 50M >/dev/null 2>&1 || true
pm2 set pm2-logrotate:retain 7 >/dev/null 2>&1 || true
pm2 set pm2-logrotate:compress true >/dev/null 2>&1 || true
pm2 restart all --update-env
sudo systemctl reload nginx
sleep 15
pm2 status

echo "== [8/8] Health"
curl -sf http://localhost:8000/api/health | head -c 300 && echo || echo "API NOT HEALTHY: run  pm2 logs capital-guard-api --lines 50"
echo
echo "Deployed $(git log --oneline -1)"
