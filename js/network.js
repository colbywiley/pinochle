// ══════════════════════════════════════════
//  network.js — PeerJS mesh + WebRTC video
// ══════════════════════════════════════════

let peer        = null;
let myPeerId    = null;
let localStream = null;
let mutedAudio  = false;
let mutedVideo  = false;

// Connection registry: pos -> DataConnection (host) / 'host' -> conn (clients)
const dataConns   = {};
// Video calls: peerId -> MediaConnection
const videoCalls  = {};
// Remote streams: absolute pos -> MediaStream
const remoteStreams = {};

const PEER_OPTS = {
  host: '0.peerjs.com', port: 443, path: '/', secure: true, debug: 0,
  config: { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]}
};

/** Init PeerJS. With an id (host) — falls back to a random id if taken. */
function initPeer(id) {
  return new Promise((resolve, reject) => {
    const p = id ? new Peer(id, PEER_OPTS) : new Peer(PEER_OPTS);
    let settled = false;
    p.on('open', rid => { if (!settled) { settled = true; myPeerId = rid; resolve(p); } });
    p.on('error', err => {
      if (settled) { console.warn('peer error', err); return; }
      settled = true;
      reject(err);
    });
  });
}

/** Acquire camera + microphone (best effort) */
async function startLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    const vid = document.getElementById('local-video');
    if (vid) { vid.srcObject = localStream; document.getElementById('local-no-video').style.display='none'; }
  } catch(e) {
    console.warn('Media unavailable:', e);
  }
}

/** Send a JSON message to a connection */
function sendConn(conn, msg) {
  try { conn.send(msg); } catch(e) { console.warn('send error', e); }
}

/** Client sends to host (host processes its own actions locally) */
function sendToHost(msg) {
  if (isHost) {
    onHostReceive(msg, myPos);
  } else {
    const conn = dataConns['host'];
    if (conn) sendConn(conn, msg);
  }
}

/** Route incoming data messages */
function wireDataConn(conn, fromLabel) {
  conn.on('data', msg => {
    if (isHost) {
      if (msg && msg.action) onHostReceive(msg, fromLabel || conn._peerLabel);
    } else {
      if (msg && msg.type) onClientReceive(msg);
    }
  });
  conn.on('close', () => onConnClosed(fromLabel || conn._peerLabel));
  conn.on('error', e => console.warn('DataConn error:', e));
}

// ── Video mesh ────────────────────────────────────────────────
// The newest joiner calls every existing peer (host + clients),
// so each pair gets exactly one media connection.

function connectVideoMesh() {
  if (!peer) return;
  for (const [pos, info] of Object.entries(playerMap)) {
    if (!info || info.bot || pos === myPos || !info.peerId) continue;
    if (videoCalls[info.peerId]) continue;
    callPeer(info.peerId, pos);
  }
}

/** Place a video call to a remote peer */
function callPeer(remotePeerId, remotePos) {
  if (!localStream || !peer) return;
  const call = peer.call(remotePeerId, localStream, { metadata: { pos: myPos } });
  if (!call) return;
  videoCalls[remotePeerId] = call;
  call.on('stream', stream => { remoteStreams[remotePos] = stream; attachVideo(remotePos, stream); });
  call.on('error', e => console.warn('call error', e));
}

/** Answer incoming video call */
function answerCall(call) {
  call.answer(localStream || undefined);
  videoCalls[call.peer] = call;
  call.on('stream', stream => {
    let fromPos = call.metadata?.pos;
    if (!fromPos) {
      for (const [p, info] of Object.entries(playerMap)) {
        if (info && info.peerId === call.peer) { fromPos = p; break; }
      }
    }
    if (fromPos) { remoteStreams[fromPos] = stream; attachVideo(fromPos, stream); }
  });
  call.on('error', e => console.warn('call error', e));
}

/** Attach a remote MediaStream to the correct seat video element */
function attachVideo(absPos, stream) {
  const seat = document.getElementById('seat-' + absToDisplay(absPos));
  if (!seat) return;
  const wrap  = seat.querySelector('.seat-video-wrap');
  const noVid = wrap.querySelector('.no-video');
  let vid = wrap.querySelector('video');
  if (!vid) { vid = document.createElement('video'); vid.autoplay=true; vid.playsInline=true; wrap.prepend(vid); }
  vid.srcObject = stream;
  if (noVid) noVid.style.display = 'none';
}

/** Re-attach all video streams (seat rotation happens when myPos is assigned) */
function refreshAllVideos() {
  for (const [pos, stream] of Object.entries(remoteStreams)) attachVideo(pos, stream);
}

function toggleMute() {
  mutedAudio = !mutedAudio;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !mutedAudio);
  const btn = document.getElementById('mute-btn');
  btn.textContent = mutedAudio ? '🔇' : '🎤';
  btn.classList.toggle('off', mutedAudio);
}

function toggleCam() {
  mutedVideo = !mutedVideo;
  if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = !mutedVideo);
  const btn = document.getElementById('cam-btn');
  btn.textContent = mutedVideo ? '📵' : '📷';
  btn.classList.toggle('off', mutedVideo);
}
