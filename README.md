# fleeting-chat

A self-contained, ephemeral video/audio/screen-share/text-chat web app. No accounts, no history, no persistence. Spin it up, share the URL, use it, kill it.

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/you/fleeting-chat
cd fleeting-chat

# 2. Build the image
docker build -t fleeting-chat .

# 3. Run it (replace with your server's public IP)
docker run -d \
  -p 3000:3000 \
  -p 3478:3478/udp \
  -p 3478:3478/tcp \
  -p 5349:5349/tcp \
  -e PUBLIC_IP=your.server.ip \
  --name fleeting-chat \
  fleeting-chat

# 4. Share the URL
# Open http://your.server.ip:3000 and share with friends

# 5. Kill it when done
docker stop fleeting-chat && docker rm fleeting-chat
```

## Using docker-compose

```bash
PUBLIC_IP=your.server.ip docker compose up -d

# When done:
docker compose down
```

## Deploying on Linode / DigitalOcean

1. Spin up the smallest plan ($5–6/month, 1 vCPU, 1GB RAM)
2. Install Docker: `curl -fsSL https://get.docker.com | sh`
3. Clone the repo, build, and run as above
4. Open firewall ports: `3000/tcp`, `3478/udp`, `3478/tcp`, `5349/tcp`
5. Destroy the droplet/linode when done — no data persists

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PUBLIC_IP` | Recommended | auto-detect | Server's public IP for TURN relay |
| `TURN_SECRET` | No | auto-generated | HMAC secret for TURN credentials |

`PUBLIC_IP` should be set to your VPS's public IP address for reliable TURN relay. Without it, coturn will attempt auto-detection, which may not work in all environments.

## Features

- Video and audio chat for 2–6 participants
- Screen sharing (any participant can share)
- Text chat sidebar
- No accounts, no sign-up, no data stored
- Self-hosted, runs on any VPS

## Architecture Notes

- **Mesh topology**: each peer connects directly to every other peer via WebRTC
- **TURN server**: coturn is bundled in the same container for reliable NAT traversal
- **All media is peer-to-peer** after initial signaling through the Node.js server
- **Signaling server** only brokers connection setup (offers, answers, ICE candidates)
- **Nothing is logged or persisted** — the server holds only in-memory state for active sessions

## Local Development

```bash
cd server
yarn install
node server.js
# Open http://localhost:3000
```

Note: Without a TURN server, connections will use STUN only (Google's public STUN server). This works fine on a local network or when both peers are on the same machine.
