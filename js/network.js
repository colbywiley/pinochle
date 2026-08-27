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
    // TURN relay fallback: without one, any pair of players where one is
    // behind a symmetric NAT / CGNAT (mobile hotspots, many ISPs) simply
    // never connects. Open Relay is a free public TURN service; it is only
    // used when a direct connection fails. For guaranteed capacity, swap in
    // your own coturn or a metered.ca account here.
    { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ]}
};

// The seat tiles render at ~160×120 px, so capture small and cap hard:
// full-res defaults would push 1–2.5 Mbps per receiver (×3 in a 4-player
// mesh) for no visible gain. 320×240@15 capped at 300 kbps looks identical
// at tile size and cuts upload ~90%.
const MEDIA_CONSTRAINTS = {
  video: {
    width:  { ideal: 320 },
    height: { ideal: 240 },
    frameRate: { ideal: 15, max: 24 },
    facingMode: 'user',
  },
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};
const MAX_VIDEO_BITRATE = 300_000; // bps per outgoing stream

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

/** Acquire camera + microphone (best effort). Falls back to audio-only
 *  when the camera is missing or busy, so voice chat still works. If
 *  permission arrives late, (re)establish calls so peers get our stream. */
async function startLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
  } catch (e) {
    console.warn('Camera unavailable, trying audio only:', e);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: MEDIA_CONSTRAINTS.audio });
    } catch (e2) {
      console.warn('Media unavailable:', e2);
      return;
    }
  }
  for (const t of localStream.getVideoTracks()) {
    try { t.contentHint = 'motion'; } catch {}
  }
  if (localStream.getVideoTracks().length) {
    const vid = document.getElementById('local-video');
    if (vid) { vid.srcObject = localStream; document.getElementById('local-no-video').style.display = 'none'; }
  } else {
    document.getElementById('cam-btn')?.classList.add('off');
  }
  connectVideoMesh();
}

/** Cap the outgoing video bitrate on a call (tiles are tiny — don't
 *  let WebRTC negotiate megabits). Safe no-op where unsupported. */
function tuneCall(call) {
  const pc = call.peerConnection;
  if (!pc || typeof pc.getSenders !== 'function') return;
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE;
      params.degradationPreference = 'maintain-framerate';
      sender.setParameters(params).catch(() => {});
    } catch {}
  }
}

/** Re-establish a media call if it drops mid-session (bounded retries) */
const callRetries = {}; // peerId -> attempt count
function wireCallLifecycle(call, peerId) {
  const onDrop = () => {
    if (call._dropHandled) return;
    call._dropHandled = true;
    if (videoCalls[peerId] === call) {
      delete videoCalls[peerId];
      sentStreamTo.delete(peerId);
    }
    const inRoom = Object.values(playerMap).some(i => i && !i.bot && i.peerId === peerId);
    if (!inRoom || !peer) return;
    callRetries[peerId] = (callRetries[peerId] || 0) + 1;
    if (callRetries[peerId] > 5) return;
    ensureVideoCall(peerId, 2500);
  };
  call.on('close', onDrop);
  call.on('error', onDrop);
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
  call.on('stream', stream => {
    callRetries[remotePeerId] = 0;
    remoteStreams[remotePos] = stream;
    attachVideo(remotePos, stream);
    tuneCall(call);
  });
  wireCallLifecycle(call, remotePeerId);
  setTimeout(() => tuneCall(call), 800);
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
  call.on('stream', stream => {
    callRetries[call.peer] = 0;
    remoteStreams[fromPos] = stream;
    attachVideo(fromPos, stream);
    tuneCall(call);
  });
  wireCallLifecycle(call, call.peer);
  setTimeout(() => tuneCall(call), 800);
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
  // audio-only peers keep the suit placeholder (black tile otherwise)
  if (noVid) noVid.style.display = stream.getVideoTracks().length ? 'none' : '';
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
    delete callRetries[peerId];
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
