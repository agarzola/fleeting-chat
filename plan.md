# fleeting-chat — Build Plan for Claude Code

## Project Overview

`fleeting-chat` is a self-contained, ephemeral video/audio/screen-share/text-chat web application designed to be spun up on demand and torn down when no longer needed. Think of it like a phone call: no accounts, no history, no persistence. You start it, share the URL with friends, use it, and kill it.

The primary use case is gaming sessions with a small group of friends (2–6 people). It runs as a single Docker container on any VPS (Linode, DigitalOcean, etc.) and exposes a web app over HTTP.

---

## Repository Structure

Create the following file tree:

```
fleeting-chat/
├── .node-version
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .env.example
├── README.md
├── start.sh
├── turnserver.conf
└── server/
    ├── package.json
    ├── yarn.lock
    ├── server.js
    └── public/
        └── index.html
```

---

## .node-version

Create a `.node-version` file in the repo root specifying Node.js 24:

```
24
```

This file is used by version managers (fnm, nodenv, etc.) to pin the Node.js version for local development.

---

## Technology Stack

- **Runtime:** Node.js 24 (Alpine-based Docker image)
- **Server framework:** Express 4
- **WebSocket / signaling:** Socket.io 4
- **WebRTC:** Native browser APIs (no server-side WebRTC library needed)
- **TURN server:** coturn (installed in the same container)
- **Frontend:** Vanilla HTML/CSS/JavaScript — single `index.html` file, no build step, no framework

---

## Dockerfile

Use a multi-stage-friendly single `Dockerfile` based on `node:24-alpine`.

Steps:
1. Install `coturn` via `apk add coturn`
2. Copy `server/package.json` and `server/yarn.lock`, then run `yarn install --frozen-lockfile --production`
3. Copy `turnserver.conf` into the image
4. Copy `start.sh` as the container entrypoint
5. Expose ports `3000` (web app), `3478/udp`, `3478/tcp`, `5349/tcp` (TURN)
6. Set `CMD ["/bin/sh", "/app/start.sh"]`

Important: The container runs both coturn and the Node.js server. Use `start.sh` to launch coturn in the background and Node in the foreground.

---

## start.sh

This script is the container entrypoint. It must:

1. Generate a random `TURN_SECRET` if the `TURN_SECRET` environment variable is not already set (use `openssl rand -hex 24`)
2. Write a resolved `turnserver.conf` to `/etc/turnserver.conf`, substituting `$TURN_SECRET` and `$PUBLIC_IP` (see TURN config section below)
3. Start coturn in the background: `turnserver -c /etc/turnserver.conf &`
4. Export `TURN_SECRET` so the Node.js process can read it
5. Start the Node.js server: `exec node /app/server.js`

The `PUBLIC_IP` environment variable should be used if set (for TURN relay). If not set, coturn will attempt to auto-detect. Document this in README.

---

## turnserver.conf

Provide a template `turnserver.conf` in the repo root. The `start.sh` script substitutes variables at runtime using `envsubst` or `sed`.

Key coturn settings:
```
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
```

If `PUBLIC_IP` is provided:
```
relay-ip=${PUBLIC_IP}
external-ip=${PUBLIC_IP}
```

---

## server/package.json

```json
{
  "name": "fleeting-chat",
  "version": "1.0.0",
  "main": "server.js",
  "dependencies": {
    "express": "^4.18.2",
    "socket.io": "^4.7.2"
  }
}
```

---

## server/server.js

### Responsibilities

1. Serve `public/index.html` for all GET requests to `/`
2. Serve static files from `public/`
3. Provide a `GET /api/turn-credentials` endpoint that returns short-lived TURN credentials
4. Run a Socket.io signaling server for WebRTC and text chat

### TURN Credentials Endpoint

`GET /api/turn-credentials`

Generate time-limited TURN credentials using the coturn shared secret mechanism:

```
username = Math.floor(Date.now() / 1000) + ttl + ":" + random_or_uuid
password = base64(HMAC-SHA1(TURN_SECRET, username))
```

Return JSON:
```json
{
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    {
      "urls": ["turn:<server_ip_or_hostname>:3478", "turn:<server_ip_or_hostname>:3478?transport=tcp"],
      "username": "<generated_username>",
      "credential": "<generated_password>"
    }
  ]
}
```

The server's own IP/hostname should be read from the `PUBLIC_IP` env var if set, otherwise fall back to the request's host header. TTL should be 24 hours (86400 seconds).

### Socket.io Signaling Events

Implement a simple room-based signaling system. There is only ever one room (no room codes needed — the session is the whole server).

