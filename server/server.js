'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();

const certPath = process.env.TLS_CERT;
const keyPath = process.env.TLS_KEY;
const server = (certPath && keyPath)
  ? https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
  : http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const TURN_SECRET = process.env.TURN_SECRET || '';
const PUBLIC_IP = process.env.PUBLIC_IP || '';
const TURN_TTL = 86400; // 24 hours

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/marked.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'marked', 'marked.min.js'));
});

// TURN credentials endpoint
app.get('/api/turn-credentials', (req, res) => {
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL;
  const username = `${expiry}:${crypto.randomUUID()}`;
  const password = crypto
    .createHmac('sha1', TURN_SECRET)
    .update(username)
    .digest('base64');

  const host = PUBLIC_IP || req.headers.host.split(':')[0];

  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: [
          `turn:${host}:3478`,
          `turn:${host}:3478?transport=tcp`,
        ],
        username,
        credential: password,
      },
    ],
  });
});

// ── Random name generation ─────────────────────────────────────────────
const ADJECTIVES = [
  'Amber', 'Ancient', 'Arcane', 'Bashful', 'Bellicose', 'Bold', 'Brisk',
  'Bronze', 'Calm', 'Clever', 'Cobalt', 'Crisp', 'Dapper', 'Daring',
  'Dusty', 'Eager', 'Electric', 'Emerald', 'Fierce', 'Fuzzy', 'Gallant',
  'Gentle', 'Golden', 'Grumpy', 'Hidden', 'Indigo', 'Ivory', 'Jade',
  'Jolly', 'Kindly', 'Lanky', 'Lofty', 'Marble', 'Mighty', 'Noble',
  'Obsidian', 'Plucky', 'Quiet', 'Rustic', 'Silver', 'Snappy', 'Snowy',
  'Spry', 'Stormy', 'Swift', 'Tawny', 'Teal', 'Timid', 'Velvet', 'Zany',
];

const NOUNS = [
  'Anchor', 'Anvil', 'Barrel', 'Biscuit', 'Cabin', 'Candle', 'Castle',
  'Chimney', 'Compass', 'Crayon', 'Depot', 'Fiddle', 'Flute', 'Fossil',
  'Furnace', 'Gadget', 'Galleon', 'Garlic', 'Hammock', 'Kettle', 'Lantern',
  'Locket', 'Mantle', 'Mitten', 'Muffin', 'Napkin', 'Noodle', 'Parcel',
  'Pillow', 'Piston', 'Pocket', 'Prism', 'Rafter', 'Raisin', 'Saddle',
  'Sofa', 'Spindle', 'Squirrel', 'Thistle', 'Thimble', 'Tinker', 'Toaster',
  'Tram', 'Trowel', 'Turnip', 'Walnut', 'Whistle', 'Widget', 'Wrench', 'Yak',
];

function randomName() {
  const adj  = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj} ${noun}`;
}

// Signaling state
// socketId -> { peerId, name }
const clients = new Map();
// peerId -> socketId
const peerToSocket = new Map();

io.on('connection', (socket) => {
  const peerId = crypto.randomUUID();
  // Assign a suggested name immediately so the client can display it
  // before the user has had a chance to type their own.
  const suggestedName = randomName();
  socket.emit('suggested-name', suggestedName);

  socket.on('join', () => {
    const name = (clients.get(socket.id) || {}).name || suggestedName;
    clients.set(socket.id, { peerId, name });
    peerToSocket.set(peerId, socket.id);

    // Tell the joiner their own ID
    socket.emit('assigned-id', peerId);

    // Send the list of existing peers to the joiner
    const existingPeers = [];
    for (const [sid, info] of clients) {
      if (sid !== socket.id) {
        existingPeers.push({ peerId: info.peerId, name: info.name });
      }
    }
    socket.emit('peers', existingPeers);

    // Tell everyone else a new peer joined
    socket.broadcast.emit('peer-joined', { peerId, name });
  });

  socket.on('display-name', (name) => {
    const info = clients.get(socket.id) || { peerId, name };
    info.name = name;
    clients.set(socket.id, info);
    // Broadcast name change so other clients can update their tile labels
    socket.broadcast.emit('peer-name-updated', { peerId: info.peerId, name });
  });

  socket.on('offer', ({ to, offer }) => {
    const targetSocketId = peerToSocket.get(to);
    if (targetSocketId) {
      const from = (clients.get(socket.id) || {}).peerId;
      io.to(targetSocketId).emit('offer', { from, offer });
    }
  });

  socket.on('answer', ({ to, answer }) => {
    const targetSocketId = peerToSocket.get(to);
    if (targetSocketId) {
      const from = (clients.get(socket.id) || {}).peerId;
      io.to(targetSocketId).emit('answer', { from, answer });
    }
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    const targetSocketId = peerToSocket.get(to);
    if (targetSocketId) {
      const from = (clients.get(socket.id) || {}).peerId;
      io.to(targetSocketId).emit('ice-candidate', { from, candidate });
    }
  });

  socket.on('chat-message', ({ text, name, timestamp }) => {
    // broadcast.emit excludes the sender (who already rendered it locally)
    socket.broadcast.emit('chat-message', { text, name, timestamp });
  });

  socket.on('screen-share-started', ({ streamId }) => {
    const info = clients.get(socket.id);
    if (info) socket.broadcast.emit('screen-share-started', { peerId: info.peerId, streamId });
  });

  socket.on('screen-share-stopped', () => {
    const info = clients.get(socket.id);
    if (info) socket.broadcast.emit('screen-share-stopped', { peerId: info.peerId });
  });

  function handleLeave() {
    const info = clients.get(socket.id);
    if (info) {
      clients.delete(socket.id);
      peerToSocket.delete(info.peerId);
      socket.broadcast.emit('peer-left', { peerId: info.peerId });
    }
  }

  socket.on('leave', handleLeave);
  socket.on('disconnect', handleLeave);
});

server.listen(PORT, () => {
  console.log(`fleeting-chat listening on port ${PORT}`);
});
