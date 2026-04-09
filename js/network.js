// ══════════════════════════════════════════
//  network.js — PeerJS mesh + WebRTC video
// ══════════════════════════════════════════

let peer       = null;
let myPeerId   = null;
let localStream = null;
let mutedAudio = false;
let mutedVideo = false;

// Connection registry: pos -> DataConnection
const dataConns   = {};  // for host: pos->conn; for clients: 'host'->conn
// Video calls: peerId -> MediaConnection
const videoCalls  = {};
// Remote streams: pos -> MediaStream
const remoteStreams = {};

/** Init PeerJS with a specific id, returns promise */
function initPeer(id) {
  return new Promise((resolve, reject) => {
    const p = new Peer(id, {
      host: '0.peerjs.com', port: 443, path: '/',
      secure: true, debug: 0,
      config: { iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ]}
    });
    p.on('open',  id  => { myPeerId = id; resolve(p); });
    p.on('error', err => reject(err));
  });
}

/** Acquire camera + microphone */
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

/** Host broadcasts to all connected players */
function broadcastAll(msg) {
  for (const conn of Object.values(dataConns)) sendConn(conn, msg);
}
function broadcastExcept(exceptPos, msg) {
  for (const [pos, conn] of Object.entries(dataConns)) {
    if (pos !== exceptPos) sendConn(conn, msg);
  }
}

/** Client sends to host */
function sendToHost(msg) {
  if (isHost) {
    // Host processes locally
    onHostReceive(msg, myPos);
  } else {
    const conn = dataConns['host'];
    if (conn) sendConn(conn, msg);
  }
}

/** Setup a DataConnection for receiving messages */
function wireDataConn(conn, fromLabel) {
  conn.on('data', msg => {
    if (isHost) {
      onHostReceive(msg, fromLabel || conn._peerLabel);
    } else {
      onClientReceive(msg);
    }
  });
  conn.on('close', () => {
    log(`Connection closed: ${fromLabel}`);
  });
  conn.on('error', e => console.warn('conn error', e));
}

/** Place a video call to a remote peer */
function callPeer(remotePeerId, remotePos) {
  if (!localStream || !peer) return;
  const call = peer.call(remotePeerId, localStream, { metadata: { pos: myPos } });
  videoCalls[remotePeerId] = call;
  call.on('stream', stream => { remoteStreams[remotePos] = stream; attachVideo(remotePos, stream); });
  call.on('error', e => console.warn('call error', e));
}

/** Answer incoming video call */
function answerCall(call) {
  call.answer(localStream || undefined);
  const fromPos = call.metadata?.pos;
  call.on('stream', stream => {
    if (fromPos) { remoteStreams[fromPos] = stream; attachVideo(fromPos, stream); }
    else {
      // try to match by peerId
      for (const [p, info] of Object.entries(playerMap)) {
        if (info && info.peerId === call.peer) { remoteStreams[p]=stream; attachVideo(p,stream); break; }
      }
    }
  });
  videoCalls[call.peer] = call;
}

/** Attach a remote MediaStream to the correct seat video element */
function attachVideo(absPos, stream) {
  const dispPos = absToDisplay(absPos);
  const seat = document.getElementById('seat-' + dispPos);
  if (!seat) return;
  const wrap = seat.querySelector('.seat-video-wrap');
  const noVid = wrap.querySelector('.no-video');
  let vid = wrap.querySelector('video');
  if (!vid) { vid = document.createElement('video'); vid.autoplay=true; vid.playsInline=true; wrap.prepend(vid); }
  vid.srcObject = stream;
  if (noVid) noVid.style.display = 'none';
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
