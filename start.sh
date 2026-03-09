#!/bin/sh
set -e

# Generate a random TURN secret if not provided
if [ -z "$TURN_SECRET" ]; then
  TURN_SECRET=$(openssl rand -hex 24)
fi
export TURN_SECRET

# Build the resolved turnserver.conf
CONF_OUT="/etc/turnserver.conf"

# Start with the base config, substituting TURN_SECRET
sed "s/\${TURN_SECRET}/$TURN_SECRET/g" /app/turnserver.conf > "$CONF_OUT"

# Append relay-ip and external-ip if PUBLIC_IP is set
if [ -n "$PUBLIC_IP" ]; then
  echo "relay-ip=$PUBLIC_IP" >> "$CONF_OUT"
  echo "external-ip=$PUBLIC_IP" >> "$CONF_OUT"
fi

# Start coturn in the background
turnserver -c "$CONF_OUT" &

# Start the Node.js server in the foreground
exec node /app/server.js
