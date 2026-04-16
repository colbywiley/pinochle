// ══════════════════════════════════════════
//  main.js — lobby orchestration & entry
// ══════════════════════════════════════════

let isHost    = false;
let myPos     = null;   // absolute position: south|west|north|east
let myName    = '';
let roomCode  = '';

// playerMap: pos -> { name, peerId }
const playerMap = { south:null, west:null, north:null, east:null };

// ── CREATE ROOM ───────────────────────────────────────────────────────────────

async function createRoom() {
  myName = document.getElementById('host-name').value.trim() || 'Host';
  const code = 'PINE' + Math.floor(Math.random()*900+100);
  roomCode = code;
  isHost   = true;
  myPos    = 'south';

  setStatus('create', 'Connecting…');
  try {
    peer = await initPeer('pinochle-' + code);
    playerMap['south'] = { name: myName, peerId: myPeerId };

    // Show room code
    document.getElementById('room-code-display').textContent = code;
    document.getElementById('room-code-display').onclick = () => {
      navigator.clipboard?.writeText(code).then(() => setStatus('create','Copied!'));
    };
    document.getElementById('room-share').style.display = 'block';
    setStatus('create','');
    updateLobbyList();
    checkStartHint();

    // Incoming connections
    peer.on('connection', onIncomingDataConn);
    peer.on('call', answerCall);

    await startLocalMedia();
  } catch(e) {
    setStatus('create','Error: ' + e.message);
  }
}

// ── JOIN ROOM ─────────────────────────────────────────────────────────────────

async function joinRoom() {
  myName   = document.getElementById('join-name').value.trim() || 'Player';
  roomCode = document.getElementById('room-input').value.trim().toUpperCase();
  if (!roomCode) { setStatus('join','Enter a room code.'); return; }
  isHost   = false;

  setStatus('join','Connecting<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>');
  try {
    peer = await initPeer(null); // auto id for clients
    await startLocalMedia();

    const conn = peer.connect('pinochle-' + roomCode, {
      metadata: { name: myName },
      reliable: true
    });
    dataConns['host'] = conn;
    conn._peerLabel   = 'host';

    conn.on('open', () => {
      wireDataConn(conn, 'host');
      sendConn(conn, { type:'join', name: myName, peerId: myPeerId });
      setStatus('join','Joined! Waiting for host to start…');
    });
    conn.on('error', e => setStatus('join','Connection error: ' + e));

    peer.on('call', answerCall);
  } catch(e) {
    setStatus('join','Error: ' + e.message);
  }
}

// ── INCOMING DATA CONNECTION (host only) ──────────────────────────────────────

function onIncomingDataConn(conn) {
  conn.on('open', () => {
    // Assign position
    const taken = Object.keys(playerMap).filter(p=>playerMap[p]!==null);
    const open  = POSITIONS.filter(p=>!taken.includes(p));
    if (!open.length) { sendConn(conn, {type:'error',error:'Room is full'}); conn.close(); return; }

    const pos = open[0];
    const name = conn.metadata?.name || 'Player';
    playerMap[pos] = { name, peerId: conn.peer };
    conn._peerLabel = pos;
    dataConns[pos]  = conn;

    wireDataConn(conn, pos);

    // Welcome this player
    sendConn(conn, { type:'welcome', pos, playerMap });

    // Notify others
    for (const [p, c] of Object.entries(dataConns)) {
      if (p !== pos) sendConn(c, { type:'player_joined', pos, name, peerId: conn.peer });
    }

    updateLobbyList();
    checkStartHint();

    // Start video call to them
    if (localStream && peer) {
      const call = peer.call(conn.peer, localStream, { metadata:{ pos: myPos } });
      videoCalls[conn.peer] = call;
      call.on('stream', stream => { remoteStreams[pos]=stream; attachVideo(pos, stream); });
    }
  });
}

// ── RECEIVE join message (host only, for compatibility) ───────────────────────
// Client sends { type:'join', name, peerId } — we handle in wireDataConn's data handler

