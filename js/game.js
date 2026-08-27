// ══════════════════════════════════════════
//  game.js — host-side game state machine
//  G is the single authoritative state and lives ONLY on the
//  host. Every player (host included) renders from a redacted
//  view applied via applyGameState() in ui.js — G is never
//  overwritten by a view.
// ══════════════════════════════════════════

let G = null;            // authoritative game state (host only)
let logSeq = 0;          // sequence number for log lines sent to clients
let animHold = false;    // true while clients are showing a completed trick
let botTimer = null;     // pending bot action
let meldTimer = null;    // auto-advance out of the meld phase

const TRICK_DISPLAY_MS = 1800; // how long a finished trick stays on the table
const MELD_DISPLAY_MS  = 9000; // auto-advance to play after this long

// ── Host receive ─────────────────────────────────────────────────────────────

function onHostReceive(msg, fromPos) {
  if (!isHost || !G || !fromPos) return;
  try {
    handleHostAction(msg, fromPos);
  } catch (e) {
    // A malformed message must never take down the host game
    console.error('host action failed', msg?.action, e);
    sendError(fromPos, 'Invalid action');
  }
}

function handleHostAction(msg, fromPos) {
  let result;

  switch (msg.action) {
    case 'bid':
      result = processBid(G, fromPos, msg.amount);
      if (!result.ok) { sendError(fromPos, result.error); return; }
      hostLog(result.log);
      if (result.redeal) { startNextRound(); return; } // four passes — throw it in
      broadcastGameState();
      break;

    case 'name_trump':
      result = processTrump(G, fromPos, msg.suit);
      if (!result.ok) { sendError(fromPos, result.error); return; }
      hostLog(result.log);
      broadcastGameState();
      break;

    case 'pass_cards':
      result = processPass(G, fromPos, msg.cards);
      if (!result.ok) { sendError(fromPos, result.error); return; }
      hostLog(result.log);
      broadcastGameState();
      break;

    case 'return_cards':
      result = processReturn(G, fromPos, msg.cards);
      if (!result.ok) { sendError(fromPos, result.error); return; }
      hostLog(result.log);
      broadcastGameState();
      // Meld is now on display — move to play after a viewing period
      clearTimeout(meldTimer);
      meldTimer = setTimeout(() => hostBeginPlay(), MELD_DISPLAY_MS);
      break;

    case 'begin_play':
      // Any player closing the meld summary starts play for everyone
      hostBeginPlay();
      break;

    case 'play_card':
      if (animHold) { return; } // trick still on display — ignore stray clicks
      result = processPlayCard(G, fromPos, msg.card);
      if (!result.ok) { sendError(fromPos, result.error); return; }
      hostLog(result.log);
      if (result.trickDone) {
        // Settle the outcome immediately (so no message racing the display
        // window can act on a stale state), then broadcast the completed
        // 4-card trick, and after a pause the resolved state.
        if (result.roundOver) G.winner = checkWinner(G);
        const snap = result.trickSnapshot;
        const savedTrick   = G.currentTrick;
        const savedLedSuit = G.trickLedSuit;
        G.currentTrick = snap.cards;
        G.trickLedSuit = snap.ledSuit;
        broadcastGameState();
        G.currentTrick = savedTrick;
        G.trickLedSuit = savedLedSuit;
        animHold = true; // defer further broadcasts while the trick shows
        setTimeout(() => {
          animHold = false;
          broadcastGameState();
        }, TRICK_DISPLAY_MS);
      } else {
        broadcastGameState();
      }
      break;

    case 'next_round':
      // Only the host advances rounds (its button is the only one shown)
      if (fromPos !== myPos) return;
      if (G.phase !== 'round_over' || G.winner || animHold) return;
      startNextRound();
      break;
  }
}

function hostBeginPlay() {
  clearTimeout(meldTimer); meldTimer = null;
  if (!G || G.phase !== 'meld') return;
  const r = startPlaying(G);
  if (r.ok) hostLog(r.log);
  broadcastGameState();
}

