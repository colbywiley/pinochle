// ══════════════════════════════════════════
//  game.js — host-side game state machine
//  The host is the single authority for G.
//  All actions flow through onHostReceive.
// ══════════════════════════════════════════

let G = null; // global game state (full on host, redacted on clients)

// ── Host receive ─────────────────────────────────────────────────────────────

function onHostReceive(msg, fromPos) {
  if (!G) return;
  let result;

  switch (msg.action) {
    case 'bid':
      result = processBid(G, fromPos, msg.amount);
      if (!result.ok) { sendError(fromPos, result.error); return; }
      log(result.log);
      if (result.stuckDealer) notifyStuck(result.stuckDealer);
      // Bid winner names trump first, THEN passes cards
      if (result.biddingDone) transitionToNamingTrump();
      else broadcastGameState();
      break;

    case 'name_trump':
      result = processTrump(G, fromPos, msg.suit);
      if (!result.ok) { sendError(fromPos, result.error); return; }
      log(result.log);
      // Trump named — now declarer passes 3 cards to partner
      broadcastGameState();
      break;

    case 'pass_cards':
      result = processPass(G, fromPos, msg.cards);
      if (!result.ok) { sendError(fromPos, result.error); return; }
      log(result.log);
      transitionToDiscard();
      break;

    case 'discard_cards':
      result = processDiscard(G, fromPos, msg.cards);
      if (!result.ok) { sendError(fromPos, result.error); return; }
      log(result.log);
      // Hands are final, meld was calculated — show meld modal, then auto-advance
      broadcastGameState();
      setTimeout(() => {
        if (G && G.phase === 'meld') {
          startPlaying(G);
          broadcastGameState();
        }
      }, 6000);
      break;

    case 'play_card':
      result = processPlayCard(G, fromPos, msg.card);
      if (!result.ok) { sendError(fromPos, result.error); return; }
      log(result.log);
      if (result.trickDone) {
        // Broadcast the 4-card trick state BEFORE resolving so UI can animate
        // Store trick data before resolve clears it
        const trickSnapshot = result.trickSnapshot;
        if (trickSnapshot) {
          // Temporarily restore the 4-card trick for broadcast
          const savedTrick = G.currentTrick;
          const savedLedSuit = G.trickLedSuit;
          G.currentTrick = trickSnapshot.cards;
          G.trickLedSuit = trickSnapshot.ledSuit;
          broadcastGameState();
          G.currentTrick = savedTrick;
          G.trickLedSuit = savedLedSuit;
          // After a delay, broadcast the resolved state
          setTimeout(() => {
            broadcastGameState();
            if (result.roundOver) checkAndBroadcastWinner();
          }, 1800);
        } else {
          broadcastGameState();
          if (result.roundOver) checkAndBroadcastWinner();
        }
      } else {
        broadcastGameState();
      }
      break;

    case 'next_round':
      if (fromPos !== 'south' && fromPos !== G.lastRoundResult?.bidTeam) {
        // Any player can trigger — host just needs one signal
      }
      startNextRound();
      break;
  }
}

// ── State transitions ─────────────────────────────────────────────────────────

function transitionToPassing() {
  G.phase = 'passing';
  broadcastGameState();
}

function transitionToDiscard() {
  // Partner now sees 3 received cards, must discard 3
  G.phase = 'discarding';
  broadcastGameState();
}

function transitionToNamingTrump() {
  G.phase = 'naming_trump';
  broadcastGameState();
}

function notifyStuck(dealerPos) {
  broadcastGameState();
}

function checkAndBroadcastWinner() {
  const winner = checkWinner(G);
  if (winner) {
    G.winner = winner;
  }
  broadcastGameState();
}

function startNextRound() {
  G = newRound(G);
  dealCards(G);
  broadcastGameState();
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────

/**
 * Broadcast state to all players.
 * Each player gets a redacted version (can't see opponents' hands).
 * Host applies own view directly.
 */
function broadcastGameState() {
  // Solo mode: no network, just re-render locally with full visibility
  if (soloMode) {
    applyGameStateSolo();
    return;
  }
  for (const [pos, conn] of Object.entries(dataConns)) {
    const view = buildPlayerView(G, pos);
    sendConn(conn, { type:'game_state', state: view });
  }
  // Host applies its own view
  applyGameState(buildPlayerView(G, myPos));
}

/**
 * Build a view of G for a specific player:
 * - Their own hand: full
 * - Opponent hands: card count only (as number)
 * - Dealt hands: hidden until round_over
 */
function buildPlayerView(state, forPos) {
  const v = JSON.parse(JSON.stringify(state)); // deep clone
  for (const p of POSITIONS) {
    if (p !== forPos) {
      // Replace hand with count
      v.hands[p] = { count: state.hands[p].length };
      // Hide dealt hands until round_over
      if (state.phase !== 'round_over') {
        v.dealtHands[p] = { count: state.dealtHands[p].length };
      }
    }
  }
  // Partner's passed cards: partner sees them after they're passed (discarding phase)
  // Declarer should NOT see partner's hand before or after — handled by above
  return v;
}

function sendError(pos, error) {
  if (pos === myPos) { log('Error: ' + error); return; }
  const conn = dataConns[pos];
  if (conn) sendConn(conn, { type:'error', error });
}

// ── Client receive ────────────────────────────────────────────────────────────

function onClientReceive(msg) {
  switch (msg.type) {
    case 'welcome':
      myPos = msg.pos;
      for (const [p, info] of Object.entries(msg.playerMap)) playerMap[p] = info;
      updateLobbyList();
      break;

    case 'player_joined':
      playerMap[msg.pos] = { name: msg.name, peerId: msg.peerId };
      updateLobbyList();
      checkStartHint();
      break;

    case 'start_game':
      applyGameState(msg.state);
      enterGame();
      break;

    case 'game_state':
      applyGameState(msg.state);
      break;

    case 'error':
      log('⚠ ' + msg.error);
      break;
  }
}
