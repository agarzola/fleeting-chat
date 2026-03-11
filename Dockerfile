FROM node:24-alpine

# Install coturn and envsubst (gettext)
RUN apk add --no-cache coturn openssl

WORKDIR /app

# Install Node dependencies
COPY server/package.json server/yarn.lock ./
RUN yarn install --frozen-lockfile --production

# Copy application files
COPY server/server.js ./
COPY server/public/ ./public/
COPY turnserver.conf ./
COPY start.sh ./
RUN chmod +x /app/start.sh

# Web app
EXPOSE 3000
# TURN/STUN
EXPOSE 3478/udp
EXPOSE 3478/tcp
EXPOSE 5349/tcp

CMD ["/bin/sh", "/app/start.sh"]
