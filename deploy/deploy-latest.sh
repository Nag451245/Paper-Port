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
git rev-parse --short HEAD > dist-new/version.txt     # reported by /health, checked in step 8
rm -rf dist-old; if [ -d dist ]; then mv dist dist-old; fi; mv dist-new dist; rm -rf dist-old

echo "== [5/8] Database migrations"
npx prisma migrate deploy

echo "== [6/8] Frontend"
cd "$APP/frontend"
npm ci
npx vite build --outDir dist-new --emptyOutDir
# A tab opened before this deploy still asks for the old build's page files
# ("Failed to fetch dynamically imported module"). Keep them for a week; new
# files are never overwritten (names carry a content hash).
if [ -d dist/assets ]; then
  cp -an dist/assets/. dist-new/assets/ 2>/dev/null || true
  find dist-new/assets -type f -mtime +7 -delete
fi
rm -rf dist-old; if [ -d dist ]; then mv dist dist-old; fi; mv dist-new dist; rm -rf dist-old
rm -rf node_modules

echo "== [7/8] Restart"
cd "$APP"
# Internal services listen on the server only; nginx (443) is the public entry.
if grep -q '^HOST=.*0.0.0.0' server/.env 2>/dev/null; then
  sed -i 's/^HOST=.*/HOST="127.0.0.1"/' server/.env && echo "  API now listens on 127.0.0.1 only"