function startNextRound() {
  G = newRound(G);
  dealCards(G);
  hostLog(`Round ${G.roundNum} — ${G.dealer} deals`);
  broadcastGameState();
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────

/** Record a log line; it rides along with the next state broadcast */
function hostLog(msg) {
  if (!msg) return;
  logSeq++;
  if (G) G.lastLog = { seq: logSeq, msg };
}

/**
 * Broadcast state to all players. Each player gets a redacted view.
 * The host applies its own view; bots are then given a turn.
 */
function broadcastGameState() {
  if (!G) return;
  // While a finished trick is on display, hold updates — the display-end
  // timeout always broadcasts the resolved state.
  if (animHold) return;
  for (const [pos, conn] of Object.entries(dataConns)) {
    if (POSITIONS.includes(pos)) sendConn(conn, { type:'game_state', state: buildPlayerView(G, pos) });
  }
  applyGameState(buildPlayerView(G, myPos));
  maybeScheduleBot();
}

/**
 * Build a view of G for a specific player:
 * - Their own hand: full; opponents: card count only
 * - Dealt hands hidden until round_over
 * - Passed/returned card ids only for the two players involved
 */
function buildPlayerView(state, forPos) {
  const v = JSON.parse(JSON.stringify(state));
  for (const p of POSITIONS) {
    if (p !== forPos) {
      v.hands[p] = { count: state.hands[p].length };
      if (state.phase !== 'round_over') {
        v.dealtHands[p] = { count: state.dealtHands[p].length };
      }
    }
  }
  const involved = state.highBidder &&
    (forPos === state.highBidder || forPos === partnerOf(state.highBidder));
  if (!involved) { v.passedIds = []; v.returnedIds = []; }

  // No-peek: the held cards (and their ids) stay hidden from the bidder
  // until they have chosen their returns; only the count travels.
  v.pendingPass = { count: state.pendingPass.length };
  if (state.phase === 'returning' && state.rules.passPeek === 'no_peek' &&
      forPos === state.highBidder) {
    v.passedIds = [];
  }

  v.forPos = forPos; // lets a client recover its seat if 'welcome' was missed

  // Names/bot flags for rendering (strip peer ids)
  v.players = {};
  for (const p of POSITIONS) {
    const info = playerMap[p];
    v.players[p] = info ? { name: info.name, bot: !!info.bot } : null;
  }
  return v;
}

function sendError(pos, error) {
  if (playerMap[pos]?.bot) { console.warn('Bot error at', pos, error); return; }
  if (pos === myPos) { log('⚠ ' + error); return; }
  const conn = dataConns[pos];
  if (conn) sendConn(conn, { type:'error', error });
}

// ── Bots ──────────────────────────────────────────────────────────────────────

function isBotSeat(pos) { return !!playerMap[pos]?.bot; }

/** Whose input does the current phase need? */
function currentActor(state) {
  switch (state.phase) {
    case 'bidding':      return state.currentBidder;
    case 'naming_trump': return state.highBidder;
    case 'passing':      return partnerOf(state.highBidder);
    case 'returning':    return state.highBidder;
    case 'playing':      return nextToPlay(state);
    default:             return null;
  }
}

/** After every state change, let a bot act if it's a bot's turn */
function maybeScheduleBot() {
  if (!isHost || !G || G.winner) return;
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  if (animHold) return;

  const actor = currentActor(G);
  if (!actor || !isBotSeat(actor)) return;

  const delay = G.phase === 'playing' ? 650 + Math.random() * 550
                                      : 900 + Math.random() * 700;
  botTimer = setTimeout(() => {
    botTimer = null;
    if (!G || animHold) { maybeScheduleBot(); return; }
    const actorNow = currentActor(G);
    if (!actorNow || !isBotSeat(actorNow)) return;

    // If the bot's choice is somehow rejected, fall back to an action
    // that is legal by construction — a stuck bot must never freeze the game
    const sigOf = () => G ? [G.phase, G.highBid, JSON.stringify(G.bids), G.currentTrick.length,
                             POSITIONS.map(p => G.hands[p].length).join(','), G.trump].join('|') : '';
    const before = sigOf();
    const act = botDecide(G, actorNow);
    if (act) onHostReceive(act, actorNow);
    if (G && sigOf() === before) {
      console.warn('bot action rejected — using fallback', actorNow, act?.action);
      const fb = botFallback(G, actorNow);
      if (fb) onHostReceive(fb, actorNow);
      if (G && sigOf() === before) broadcastGameState(); // give humans a live view anyway
    }
  }, delay);
}

// ── Client receive ────────────────────────────────────────────────────────────

function onClientReceive(msg) {
  switch (msg.type) {
    case 'welcome':
      myPos = msg.pos;
      for (const [p, info] of Object.entries(msg.playerMap)) playerMap[p] = info;
      updateLobbyList();
      connectVideoMesh();
      break;

    case 'player_joined':
      playerMap[msg.pos] = { name: msg.name, peerId: msg.peerId };
      updateLobbyList();
      // The joiner normally calls us; if they can't (no camera), call them
      ensureVideoCall(msg.peerId);
      break;

    case 'player_update':
      playerMap[msg.pos] = { name: msg.name, bot: !!msg.bot };
      break;

    case 'player_left':
      detachVideo(msg.pos, playerMap[msg.pos]?.peerId);
      playerMap[msg.pos] = null;
      updateLobbyList();
      break;

    case 'start_game':
      for (const [p, info] of Object.entries(msg.playerMap || {})) playerMap[p] = info;
      if (!myPos && msg.state?.forPos) myPos = msg.state.forPos;
      enterGame();
      applyGameState(msg.state);
      break;

    case 'game_state':
      if (!myPos && msg.state?.forPos) myPos = msg.state.forPos;
      applyGameState(msg.state);
      break;

    case 'host_left':
      alert('The host left the game.');
      location.reload();
      break;

    case 'error':
      if (!document.getElementById('game').classList.contains('active')) {
        setStatus('join', '⚠ ' + msg.error);
      } else {
        log('⚠ ' + msg.error);
      }
      break;
  }
}
