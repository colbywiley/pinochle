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

/** Acquire camera + microphone (best effort). If permission arrives
 *  late, (re)establish outgoing calls so peers get our stream. */
async function startLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    const vid = document.getElementById('local-video');
    if (vid) { vid.srcObject = localStream; document.getElementById('local-no-video').style.display='none'; }
    connectVideoMesh();
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
// The newest joiner calls every existing peer. A peer with no
// camera can't initiate (PeerJS calls need a stream), so existing
// peers also try the other direction after a grace period — a
// stream-less player then answers receive-only and still gets
// everyone's video. Late camera permission re-calls with a stream.

const sentStreamTo = new Set(); // peer ids that have received our stream

function connectVideoMesh() {
  if (!peer) return;
  for (const [pos, info] of Object.entries(playerMap)) {
    if (!info || info.bot || pos === myPos || !info.peerId) continue;
    if (localStream ? sentStreamTo.has(info.peerId) : true) continue;
    callPeer(info.peerId, pos);
  }
}

/** If no call exists with this peer after `delay`, initiate one */
function ensureVideoCall(peerId, delay = 4000) {
  setTimeout(() => {
    if (!peer || !localStream || sentStreamTo.has(peerId) || videoCalls[peerId]) return;
    for (const [pos, info] of Object.entries(playerMap)) {
      if (info && info.peerId === peerId) { callPeer(peerId, pos); return; }
    }
  }, delay);
}

/** Place a video call to a remote peer (requires a local stream) */
function callPeer(remotePeerId, remotePos) {
  if (!localStream || !peer) return;
  const call = peer.call(remotePeerId, localStream, { metadata: { pos: myPos } });
  if (!call) return;
  videoCalls[remotePeerId] = call;
  sentStreamTo.add(remotePeerId);
  call.on('stream', stream => { remoteStreams[remotePos] = stream; attachVideo(remotePos, stream); });
  call.on('error', e => console.warn('call error', e));
}

/** Answer an incoming video call — but only from a known room member.
 *  The seat comes from our own playerMap, never from caller metadata
 *  (peer ids are guessable on the public broker; don't stream the
 *  camera to strangers or let a caller claim someone else's seat). */
function answerCall(call, isRetry) {
  let fromPos = null;
  for (const [p, info] of Object.entries(playerMap)) {
    if (info && info.peerId === call.peer) { fromPos = p; break; }
  }
  if (!fromPos) {
    // The player_joined notice may still be in flight — check once more
    if (!isRetry) setTimeout(() => answerCall(call, true), 2000);
    else try { call.close(); } catch {}
    return;
  }
  call.answer(localStream || undefined);
  videoCalls[call.peer] = call;
  call.on('stream', stream => { remoteStreams[fromPos] = stream; attachVideo(fromPos, stream); });
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

/** Drop a departed player's stream and restore the seat placeholder */
function detachVideo(absPos, peerId) {
  if (peerId) {
    try { videoCalls[peerId]?.close(); } catch {}
    delete videoCalls[peerId];
    sentStreamTo.delete(peerId);
  }
  delete remoteStreams[absPos];
  const seat = document.getElementById('seat-' + absToDisplay(absPos));
  if (!seat) return;
  const vid   = seat.querySelector('.seat-video-wrap video');
  const noVid = seat.querySelector('.no-video');
  if (vid) vid.srcObject = null;
  if (noVid) noVid.style.display = '';
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
