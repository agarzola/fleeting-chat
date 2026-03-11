#!/bin/sh
set -e

IP=$1

# ── Wait for cloud-init to finish before touching apt ────────────────────
cloud-init status --wait

# ── System packages ──────────────────────────────────────────────────────
apt-get update -q
apt-get install -y -q curl coturn openssl

# Install Node.js 22 via NodeSource
if ! command -v node > /dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q nodejs
fi

# ── App dependencies ─────────────────────────────────────────────────────
cd /app/fleeting-chat/server
npm install --omit=dev

# ── TLS certificate (self-signed, 1-day) ────────────────────────────────
openssl req -x509 -newkey rsa:2048 \
  -keyout /etc/fleeting-chat-key.pem \
  -out /etc/fleeting-chat-cert.pem \
  -days 1 -nodes -subj "/CN=${IP}"

# ── coturn ───────────────────────────────────────────────────────────────
TURN_SECRET=$(openssl rand -hex 24)

cat > /etc/turnserver.conf << CONF
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=${TURN_SECRET}
realm=fleeting-chat
total-quota=100
stale-nonce=600
no-multicast-peers
no-cli
log-file=/dev/stdout
relay-ip=${IP}
external-ip=${IP}
CONF

echo 'TURNSERVER_ENABLED=1' > /etc/default/coturn
systemctl restart coturn

# ── fleeting-chat systemd service ────────────────────────────────────────
cat > /etc/systemd/system/fleeting-chat.service << SERVICE
[Unit]
Description=fleeting-chat
After=network.target

[Service]
Environment="PORT=443"
Environment="PUBLIC_IP=${IP}"
Environment="TURN_SECRET=${TURN_SECRET}"
Environment="TLS_CERT=/etc/fleeting-chat-cert.pem"
Environment="TLS_KEY=/etc/fleeting-chat-key.pem"
WorkingDirectory=/app/fleeting-chat/server
ExecStart=/usr/bin/node server.js
Restart=always
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable fleeting-chat
systemctl restart fleeting-chat

echo "Setup complete. App running at https://${IP}"