**Client → Server events:**

- `join` — client announces itself; server assigns a unique peer ID and emits `peers` (list of existing peer IDs) back to the joiner, and emits `peer-joined` to all others
- `offer` — relay WebRTC SDP offer to a specific peer ID
- `answer` — relay WebRTC SDP answer to a specific peer ID
- `ice-candidate` — relay ICE candidate to a specific peer ID
- `chat-message` — broadcast a text message to all clients (include sender's display name and timestamp)
- `display-name` — client sets/updates their display name
- `leave` — client is leaving; emit `peer-left` to all others

**Server → Client events:**

- `assigned-id` — server sends the client its own peer ID after join
- `peers` — list of existing peer IDs and their display names
- `peer-joined` — a new peer has joined (includes peer ID and display name)
- `peer-left` — a peer has disconnected (includes peer ID)
- `offer` — incoming SDP offer (includes from peer ID)
- `answer` — incoming SDP answer (includes from peer ID)
- `ice-candidate` — incoming ICE candidate (includes from peer ID)
- `chat-message` — incoming chat message (includes sender name and timestamp)

Handle socket `disconnect` events the same as `leave`.

---

## server/public/index.html

This is a single self-contained HTML file. All CSS and JavaScript is inline. No external dependencies except the Socket.io client (loaded from the server itself via `/socket.io/socket.io.js`).

### Layout

Three-panel layout:

```
+--------------------------------------------------+
|  fleeting-chat            [Your name: ________] |
+-------------------+------------------------------+
|                   |                              |
|   Video Grid      |      Text Chat               |
|   (left, ~70%)    |      (right, ~30%)           |
|                   |                              |
|                   |   [scrollable message list]  |
|                   |                              |
+-------------------+------------------------------|
|  [Mute Mic] [Mute Cam] [Share Screen] [Leave]   |
+--------------------------------------------------+
```

- The video grid should be responsive and tile video elements in a CSS grid that grows as peers join
- Each video tile should show the peer's display name as an overlay label
- Your own video tile should be labeled "You" and be visually distinct (e.g., slightly smaller or bordered differently)
- Text chat panel shows messages with sender name and time; auto-scrolls to bottom on new message
- Message input is a text field + send button at the bottom of the chat panel; also submits on Enter key
- Control bar at the bottom with four buttons: Mute Mic (toggle), Mute Cam (toggle), Share Screen (toggle), Leave

### Design

- Dark theme (background `#1a1a2e` or similar dark color)
- Use a clean, minimal sans-serif font (system font stack is fine)
- Video tiles should have a dark background for when video is off
- When a user mutes their mic or cam, show a visual indicator on their tile (mic-off / cam-off icon or label)
- Mobile-friendly is a nice-to-have but not required

### JavaScript Architecture

Implement the following logical sections in the inline `<script>` block:

#### 1. State
```javascript
let localStream = null;
let screenStream = null;
let myId = null;
let myName = 'Anonymous';
const peers = {}; // peerId -> { connection: RTCPeerConnection, stream: MediaStream }
```

#### 2. Initialization
- On page load, get `localStream` via `getUserMedia({ video: true, audio: true })`
- Handle the case where getUserMedia fails (show an error message prompting them to allow camera/mic)
- Connect to Socket.io
- Fetch TURN credentials from `/api/turn-credentials`
- Show the local video stream in the local tile immediately

#### 3. Peer Connection Creation
`createPeerConnection(peerId)`:
- Create `RTCPeerConnection` with fetched ICE config
- Add all local tracks from `localStream`
- Handle `onicecandidate` → emit `ice-candidate` to server
- Handle `ontrack` → attach incoming stream to the remote peer's video tile
- Handle `onconnectionstatechange` → remove tile if failed/disconnected
- Store in `peers[peerId]`

#### 4. Joining
On `connect` to socket:
- Emit `display-name` with current name
- Emit `join`

On receiving `assigned-id`:
- Store `myId`

On receiving `peers` (list of existing peers):
- For each existing peer, create a peer connection and send an SDP offer (you are the offerer)

On receiving `peer-joined`:
- Create a video tile for the new peer
- Wait for their offer (they will initiate because they joined after you)

#### 5. Signaling Flow
- On receiving `offer`: create peer connection if not exists, set remote description, create answer, set local description, send answer back
- On receiving `answer`: set remote description on existing peer connection
- On receiving `ice-candidate`: add ICE candidate to existing peer connection

#### 6. Screen Sharing
On "Share Screen" button click:
- Call `getDisplayMedia({ video: true, audio: true })`
- Replace the video track in all existing `RTCPeerConnection`s using `sender.replaceTrack()`
- Update the local video tile to show the screen share
- On `screenStream.getVideoTracks()[0].onended`, automatically revert to camera

On stopping screen share (revert):
- Replace video track back to camera track in all peer connections
- Update local tile

#### 7. Mute Controls
- Mute Mic: toggle `localStream.getAudioTracks()[0].enabled`
- Mute Cam: toggle `localStream.getVideoTracks()[0].enabled`
- Update button labels/styles to reflect muted state

#### 8. Text Chat
On `chat-message` received from server:
- Append message to chat panel
- Auto-scroll to bottom

On send button click or Enter key:
- Emit `chat-message` with text, sender name (myName), and timestamp
- Also render it locally immediately (don't wait for echo)

#### 9. Leave
On "Leave" button click:
- Close all peer connections
- Stop all local media tracks
- Emit `leave`
- Show a "You have left the session" message or redirect to a simple goodbye screen

On `peer-left`:
- Close and remove the peer connection for that peer ID
- Remove their video tile from the grid

#### 10. Display Name
- Allow user to type their name in the input field in the header
- On change (blur or Enter), emit `display-name` to server and update the local tile label
- Broadcast name updates to peers via `display-name` event so others can update the tile label

---

## docker-compose.yml

Provide a `docker-compose.yml` for convenience:

```yaml
version: '3.8'
services:
  fleeting-chat:
    build: .
    ports:
      - "3000:3000"
      - "3478:3478/udp"
      - "3478:3478/tcp"
      - "5349:5349/tcp"
    environment:
      - PUBLIC_IP=${PUBLIC_IP:-}
      - TURN_SECRET=${TURN_SECRET:-}
    restart: unless-stopped
```

---

## .env.example

```
# Optional: set to your server's public IP for TURN relay
PUBLIC_IP=

# Optional: set a fixed TURN secret (auto-generated if not set)
TURN_SECRET=
```

---

## .dockerignore

```
node_modules
npm-debug.log
yarn-error.log
.env
.git
```

---

## README.md

Write a clear README covering:

### Quick Start

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
  -e PUBLIC_IP=your.server.ip \
  --name fleeting-chat \
  fleeting-chat

# 4. Share the URL
# Open http://your.server.ip:3000 and share with friends

# 5. Kill it when done
docker stop fleeting-chat && docker rm fleeting-chat
```

### Using docker-compose

```bash
PUBLIC_IP=your.server.ip docker compose up -d
# When done:
docker compose down
```

### Deploying on Linode / DigitalOcean

- Spin up the smallest plan ($5–6/month, 1 vCPU, 1GB RAM)
- Install Docker: `curl -fsSL https://get.docker.com | sh`
- Clone the repo, build, and run as above
- Open firewall ports: `3000/tcp`, `3478/udp`, `3478/tcp`, `5349/tcp`
- Destroy the droplet/linode when done — no data persists

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PUBLIC_IP` | Recommended | auto-detect | Server's public IP for TURN relay |
| `TURN_SECRET` | No | auto-generated | HMAC secret for TURN credentials |

### Features

- Video and audio chat for 2–6 participants
- Screen sharing (any participant can share)
- Text chat sidebar
- No accounts, no sign-up, no data stored
- Self-hosted, runs on any VPS

### Architecture Notes

- Mesh topology: each peer connects directly to every other peer
- TURN server is bundled for reliable NAT traversal
- All media is peer-to-peer after initial signaling
- The signaling server (Node.js) only brokers connection setup
- Nothing is logged or persisted

---

## Implementation Notes for Claude Code

- Use Node.js 24 (`node:24-alpine` in the Dockerfile); the `.node-version` file in the repo root should contain `24`
- Use `yarn` for all dependency installation — run `yarn install --frozen-lockfile --production` in the Dockerfile; commit `yarn.lock` to the repo
- Keep all CSS and JS inside `index.html` — no separate files
- Use `crypto` (built-in Node.js module) for HMAC-SHA1 in the TURN credentials endpoint — no extra dependencies
- Use `uuid` or just `crypto.randomUUID()` for peer IDs
- Socket.io should be version 4.x; the client script is served automatically at `/socket.io/socket.io.js`
- The TURN credential TTL window should allow for sessions up to 24 hours
- For the video grid CSS, use `display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));` so it adapts as peers join/leave
- All error states (camera denied, connection failed, peer disconnected) should be handled gracefully with user-visible feedback
- Test that the app works with 2 browser windows on the same machine before considering it done
- The app should work in Chrome, Firefox, and Edge — Safari support is a bonus