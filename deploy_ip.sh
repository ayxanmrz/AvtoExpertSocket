#!/bin/bash

# Usage: bash deploy_ip.sh <SERVER_IP>
SERVER_IP=$1

if [ -z "$SERVER_IP" ]; then
  echo "❌ Please provide your server IP: bash deploy_ip.sh <IP>"
  exit 1
fi

echo "🚀 Starting deployment for $SERVER_IP"

# Update & install dependencies
sudo apt update -y
sudo apt install -y nginx

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
sudo tee /etc/nginx/sites-available/socket-app > /dev/null <<EOL
server {
    listen 80;
    server_name $SERVER_IP;

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
sudo ln -s /etc/nginx/sites-available/socket-app /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

echo "✅ Deployment finished!"
echo "👉 Your Socket.IO server should be available at: http://$SERVER_IP/socket.io/"
