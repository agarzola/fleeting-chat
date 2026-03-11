// ── Markdown / link rendering ───────────────────────────────────────────
marked.use({
  gfm: true,    // GitHub Flavoured Markdown (tables, strikethrough, etc.)
  breaks: true, // newlines → <br>
  hooks: {
    // Escape < before tokenizing so raw HTML tags are rendered as literal
    // text rather than executed. This prevents script injection while leaving
    // all markdown syntax intact (> blockquotes use >, not <).
    preprocess(src) {
      return src.replace(/</g, '&lt;');
    },
  },
  renderer: {
    // Open all links in a new tab with safe rel attributes
    link({ href, title, text }) {
      const t = title ? ` title="${escapeAttr(title)}"` : '';
      return `<a href="${escapeAttr(href)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderMarkdown(text) {
  return marked.parse(text);
}

// ── State ──────────────────────────────────────────────────────────────
let localStream = null;
let screenStream = null;
let myId = null;
let myName = 'Anonymous';
let iceConfig = null;
let mirrorEnabled = true;
let cameraInitDone = false;
let cameraRequestInFlight = false;
let micMuted = false;
let camMuted = false;
let sharingScreen = false;
let pinnedTileId = null;

// peerId -> { connection: RTCPeerConnection }
const peers = {};
// peerId -> RTCDataChannel
const dataChannels = {};
// peerId -> display name (for labeling screen share tiles)
const peerNames = {};
// peerId -> stream ID of their screen share (so ontrack can identify it)
const peerScreenStreamIds = {};
// peerId -> RTCRtpSender for the screen track we are sending to that peer
const screenSenders = {};

// ── DOM refs ───────────────────────────────────────────────────────────
const videoGrid    = document.getElementById('video-grid');
const chatMessages = document.getElementById('chat-messages');
const chatInput    = document.getElementById('chat-input');
const sendBtn      = document.getElementById('send-btn');
const nameInput    = document.getElementById('name-input');
const muteMicBtn   = document.getElementById('mute-mic-btn');
const muteCamBtn   = document.getElementById('mute-cam-btn');
const shareScreenBtn = document.getElementById('share-screen-btn');
const leaveBtn     = document.getElementById('leave-btn');
const overlay      = document.getElementById('overlay');
const cameraError  = document.getElementById('camera-error');
const enableCameraBtn = document.getElementById('enable-camera-btn');
const settingsBtn  = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const mirrorToggle = document.getElementById('mirror-toggle');

// ── Settings panel ─────────────────────────────────────────────────────
settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPanel.classList.toggle('open');
});
document.addEventListener('click', () => settingsPanel.classList.remove('open'));
settingsPanel.addEventListener('click', (e) => e.stopPropagation());

mirrorToggle.addEventListener('change', () => {
  mirrorEnabled = mirrorToggle.checked;
  const localTile = document.getElementById('tile-local');
  if (localTile) localTile.querySelector('video').classList.toggle('mirrored', mirrorEnabled);
});

const chatPanel = document.getElementById('chat-panel');
const chatToggle = document.getElementById('chat-toggle');
chatToggle.addEventListener('change', () => {
  chatPanel.classList.toggle('hidden', !chatToggle.checked);
});

// ── Pin ────────────────────────────────────────────────────────────────
function pinTile(id) {
  if (pinnedTileId === id) return;
  unpinTile(); // unpin any current
  pinnedTileId = id;
  const tile = document.getElementById('tile-' + id);
  if (!tile) return;
  tile.classList.add('pinned');
  videoGrid.classList.add('has-pinned');
  videoGrid.prepend(tile); // move to front so it appears at top
  updatePinBtn(tile, true);
}

function unpinTile() {
  if (!pinnedTileId) return;
  const tile = document.getElementById('tile-' + pinnedTileId);
  if (tile) {
    tile.classList.remove('pinned');
    updatePinBtn(tile, false);
  }
  videoGrid.classList.remove('has-pinned');
  pinnedTileId = null;
}

function togglePin(id) {
  if (pinnedTileId === id) unpinTile();
  else pinTile(id);
}

function updatePinBtn(tile, pinned) {
  const btn = tile.querySelector('.pin-btn');
  if (btn) btn.textContent = pinned ? '📌 Unpin' : '📌 Pin';
}

// ── Video tiles ────────────────────────────────────────────────────────
function createTile(id, label, isLocal) {
  const tile = document.createElement('div');
  tile.className = 'video-tile' + (isLocal ? ' local-tile' : '');
  tile.id = 'tile-' + id;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) {
    video.muted = true;
    if (mirrorEnabled) video.classList.add('mirrored');
  }

  const pinBtn = document.createElement('button');
  pinBtn.className = 'pin-btn';
  pinBtn.textContent = '📌 Pin';
  pinBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't bubble to tile
    togglePin(id);
  });

  const lbl = document.createElement('div');
  lbl.className = 'tile-label';
  lbl.textContent = label;
  lbl.id = 'label-' + id;

  const indicators = document.createElement('div');
  indicators.className = 'tile-indicators';

  const micOff = document.createElement('span');
  micOff.className = 'indicator';
  micOff.id = 'mic-indicator-' + id;
  micOff.textContent = '🔇';

  const camOff = document.createElement('span');
  camOff.className = 'indicator';
  camOff.id = 'cam-indicator-' + id;
  camOff.textContent = '📵';

  indicators.appendChild(micOff);
  indicators.appendChild(camOff);
  tile.appendChild(video);
  tile.appendChild(pinBtn);
  tile.appendChild(lbl);
  tile.appendChild(indicators);
  videoGrid.appendChild(tile);
  return tile;
}

function removeTile(id) {
  if (pinnedTileId === id) unpinTile();
  const tile = document.getElementById('tile-' + id);
  if (tile) tile.remove();
}

function setTileStream(id, stream) {
  const tile = document.getElementById('tile-' + id);
  if (!tile) return;
  const video = tile.querySelector('video');
  video.srcObject = stream;
  if (id === 'local') video.muted = true;
}

function setTileLabel(id, label) {
  const el = document.getElementById('label-' + id);
  if (el) el.textContent = label;
}

// ── Camera access ──────────────────────────────────────────────────────
function handleCameraError(e) {
  const secure = window.isSecureContext ? '' : ' (page is not in a secure context)';
  console.error('[camera] getUserMedia failed — name:', e.name, '| message:', e.message, e);
  if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
    showCameraError(`Camera/mic access was denied${secure}. Grant permission in your browser settings, then click "Enable Camera & Mic".`);
  } else if (e.name === 'NotFoundError') {
    showCameraError('No camera or microphone found. You can still use text chat.');
  } else {
    showCameraError(`Could not access camera/mic [${e.name}: ${e.message}]${secure}. You can still use text chat.`);
  }
}

const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

async function requestCameraOnLoad() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  console.log('[camera] auto-requesting on load; isSecureContext:', window.isSecureContext);
  let stream;
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 5000)
    );
    stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({ video: true, audio: AUDIO_CONSTRAINTS }),
      timeout,
    ]);
  } catch (e) {
    if (e.name !== 'TimeoutError') handleCameraError(e);
    showCameraError('Camera/mic access needed. Click "Enable Camera & Mic" to grant access.');
    return;
  }
  await applyLocalStream(stream);
}

async function requestCameraOnClick() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraError('Your browser does not support camera/mic access (try Chrome, Firefox, or Edge).');
    return;
  }
  if (cameraRequestInFlight) return;
  cameraRequestInFlight = true;

  enableCameraBtn.textContent = 'Waiting for permission…';
  enableCameraBtn.disabled = true;
  console.log('[camera] user-initiated request; isSecureContext:', window.isSecureContext);

  const hintTimer = setTimeout(() => {
    showCameraError('Check your browser\'s address bar or a permission popup for a camera/mic request, then click Allow.');
  }, 4000);

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: AUDIO_CONSTRAINTS });
  } catch (e) {
    handleCameraError(e);
    clearTimeout(hintTimer);
    enableCameraBtn.textContent = 'Enable Camera & Mic';
    enableCameraBtn.disabled = false;
    cameraRequestInFlight = false;
    return;
  }

  clearTimeout(hintTimer);
  enableCameraBtn.textContent = 'Enable Camera & Mic';
  enableCameraBtn.disabled = false;
  cameraRequestInFlight = false;
  await applyLocalStream(stream);
}

async function applyLocalStream(stream) {
  console.log('[camera] access granted');
  localStream = stream;
  hideCameraError();

  const existingTile = document.getElementById('tile-local');
  if (!existingTile) {
    createTile('local', 'You', true);
  } else {
    existingTile.querySelector('video').classList.toggle('mirrored', mirrorEnabled);
  }
  // Video-only stream for local display — no audio to play back
  setTileStream('local', new MediaStream(localStream.getVideoTracks()));

  // Add tracks to any existing peer connections (late camera grant scenario)
  for (const [pid, { connection }] of Object.entries(peers)) {
    let trackAdded = false;
    localStream.getTracks().forEach(track => {
      const alreadySending = connection.getSenders().some(s => s.track === track);
      if (!alreadySending) { connection.addTrack(track, localStream); trackAdded = true; }
    });
    if (trackAdded) {
      // Renegotiate since we added tracks
      connection.createOffer()
        .then(offer => connection.setLocalDescription(offer).then(() =>
          socket.emit('offer', { to: pid, offer })))
        .catch(console.error);
    }
  }
}

function showCameraError(msg) {
  document.getElementById('camera-error-banner').innerHTML =
    '<strong>Camera / mic not available.</strong>' + `<span>${msg}</span>`;
  cameraError.classList.add('visible');
}

function hideCameraError() { cameraError.classList.remove('visible'); }

enableCameraBtn.addEventListener('click', () => requestCameraOnClick());

// ── ICE config ─────────────────────────────────────────────────────────
async function fetchIceConfig() {
  try {
    const res = await fetch('/api/turn-credentials');
    iceConfig = await res.json();
  } catch (e) {
    iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  }
}

// ── Peer connection ────────────────────────────────────────────────────
function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(iceConfig);

  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('ice-candidate', { to: peerId, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    const stream = e.streams[0];
    if (!stream) return;
    // Determine whether this is the peer's screen share or their camera
    if (peerScreenStreamIds[peerId] === stream.id) {
      setTileStream('screen-' + peerId, stream);
    } else {
      setTileStream(peerId, stream);
    }
  };

  pc.ondatachannel = (e) => { setupDataChannel(peerId, e.channel); };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      cleanupPeer(peerId);
    }
  };

  peers[peerId] = { connection: pc };
  return pc;
}

function cleanupPeer(peerId) {
  if (peers[peerId]) {
    peers[peerId].connection.close();
    delete peers[peerId];
  }
  delete dataChannels[peerId];
  delete peerNames[peerId];
  delete peerScreenStreamIds[peerId];
  delete screenSenders[peerId];
  removeTile('screen-' + peerId); // remove screen share tile if present
  removeTile(peerId);
}

function setupDataChannel(peerId, dc) {
  dataChannels[peerId] = dc;
  dc.onmessage = (e) => {
    const { text, name, timestamp } = JSON.parse(e.data);
    appendChatMessage(name, text, timestamp);
  };
  dc.onclose = () => { delete dataChannels[peerId]; };
}

// ── Socket.io ──────────────────────────────────────────────────────────
const socket = io();

function joinSession() {
  socket.emit('display-name', myName);
  socket.emit('join');
}

socket.on('connect', () => { if (cameraInitDone) joinSession(); });

socket.on('suggested-name', (name) => {
  // Pre-fill the name input; user can clear and retype their own
  myName = name;
  nameInput.value = name;
});

socket.on('assigned-id', (id) => { myId = id; });

socket.on('peers', async (existingPeers) => {
  for (const { peerId, name } of existingPeers) {
    peerNames[peerId] = name;
    createTile(peerId, name, false);
    const pc = createPeerConnection(peerId);
    setupDataChannel(peerId, pc.createDataChannel('chat'));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: peerId, offer });
  }
});

socket.on('peer-joined', ({ peerId, name }) => {
  peerNames[peerId] = name;
  createTile(peerId, name, false);
});

socket.on('offer', async ({ from, offer }) => {
  if (!peers[from]) createPeerConnection(from);
  const pc = peers[from].connection;
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { to: from, answer });
});

socket.on('answer', async ({ from, answer }) => {
  if (peers[from]) await peers[from].connection.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  if (peers[from]) {
    try { await peers[from].connection.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { /* stale candidate, ignore */ }
  }
});

socket.on('peer-left', ({ peerId }) => { cleanupPeer(peerId); });

socket.on('peer-name-updated', ({ peerId, name }) => {
  peerNames[peerId] = name;
  setTileLabel(peerId, name);
  // Update screen share tile label too if they're currently sharing
  setTileLabel('screen-' + peerId, name + "'s Screen");
});

socket.on('screen-share-started', ({ peerId, streamId }) => {
  peerScreenStreamIds[peerId] = streamId;
  const name = (peerNames[peerId] || 'Someone') + "'s Screen";
  // Create tile for the incoming screen share and auto-pin it
  if (!document.getElementById('tile-screen-' + peerId)) {
    createTile('screen-' + peerId, name, false);
  }
  pinTile('screen-' + peerId);
});

socket.on('screen-share-stopped', ({ peerId }) => {
  delete peerScreenStreamIds[peerId];
  removeTile('screen-' + peerId);
});

// ── Chat ───────────────────────────────────────────────────────────────
function appendChatMessage(name, text, timestamp) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Sender name is plain text (escaped); message body is Markdown-rendered.
  // marked sanitises HTML in the input by default, so XSS is handled.
  div.innerHTML =
    `<span class="sender">${escapeHtml(name)}</span>` +
    `<span class="time">${time}</span><br>` +
    `<span class="body">${renderMarkdown(text)}</span>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  const timestamp = Date.now();
  const msg = JSON.stringify({ text, name: myName, timestamp });
  for (const dc of Object.values(dataChannels)) {
    if (dc.readyState === 'open') dc.send(msg);
  }
  appendChatMessage(myName, text, timestamp);
  resetChatInput();
}

function resetChatInput() {
  chatInput.value = '';
  chatInput.style.height = 'auto';
}

// Auto-grow textarea as the user types
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
});

sendBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault(); // don't insert a newline on plain Enter
    sendChatMessage();
  }
  // Shift+Enter falls through and inserts a newline naturally
});

