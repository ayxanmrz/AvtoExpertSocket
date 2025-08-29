#!/bin/bash

# Usage: bash deploy.sh yourdomain.com
DOMAIN=$1

if [ -z "$DOMAIN" ]; then
  echo "❌ Please provide your domain: bash deploy.sh yourdomain.com"
  exit 1
fi

echo "🚀 Starting deployment for $DOMAIN"

# Update & install dependencies
sudo apt update -y
sudo apt install -y nginx certbot python3-certbot-nginx

# Install PM2 if not already installed
if ! command -v pm2 &> /dev/null; then
  echo "📦 Installing PM2..."
  sudo npm install -g pm2
fi

cd /root/AvtoExpertSocket || exit

# Install production deps
echo "📦 Installing npm dependencies..."
npm ci --only=production

# Start app with PM2
echo "▶️ Starting app with PM2..."
pm2 start server.js --name "socket-app"
pm2 save
pm2 startup systemd -u $USER --hp $HOME

# Nginx config
echo "⚙️ Configuring Nginx..."
sudo tee /etc/nginx/sites-available/$DOMAIN > /dev/null <<EOL
server {
    server_name $DOMAIN;

    location /socket.io/ {
        proxy_pass http://localhost:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
    }

    location / {
        return 200 "Socket.io server running";
    }
}
EOL

# Enable Nginx site
sudo ln -s /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Setup SSL
echo "🔐 Setting up SSL with Certbot..."
sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m admin@$DOMAIN

echo "✅ Deployment finished!"
echo "👉 Your Socket.IO server should be available at: https://$DOMAIN"
