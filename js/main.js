// ══════════════════════════════════════════
//  main.js — lobby orchestration & entry
// ══════════════════════════════════════════

let isHost   = false;
let soloMode = false;   // practice vs computer (no network)
let myPos    = null;    // absolute position: south|west|north|east
let myName   = '';
let roomCode = '';

// playerMap: pos -> { name, peerId?, bot? }
const playerMap = { south:null, west:null, north:null, east:null };

// Join order: 2nd human sits north (partner of host), then west, then east
const JOIN_ORDER = ['north','west','east'];
const BOT_NAMES  = ['Ace', 'Ruby', 'Jasper'];

// ── CREATE ROOM ───────────────────────────────────────────────────────────────

async function createRoom() {
  myName = document.getElementById('host-name').value.trim() || 'Host';
  isHost = true;
  myPos  = 'south';

  setStatus('create', 'Connecting…');
  for (let attempt = 0; attempt < 3; attempt++) {
    roomCode = 'PINE' + Math.floor(Math.random()*900+100);
    try {
      peer = await initPeer('pinochle-' + roomCode);
      break;
    } catch(e) {
      peer = null;
      if (e?.type !== 'unavailable-id' || attempt === 2) {
        setStatus('create','Error: ' + (e?.message || e?.type || e));
        isHost = false; myPos = null;
        return;
      }
    }
  }

  playerMap['south'] = { name: myName, peerId: myPeerId };

  const disp = document.getElementById('room-code-display');
  disp.textContent = roomCode;
  disp.onclick = () => {
    const url = `${location.origin}${location.pathname}?room=${roomCode}`;
    navigator.clipboard?.writeText(url)
      .then(() => setStatus('create','Invite link copied!'))
      .catch(() => setStatus('create','Room code: ' + roomCode));
  };
  document.getElementById('room-share').style.display = 'block';
  document.getElementById('panel-create').querySelector('.btn').style.display = 'none';
  setStatus('create','');
  updateLobbyList();
  checkStartHint();

  peer.on('connection', onIncomingDataConn);
  peer.on('call', answerCall);
  await startLocalMedia();
}

// ── JOIN ROOM ─────────────────────────────────────────────────────────────────

async function joinRoom() {
  myName   = document.getElementById('join-name').value.trim() || 'Player';
  roomCode = document.getElementById('room-input').value.trim().toUpperCase();
  if (!roomCode) { setStatus('join','Enter a room code.'); return; }
  isHost = false;

  setStatus('join','Connecting<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>');
  try {
    peer = await initPeer(null); // random id for clients
  } catch(e) {
    setStatus('join','Error: ' + (e?.message || e?.type || e));
    return;
  }

  peer.on('error', err => {
    if (err?.type === 'peer-unavailable') setStatus('join','Room not found — check the code.');
  });
  peer.on('call', answerCall);
  await startLocalMedia();

  const conn = peer.connect('pinochle-' + roomCode, {
    metadata: { name: myName },
    reliable: true
  });
  dataConns['host'] = conn;
  conn._peerLabel   = 'host';
  // Wire the data handler immediately — a message can arrive before
  // our 'open' event fires, and it must not be lost
  wireDataConn(conn, 'host');
  conn.on('open', () => {
    setStatus('join','Joined! Waiting for the host to start…');
  });
}

// ── INCOMING DATA CONNECTION (host only) ──────────────────────────────────────

function onIncomingDataConn(conn) {
  conn.on('open', () => {
    if (G) { sendConn(conn, { type:'error', error:'Game already in progress' }); conn.close(); return; }
    const pos = JOIN_ORDER.find(p => !playerMap[p]);
    if (!pos) { sendConn(conn, { type:'error', error:'Room is full' }); conn.close(); return; }

    const name = String(conn.metadata?.name || 'Player').slice(0, 16);
    playerMap[pos] = { name, peerId: conn.peer };
    conn._peerLabel = pos;
    dataConns[pos]  = conn;
    wireDataConn(conn, pos);

    // Welcome this player (they will initiate video calls to everyone)
    sendConn(conn, { type:'welcome', pos, playerMap });

    // Notify the other clients
    for (const [p, c] of Object.entries(dataConns)) {
      if (p !== pos) sendConn(c, { type:'player_joined', pos, name, peerId: conn.peer });
    }
    updateLobbyList();
    checkStartHint();
  });
}

// ── DISCONNECTS ───────────────────────────────────────────────────────────────