// ── Display name ───────────────────────────────────────────────────────
function applyName() {
  const val = nameInput.value.trim();
  myName = val || 'Anonymous';
  socket.emit('display-name', myName);
  setTileLabel('local', 'You (' + myName + ')');
}

nameInput.addEventListener('blur', applyName);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });

// ── Mute controls ──────────────────────────────────────────────────────
muteMicBtn.addEventListener('click', () => {
  if (!localStream) return;
  micMuted = !micMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !micMuted; });
  muteMicBtn.textContent = micMuted ? 'Unmute Mic' : 'Mute Mic';
  muteMicBtn.classList.toggle('muted', micMuted);
});

muteCamBtn.addEventListener('click', () => {
  if (!localStream) return;
  camMuted = !camMuted;
  localStream.getVideoTracks().forEach(t => { t.enabled = !camMuted; });
  muteCamBtn.textContent = camMuted ? 'Unmute Cam' : 'Mute Cam';
  muteCamBtn.classList.toggle('muted', camMuted);
});

// ── Screen sharing ─────────────────────────────────────────────────────
shareScreenBtn.addEventListener('click', async () => {
  if (sharingScreen) stopScreenShare();
  else await startScreenShare();
});

async function startScreenShare() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (e) {
    if (e.name !== 'NotAllowedError') console.error('Screen share error:', e);
    return;
  }

  const screenTrack = screenStream.getVideoTracks()[0];
  // Dedicated MediaStream so the stream ID uniquely identifies the screen share
  const ssStream = new MediaStream([screenTrack]);

  // Signal peers BEFORE adding the track so peerScreenStreamIds is populated
  // before the renegotiated track arrives on their end.
  socket.emit('screen-share-started', { streamId: ssStream.id });

  // Add screen track to every existing peer connection and renegotiate
  for (const [pid, { connection }] of Object.entries(peers)) {
    screenSenders[pid] = connection.addTrack(screenTrack, ssStream);
    try {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      socket.emit('offer', { to: pid, offer });
    } catch (e) { console.error('Screen share renegotiation error:', e); }
  }

  // Create a local tile for the screen share (no mirror, no local-tile border)
  createTile('screen-local', 'Your Screen', false);
  setTileStream('screen-local', ssStream);
  pinTile('screen-local');

  sharingScreen = true;
  shareScreenBtn.textContent = 'Stop Sharing';
  shareScreenBtn.classList.add('active');
  screenTrack.onended = () => stopScreenShare();
}