fi
# The API's memory limits (ecosystem.config.cjs) only change when PM2 re-reads them.
if pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).find(x=>x.name==="capital-guard-api");process.exit(p&&Number(p.pm2_env.max_memory_restart||0)<1e9?0:1)})'; then
  pm2 delete capital-guard-api >/dev/null && pm2 start ecosystem.config.cjs --only capital-guard-api >/dev/null && pm2 save >/dev/null && echo "  API memory limits raised (2 GB heap, restart at 1.8 GB)"
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
# One manager per service. This VM once had the API started by BOTH systemd and
# PM2: at boot the systemd copy took port 8000 first and kept running old code,
# PM2's copy was restarted 222 times, and after a deploy the two swapped roles.
#  - API: PM2 runs it (memory limits, logs), so a systemd unit for it is switched off.
#  - Engine, bridge, ML service: if a systemd unit runs one, that unit keeps it
#    and is restarted here to load the new code; otherwise PM2 runs it.
#  - Anything else found running outside both is a leftover and is stopped.
for unit_file in $(grep -ls 'server/dist/index.js' /etc/systemd/system/*.service 2>/dev/null || true); do
  unit=$(basename "$unit_file")
  case "$unit" in pm2-*) continue ;; esac
  echo "  The API was also being started by systemd ($unit): switching that copy off, PM2 runs the API"
  sudo systemctl disable --now "$unit" >/dev/null 2>&1 || echo "  (could not switch off $unit)"
done
unit_of() { awk -F/ '$NF ~ /[.]service$/ { print $NF; exit }' "/proc/$1/cgroup" 2>/dev/null; }
SYSTEMD_RUNS=""
PM2_PID=$(cat ~/.pm2/pm2.pid 2>/dev/null || true)
under_pm2() {                   # is this process PM2's, directly or through a parent?
  local p=$1 n=0
  while [ -n "$p" ] && [ "$p" -gt 1 ] && [ $n -lt 8 ]; do
    [ "$p" = "$PM2_PID" ] && return 0
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' '); n=$((n + 1))
  done
  return 1
}
STRAYS=""
while read -r pid cmd; do
  [ -n "$pid" ] || continue
  case "$cmd" in
    *dist/index.js*|*capital-guard-engine*|*python*app.py*|*uvicorn*) ;;
    *) continue ;;
  esac
  case "$(sudo readlink "/proc/$pid/cwd" 2>/dev/null || true)" in "$APP"/server*|"$APP"/engine*) ;; *) continue ;; esac
  if [ -n "$PM2_PID" ] && under_pm2 "$pid"; then continue; fi
  unit=$(unit_of "$pid")
  case "$unit" in pm2-*) unit="" ;; esac
  if [ -n "$unit" ]; then
    case "$cmd" in
      *dist/index.js*)
        echo "  The API was also being started by systemd ($unit): switching that copy off, PM2 runs the API"
        sudo systemctl disable --now "$unit" >/dev/null 2>&1 || echo "  (could not switch off $unit)" ;;
      *)
        case "$cmd" in *capital-guard-engine*) svc=rust-engine ;; *uvicorn*) svc=ml-service ;; *) svc=breeze-bridge ;; esac
        case " $SYSTEMD_RUNS " in *" $svc "*) ;; *)
          echo "  $svc is run by systemd ($unit): restarting it to load the new code"
          sudo systemctl restart "$unit" || echo "  (could not restart $unit)"
          SYSTEMD_RUNS="$SYSTEMD_RUNS $svc" ;;
        esac ;;
    esac
    continue
  fi
  echo "  Stopping a leftover copy outside PM2: pid $pid  $cmd"
  STRAYS="$STRAYS $pid"
done < <(ps -eo pid=,args=)
if [ -n "$STRAYS" ]; then
  sudo kill $STRAYS 2>/dev/null || true
  sleep 3
  sudo kill -9 $STRAYS 2>/dev/null || true
fi
# Restart everything this user's PM2 runs. If PM2 has lost its list (it then
# restarts nothing and the old code keeps running), start from the config.
if ! pm2 restart all --update-env; then
  echo "  PM2 had nothing to restart: starting the services from ecosystem.config.cjs"
  pm2 start ecosystem.config.cjs
fi
# Every service has an owner, so it restarts on a crash and after a reboot.
for svc in capital-guard-api rust-engine breeze-bridge ml-service; do
  case " $SYSTEMD_RUNS " in *" $svc "*) pm2 delete "$svc" >/dev/null 2>&1 || true; continue ;; esac
  pm2 describe "$svc" >/dev/null 2>&1 && continue
  case "$svc" in
    breeze-bridge) [ -x server/breeze-bridge/venv/bin/python ] || { echo "  ($svc is not installed on this machine: skipped)"; continue; } ;;
    ml-service)    [ -x server/ml-service/venv/bin/python ]    || { echo "  ($svc is not installed on this machine: skipped)"; continue; } ;;
  esac
  echo "  $svc was not under PM2: adding it"
  pm2 start ecosystem.config.cjs --only "$svc" >/dev/null || echo "  (could not start $svc)"
done
pm2 save >/dev/null || true
sudo systemctl reload nginx
sleep 15
pm2 status

echo "== [8/8] Health"
# Confirm the API answering is the build just deployed, not a leftover copy
# (e.g. one started by a second PM2 run under sudo) still holding the port.
WANT=$(git rev-parse --short HEAD)
api_version() {
  { curl -sf -m 5 http://127.0.0.1:8000/health || true; } | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.version+" "+j.status+" pid "+j.pid)}catch{console.log("none")}})'
}
wait_for_version() {            # up to ~60 s for the API to answer with the new build
  for i in $(seq 1 20); do
    GOT=$(api_version)
    [ "${GOT%% *}" = "$WANT" ] && return 0
    sleep 3
  done
  return 1
}
listener_pid() { sudo ss -ltnpH 'sport = :8000' 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }

GOT=none
if ! wait_for_version; then
  # An older copy of the API is still answering. Find the process holding the
  # port; if it is not the one this PM2 runs, it is a leftover: stop it and
  # start the new build.
  HOLDER=$(listener_pid || true)
  MINE=$(pm2 pid capital-guard-api 2>/dev/null || true)
  echo "  The API is still answering as: $GOT (wanted $WANT)"
  if [ -n "$HOLDER" ] && [ "$HOLDER" != "$MINE" ]; then
    echo "  Port 8000 is held by another process (PM2's API pid: ${MINE:-none}):"
    ps -o user=,pid=,ppid=,lstart=,cmd= -p "$HOLDER" 2>/dev/null | sed 's/^/     /' || true
    PARENT=$(ps -o ppid= -p "$HOLDER" 2>/dev/null | tr -d ' ' || true)
    [ -n "$PARENT" ] && { echo "  started by:"; ps -o user=,pid=,cmd= -p "$PARENT" 2>/dev/null | sed 's/^/     /' || true; }
    if ps -o cmd= -p "$HOLDER" 2>/dev/null | grep -q 'dist/index.js'; then
      echo "  It is an old copy of this app: stopping it and starting the new build"
      sudo kill "$HOLDER" 2>/dev/null || true
      sleep 3
      sudo kill -9 "$HOLDER" 2>/dev/null || true
      pm2 restart capital-guard-api --update-env >/dev/null 2>&1 || pm2 start ecosystem.config.cjs --only capital-guard-api >/dev/null
      pm2 save >/dev/null || true
    fi
  elif [ -n "$MINE" ] && [ "$MINE" != "0" ]; then
    echo "  PM2's own API process did not pick up the new build: re-registering it"
    pm2 delete capital-guard-api >/dev/null 2>&1 || true
    pm2 start ecosystem.config.cjs --only capital-guard-api >/dev/null
    pm2 save >/dev/null || true
  fi
  wait_for_version || true
fi

echo "  API answering: $GOT (deployed $WANT)"
if [ "${GOT%% *}" != "$WANT" ]; then
  echo
  echo "  ############################################################"
  echo "  #  NOT LIVE: the server is still running the OLD code.      #"
  echo "  #  The website files were updated, the API was not.         #"
  echo "  ############################################################"
  echo "  Process listening on 8000:"; sudo ss -ltnp 2>/dev/null | grep ':8000 ' || echo "     (none)"
  echo "  PM2's API pid: $(pm2 pid capital-guard-api 2>/dev/null || echo none)"
  echo "  Every PM2 on this machine:"; ps -eo user,pid,lstart,cmd | grep -i 'PM2 v' | grep -v grep | sed 's/^/     /' || true
  echo "  Last lines of the API log:"; pm2 logs capital-guard-api --lines 15 --nostream 2>/dev/null | tail -20 | sed 's/^/     /' || true
  echo "  Send these lines to whoever maintains the app."
  exit 1
fi
echo
echo "Deployed $(git log --oneline -1)"
