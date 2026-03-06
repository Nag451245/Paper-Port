#!/bin/bash
set -e

DOMAIN="papertrade.duckdns.org"
APP_DIR="$HOME/capital-guard"

echo "============================================"
echo "  Capital Guard — HTTPS Setup"
echo "  Domain: $DOMAIN"
echo "============================================"
echo ""

# ── 1. Open port 443 in GCP firewall ──
echo "[1/6] Ensuring port 443 is open in GCP firewall..."
if gcloud compute firewall-rules describe allow-https &>/dev/null; then
  echo "  Firewall rule 'allow-https' already exists."
else
  gcloud compute firewall-rules create allow-https \
    --direction=INGRESS --priority=1000 \
    --network=default --action=ALLOW \
    --rules=tcp:443 --source-ranges=0.0.0.0/0
  echo "  Firewall rule created."
fi

# ── 2. Install certbot ──
echo "[2/6] Installing certbot..."
sudo apt install -y certbot python3-certbot-nginx

# ── 3. Get SSL certificate ──
echo "[3/6] Obtaining SSL certificate from Let's Encrypt..."
sudo certbot --nginx -d "$DOMAIN" \
  --register-unsafely-without-email --agree-tos --non-interactive

echo "  Certificate obtained. Auto-renewal is enabled via systemd timer."

# ── 4. Update nginx config for HTTPS ──
echo "[4/6] Updating nginx config..."

sudo tee /etc/nginx/sites-available/capital-guard > /dev/null <<NGINX
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name $DOMAIN;

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    root $APP_DIR/frontend/dist;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
    gzip_min_length 256;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
NGINX

sudo nginx -t
sudo systemctl restart nginx
echo "  Nginx configured for HTTPS."

# ── 5. Update frontend .env.production ──
echo "[5/6] Updating frontend environment..."
cat > "$APP_DIR/frontend/.env.production" <<ENV
VITE_API_BASE_URL=https://$DOMAIN/api
VITE_WS_URL=wss://$DOMAIN/ws
ENV

cd "$APP_DIR/frontend"
npm run build
echo "  Frontend rebuilt with HTTPS URLs."

# ── 6. Update server CORS ──
echo "[6/6] Updating server CORS..."
cd "$APP_DIR/server"

if [ -f .env ]; then
  sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=\"https://$DOMAIN\"|" .env
  echo "  CORS updated."
else
  echo "  WARNING: server/.env not found. Set CORS_ORIGINS manually."
fi

pm2 restart all
echo "  Server restarted."

echo ""
echo "============================================"
echo "  HTTPS Setup Complete!"
echo "============================================"
echo ""
echo "  Your app is now live at:"
echo "    https://$DOMAIN"
echo ""
echo "  SSL certificate auto-renews every 90 days."
echo "  Test renewal: sudo certbot renew --dry-run"
echo ""
echo "============================================"