function stopScreenShare() {
  if (!sharingScreen) return;

  // Remove screen track from all peer connections and renegotiate
  for (const [pid, sender] of Object.entries(screenSenders)) {
    if (peers[pid]) {
      peers[pid].connection.removeTrack(sender);
      peers[pid].connection.createOffer()
        .then(offer => peers[pid].connection.setLocalDescription(offer)
          .then(() => socket.emit('offer', { to: pid, offer })))
        .catch(console.error);
    }
  }
  Object.keys(screenSenders).forEach(k => delete screenSenders[k]);

  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }

  socket.emit('screen-share-stopped');
  removeTile('screen-local'); // also unpins if pinned

  sharingScreen = false;
  shareScreenBtn.textContent = 'Share Screen';
  shareScreenBtn.classList.remove('active');
}

// ── Leave ──────────────────────────────────────────────────────────────
leaveBtn.addEventListener('click', leave);

function leave() {
  if (sharingScreen) stopScreenShare();
  for (const peerId of Object.keys(peers)) cleanupPeer(peerId);
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  socket.emit('leave');
  overlay.classList.add('visible');
}

// ── Init ───────────────────────────────────────────────────────────────
async function init() {
  await fetchIceConfig();
  await requestCameraOnLoad();
  cameraInitDone = true;
  joinSession();
}

init();