// Override onHostReceive to also handle type:'join'
const _origOnHostReceive = typeof onHostReceive !== 'undefined' ? onHostReceive : null;
function onHostReceiveWrapper(msg, fromPos) {
  if (msg.type === 'join') {
    // Already handled by onIncomingDataConn via metadata; ignore duplicate
    return;
  }
  if (msg.action) onHostReceive(msg, fromPos);
}
// Patch wireDataConn to use wrapper for host
const _origWireDataConn = wireDataConn;

// ── START GAME ────────────────────────────────────────────────────────────────

function hostStartGame() {
  if (!isHost) return;
  G = newRound(null);
  dealCards(G);
  broadcastAll({ type:'start_game', state: buildPlayerView(G, 'broadcast') });
  // Actually send per-player views
  for (const [pos, conn] of Object.entries(dataConns)) {
    sendConn(conn, { type:'start_game', state: buildPlayerView(G, pos) });
  }
  applyGameState(buildPlayerView(G, myPos));
  enterGame();
}

// ── ENTER GAME ────────────────────────────────────────────────────────────────

function enterGame() {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('game').classList.add('active');
  // Init anim layer immediately — table is now visible
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      initAnimLayer();
    });
  });
}

// ── LOBBY HELPERS ─────────────────────────────────────────────────────────────

function updateLobbyList() {
  const el = document.getElementById('lobby-players-list');
  if (!el) return;
  el.innerHTML = POSITIONS.map(p => {
    const info = playerMap[p];
    return `<div class="lobby-player-slot${info?'':' empty'}">
      <span class="slot-pos">${p}</span>
      <span class="slot-name">${info ? info.name : 'waiting…'}</span>
    </div>`;
  }).join('');
}

function checkStartHint() {
  const filled = POSITIONS.filter(p=>playerMap[p]!==null).length;
  const btn    = document.getElementById('start-btn');
  const hint   = document.getElementById('start-hint');
  if (!btn) return;
  btn.style.display  = filled >= 2 ? 'block' : 'none';
  if (hint) hint.style.display = 'block';
  if (hint) {
    if (filled === 4) {
      hint.textContent = '4/4 players — ready to play!';
      hint.style.color = '#7aff9a';
      hint.style.fontSize = '0.85rem';
    } else if (filled >= 2) {
      hint.textContent = `${filled}/4 players · Can start now or wait for all 4`;
      hint.style.color = '';
      hint.style.fontSize = '';
    } else {
      hint.textContent = `${filled}/4 players · Need at least 2 to start`;
      hint.style.color = '';
      hint.style.fontSize = '';
    }
  }
}

function setStatus(panel, html) {
  const el = document.getElementById(panel+'-status');
  if (el) el.innerHTML = html;
}

// ── WIRE DATA CONN to handle both client and host messages ────────────────────
// Overrides the one in network.js to route properly
function wireDataConn(conn, fromLabel) {
  conn.on('data', msg => {
    if (isHost) {
      // Handle action messages
      if (msg.action)       onHostReceive(msg, fromLabel || conn._peerLabel);
      else if (msg.type === 'join') { /* handled on open */ }
    } else {
      onClientReceive(msg);
    }
  });
  conn.on('close', () => log(`${fromLabel} disconnected`));
  conn.on('error', e => console.warn('DataConn error:', e));
}

// ── PeerJS peer id for clients is random ──────────────────────────────────────
async function initPeer(id) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: '0.peerjs.com', port: 443, path: '/', secure: true, debug: 0,
      config: { iceServers: [
        { urls:'stun:stun.l.google.com:19302' },
        { urls:'stun:stun1.l.google.com:19302' },
      ]}
    };
    const p = id ? new Peer(id, opts) : new Peer(opts);
    p.on('open',  rid => { myPeerId = rid; resolve(p); });
    p.on('error', err => {
      if (err.type === 'unavailable-id') {
        // ID taken — retry with random
        const fallback = new Peer(opts);
        fallback.on('open', rid => { myPeerId=rid; resolve(fallback); });
        fallback.on('error', e2 => reject(e2));
      } else reject(err);
    });
  });
}

// ══════════════════════════════════════════════════════════════
//  SOLO TEST MODE
//  No networking. Host runs everything locally.
//  myPos rotates to whichever seat you click.
//  All 4 hands are visible face-up and clickable when active.
// ══════════════════════════════════════════════════════════════

let soloMode = false;