function onConnClosed(label) {
  if (!isHost) {
    if (label === 'host') {
      if (G || document.getElementById('game').classList.contains('active')) {
        alert('Lost connection to the host.');
        location.reload();
      } else {
        setStatus('join','Disconnected from host.');
      }
    }
    return;
  }
  // Host side: label is the seat position
  const pos = label;
  if (!POSITIONS.includes(pos) || !playerMap[pos]) return;
  delete dataConns[pos];

  if (G && !G.winner) {
    // Mid-game: a bot takes over the seat
    const oldName = playerMap[pos].name;
    playerMap[pos] = { name: `${oldName} (CPU)`, bot: true };
    hostLog(`${oldName} disconnected — the computer plays on for ${pos}`);
    for (const c of Object.values(dataConns)) {
      sendConn(c, { type:'player_update', pos, name: playerMap[pos].name, bot: true });
    }
    broadcastGameState();
  } else {
    playerMap[pos] = null;
    for (const c of Object.values(dataConns)) {
      sendConn(c, { type:'player_left', pos });
    }
    updateLobbyList();
    checkStartHint();
  }
}

// ── START GAME (host) ─────────────────────────────────────────────────────────

function hostStartGame() {
  if (!isHost || G) return;

  // Fill empty seats with computer players
  let b = 0;
  for (const p of POSITIONS) {
    if (!playerMap[p]) playerMap[p] = { name: BOT_NAMES[b++ % BOT_NAMES.length], bot: true };
  }

  G = newRound(null);
  dealCards(G);
  hostLog(`Round 1 — ${G.dealer} deals`);

  for (const [pos, conn] of Object.entries(dataConns)) {
    if (POSITIONS.includes(pos)) {
      sendConn(conn, { type:'start_game', playerMap, state: buildPlayerView(G, pos) });
    }
  }
  enterGame();
  applyGameState(buildPlayerView(G, myPos));
  maybeScheduleBot();
}

// ── PRACTICE VS COMPUTER ──────────────────────────────────────────────────────

function startPracticeSetup() {
  soloMode = true;
  isHost   = true;
  myPos    = 'south';
  myName   = document.getElementById('host-name').value.trim() ||
             document.getElementById('join-name').value.trim() || 'You';

  playerMap['south'] = { name: myName };
  playerMap['west']  = { name: BOT_NAMES[0], bot: true };
  playerMap['north'] = { name: BOT_NAMES[1], bot: true };
  playerMap['east']  = { name: BOT_NAMES[2], bot: true };

  document.getElementById('solo-start-panel').style.display = 'flex';
  document.querySelector('.lobby-panels').style.display     = 'none';
  document.querySelector('.solo-bar').style.display         = 'none';
}

function startPracticeGame() {
  G = newRound(null);
  dealCards(G);
  hostLog(`Round 1 — ${G.dealer} deals`);
  enterGame();
  applyGameState(buildPlayerView(G, myPos));
  maybeScheduleBot();
}

// ── ENTER GAME ────────────────────────────────────────────────────────────────

function enterGame() {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('game').classList.add('active');
  initAnimLayer();
  if (soloMode) document.getElementById('cam-controls').style.display = 'none';
  refreshAllVideos();
}

// ── LOBBY HELPERS ─────────────────────────────────────────────────────────────

function updateLobbyList() {
  const el = document.getElementById('lobby-players-list');
  if (!el) return;
  el.innerHTML = POSITIONS.map(p => {
    const info = playerMap[p];
    return `<div class="lobby-player-slot${info?'':' empty'}">
      <span class="slot-pos">${p}</span>
      <span class="slot-name">${info ? escapeHtml(info.name) : 'CPU (until someone joins)'}</span>
    </div>`;
  }).join('');
}

function checkStartHint() {
  const filled = POSITIONS.filter(p=>playerMap[p]!==null).length;
  const btn    = document.getElementById('start-btn');
  const hint   = document.getElementById('start-hint');
  if (!btn) return;
  btn.style.display  = 'block';
  if (hint) {
    hint.style.display = 'block';
    if (filled === 4) {
      hint.textContent = '4/4 players — ready to play!';
      hint.style.color = '#7aff9a';
    } else {
      hint.textContent = `${filled}/4 players — empty seats will be played by the computer`;
      hint.style.color = '';
    }
  }
}

function setStatus(panel, html) {
  const el = document.getElementById(panel+'-status');
  if (el) el.innerHTML = html;
}

// ── PAGE LOAD ─────────────────────────────────────────────────────────────────

window.addEventListener('load', () => {
  // ?room= query param pre-fills the join field
  const params = new URLSearchParams(location.search);
  const roomParam = params.get('room');
  if (roomParam) {
    const inp = document.getElementById('room-input');
    if (inp) inp.value = roomParam.toUpperCase().slice(0, 8);
    document.getElementById('join-name')?.focus();
  }
});