function startSoloMode() {
  soloMode = true;
  isHost   = true;
  myPos    = 'south';
  myName   = 'South';

  playerMap['south'] = { name:'South', peerId:'solo-s' };
  playerMap['west']  = { name:'West',  peerId:'solo-w' };
  playerMap['north'] = { name:'North', peerId:'solo-n' };
  playerMap['east']  = { name:'East',  peerId:'solo-e' };

  // Show the solo start panel (mirrors multiplayer flow — click Deal to start)
  document.getElementById('solo-start-panel').style.display = 'flex';
  // Hide the lobby entry points (Create/Join/Solo button) while in solo setup
  document.querySelector('.lobby-panels').style.display     = 'none';
  document.querySelector('.solo-bar').style.display         = 'none';
}

/** Actually deal the cards and begin the solo game — parallels hostStartGame() */
function startSoloGame() {
  G = newRound(null);
  dealCards(G);

  // Enter game FIRST so #table is visible and has dimensions
  enterGame();

  // Show solo switcher
  document.getElementById('solo-switcher').style.display = 'flex';

  // Wait for layout to paint before triggering state/deal animation
  setTimeout(() => {
    applyGameStateSolo();
  }, 300);
}

/**
 * In solo mode, apply state WITHOUT redacting any hands.
 * Overrides the normal applyGameState for the solo path.
 */
async function applyGameStateSolo() {
  // Build a view where myPos sees everything
  const fullView = buildSoloView(G);
  // On a new deal (entering bidding from game start or round_over), clear G
  // so applyGameState detects the 0→12 card transition and triggers doNewDeal
  if (fullView.phase === 'bidding' && (prevPhase === null || prevPhase === 'round_over')) {
    G = null;
  }
  await applyGameState(fullView);
  updateSoloSwitcher();
}

function buildSoloView(state) {
  // Clone state but expose ALL hands to the current viewer
  const v = JSON.parse(JSON.stringify(state));
  // All hands stay as arrays (no redaction)
  return v;
}

/** Switch which seat "you" are playing as */
function soloSwitchSeat(seat) {
  myPos  = seat;
  myName = seat.charAt(0).toUpperCase() + seat.slice(1);

  // Update active button
  document.querySelectorAll('.solo-seat-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.seat === seat);
  });

  // Re-render everything from new perspective
  if (G) applyGameStateSolo();
}

function updateSoloSwitcher() {
  if (!soloMode || !G) return;

  // Figure out whose turn it is
  let activeSeat = soloWhoseTurn();

  // Auto-switch to the active seat so the action panel shows immediately
  if (activeSeat && activeSeat !== myPos) {
    soloSwitchSeat(activeSeat);
    return; // soloSwitchSeat triggers re-render which calls updateSoloSwitcher again
  }

  document.querySelectorAll('.solo-seat-btn').forEach(b => {
    b.classList.toggle('is-turn', b.dataset.seat === activeSeat);
  });

  const ind = document.getElementById('solo-turn-indicator');
  if (ind) {
    if (activeSeat === myPos) {
      const name = activeSeat.charAt(0).toUpperCase() + activeSeat.slice(1);
      ind.textContent = `${name}'s turn`;
    } else {
      ind.textContent = '';
    }
  }
}

// ── GITHUB PAGES: show URL hint ───────────────────────────────────────────────
window.addEventListener('load', () => {
  // If there's a ?room= query param, pre-fill join field
  const params = new URLSearchParams(location.search);
  const roomParam = params.get('room');
  if (roomParam) {
    const inp = document.getElementById('room-input');
    if (inp) inp.value = roomParam.toUpperCase();
    const nameInp = document.getElementById('join-name');
    if (nameInp) nameInp.focus();
  }

  // Update share link to include room code when created
  const origRoomDisp = document.getElementById('room-code-display');
  if (origRoomDisp) {
    origRoomDisp.addEventListener('click', () => {
      const code = origRoomDisp.textContent.trim();
      if (code && code !== '—') {
        const url = `${location.origin}${location.pathname}?room=${code}`;
        navigator.clipboard?.writeText(url).then(() => setStatus('create','Link copied!'))
          .catch(() => navigator.clipboard?.writeText(code));
      }
    });
  }
});
