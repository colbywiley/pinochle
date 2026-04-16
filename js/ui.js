// ══════════════════════════════════════════
//  ui.js — rendering wired to anim.js
// ══════════════════════════════════════════

// ── Position helpers ──────────────────────────────────────────
// In solo mode: fixed perspective (south=south always, no rotation)
// In multiplayer: rotate so myPos always displays at south
function absToDisplay(absPos) {
  if (!myPos) return absPos;
  if (typeof soloMode !== 'undefined' && soloMode) return absPos;
  return ['south','west','north','east'][
    (POSITIONS.indexOf(absPos) - POSITIONS.indexOf(myPos) + 4) % 4];
}
function displayToAbs(dispPos) {
  if (!myPos) return dispPos;
  if (typeof soloMode !== 'undefined' && soloMode) return dispPos;
  const di = ['south','west','north','east'].indexOf(dispPos);
  return POSITIONS[(POSITIONS.indexOf(myPos) + di) % 4];
}

// ── State tracking ────────────────────────────────────────────
let prevPhase      = null;
let prevTrickLen   = 0;
let lastTrickKeys  = [];
let animBusy       = false;

let passSelectedCards = [];

// ── Top-level state application ───────────────────────────────

async function applyGameState(state) {
  const prev = G ? JSON.parse(JSON.stringify(G)) : null;
  G = state;

  renderTopBar();
  renderSeats();
  renderActionPanel();
  renderPassPanel();
  renderDiscardPanel();
  renderMeldSidebar();

  const phaseChanged = G.phase !== prevPhase;
  const myHandArr    = Array.isArray(G.hands?.[myPos]) ? G.hands[myPos] : [];
  const prevHandArr  = Array.isArray(prev?.hands?.[myPos]) ? prev.hands[myPos] : [];

  // ── NEW DEAL ──────────────────────────────────────────────
  if (prevHandArr.length === 0 && myHandArr.length === 12 && G.phase === 'bidding') {
    await doNewDeal();
  }

  // ── TRUMP BURST ───────────────────────────────────────────
  if (phaseChanged && G.phase === 'meld' && G.trump) {
    animTrumpBurst(G.trump);
    await wait(300);
    refreshAllHands();
  }

  // ── CARD PLAYED INTO TRICK ────────────────────────────────
  const trickLen = G.currentTrick?.length ?? 0;
  if (trickLen > prevTrickLen && trickLen > 0 && G.phase === 'playing') {
    const newest  = G.currentTrick[trickLen - 1];
    const dispFrom = absToDisplay(newest.seat);
    await animPlayCard(newest.card, dispFrom);
    // Update hand display
    if (newest.seat === myPos) {
      rebuildMyHandFan();
    } else if (typeof soloMode !== 'undefined' && soloMode) {
      // Solo: re-fan that seat's real hand face-up
      const dispFrom2 = absToDisplay(newest.seat);
      const hand2 = Array.isArray(G.hands?.[newest.seat]) ? [...G.hands[newest.seat]] : [];
      sortHand(hand2, G.trump);
      rebuildHandFan(dispFrom2, hand2, { selKeys:[], legalKeys:[], clickable:false, onCardClick:null });
    } else {
      const cnt = G.hands[newest.seat]?.count ?? 0;
      rebuildOppStubs(dispFrom, cnt);
    }
  }

  // ── TRICK SWEEP ───────────────────────────────────────────
  if (prevTrickLen === 4 && trickLen === 0 && G.phase === 'playing') {
    if (lastTrickKeys.length === 4) {
      const winnerAbs  = prev?.trickLeader || G.trickLeader;
      const winnerDisp = absToDisplay(winnerAbs);
      await animTrickSweep(winnerDisp, lastTrickKeys);
      lastTrickKeys = [];
      refreshAllHands();
    }
  }

  // Track trick for sweep
  if (trickLen === 4) {
    lastTrickKeys = G.currentTrick.map(t => cardKey(t.card));
  }
  prevTrickLen = trickLen;
  prevPhase    = G.phase;

  // Solo mode: always refresh hands to ensure correct interactivity
  // after seat switches and phase changes (deal/trump/sweep paths handle
  // their own refresh, but seat switches and phase transitions don't)
  if (typeof soloMode !== 'undefined' && soloMode && !animBusy) {
    refreshAllHands();
  }

  checkModals();

  // Solo mode: update turn indicator after every state change
  if (typeof soloMode !== 'undefined' && soloMode) updateSoloSwitcher();
}

// ── NEW DEAL SEQUENCE ─────────────────────────────────────────

async function doNewDeal() {
  animBusy = true;
  passSelectedCards = [];
  clearAllCards();
  await wait(250);
  await animShuffle();

  const handsData = {};
  for (const absPos of POSITIONS) {
    if (typeof soloMode !== 'undefined' && soloMode) {
      handsData[absPos] = G.hands[absPos];
    } else {
      handsData[absPos] = absPos === myPos ? G.hands[myPos] : null;
    }
  }
  await animDeal(handsData);
  animBusy = false;
  refreshAllHands();
}

// ── HAND REFRESH ─────────────────────────────────────────────

function refreshAllHands() {
  if (typeof soloMode !== 'undefined' && soloMode) {
    for (const absPos of POSITIONS) {
      const dispPos = absToDisplay(absPos);
      const hand    = Array.isArray(G.hands?.[absPos]) ? [...G.hands[absPos]] : [];
      sortHand(hand, G.trump);
      if (!hand.length) continue;
      if (absPos === myPos) {
        refreshMyHandInteraction(hand);
      } else {
        rebuildHandFan(dispPos, hand, { selKeys:[], legalKeys:[], clickable:false, onCardClick:null });
      }
    }
    return;
  }
  rebuildMyHandFan();
  for (const disp of ['west','north','east']) {
    const absPos    = displayToAbs(disp);
    const countData = G.hands?.[absPos];
    const count     = countData?.count ?? (Array.isArray(countData) ? countData.length : 0);
    rebuildOppStubs(disp, count);
  }
}

function soloWhoseTurn() {
  if (!G) return null;
  if (G.phase === 'bidding')      return G.currentBidder;
  if (G.phase === 'naming_trump') return G.highBidder;
  if (G.phase === 'passing') {
    // Declarer and partner pass simultaneously — pick whichever hasn't yet
    const bidder  = G.highBidder;
    const partner = partnerOf(bidder);
    if (!G.pendingPass?.[bidder])  return bidder;
    if (!G.pendingPass?.[partner]) return partner;
    return null; // both done — waiting for exchange→meld transition
  }
  if (G.phase === 'playing') {
    if (!G.currentTrick?.length) return G.trickLeader;
    return leftOf(G.currentTrick[G.currentTrick.length-1].seat);
  }
  return null;
}

function rebuildMyHandFan() {
  const hand = Array.isArray(G.hands?.[myPos]) ? [...G.hands[myPos]] : [];
  sortHand(hand, G.trump);
  refreshMyHandInteraction(hand);
}

function refreshMyHandInteraction(hand) {
  hand = hand || (Array.isArray(G.hands?.[myPos]) ? [...G.hands[myPos]] : []);
  sortHand(hand, G.trump);
  if (!hand.length) return;

  // In the new simultaneous-pass model, EITHER the declarer or the partner
  // can be selecting their 3 cards — as long as they haven't already passed.
  const bidder  = G.highBidder;
  const partner = bidder ? partnerOf(bidder) : null;
  const isPassPhase = G.phase === 'passing'
                      && (myPos === bidder || myPos === partner)
                      && !G.pendingPass?.[myPos];
  const myTurn      = G.phase === 'playing' && isMyTurn();

  let legalKeys = [];
  if (myTurn) legalKeys = legalPlays(G, myPos).map(c => cardKey(c));

  const selKeys = isPassPhase ? passSelectedCards.map(c => cardKey(c)) : [];

  const clickable = isPassPhase || myTurn;

  const myDisp = absToDisplay(myPos);
  rebuildHandFan(myDisp, hand, {
    selKeys,
    legalKeys: myTurn ? legalKeys : (clickable ? hand.map(c => cardKey(c)) : []),
    clickable,
    onCardClick: card => {
      if (isPassPhase) { togglePassSelect(card); return; }
      if (myTurn && legalKeys.includes(cardKey(card))) {
        sendToHost({ action: 'play_card', card });
      }
    }
  });
}

function isMyTurn() {
  if (G.phase !== 'playing') return false;
  if (!G.currentTrick?.length) return G.trickLeader === myPos;
  return leftOf(G.currentTrick[G.currentTrick.length - 1].seat) === myPos;
}

function getLegalPlaysLocal() { return legalPlays(G, myPos); }

// ── TOP BAR ──────────────────────────────────────────────────

function renderTopBar() {
  const PHASE_LABELS = {
    bidding:'Bidding', naming_trump:'Name Trump', passing:'Passing',
    meld:'Meld', playing:'Playing', round_over:'Round Over'
  };
  document.getElementById('phase-label').textContent = PHASE_LABELS[G.phase] || G.phase;

  const bs = document.getElementById('bid-summary');
  bs.textContent = (G.highBid > 0 && G.highBidder)
    ? `· ${playerMap[G.highBidder]?.name || G.highBidder} ${G.highBid}` : '';

  const td = document.getElementById('trump-display');
  if (G.trump) {
    td.textContent   = `Trump: ${SUIT_SYM[G.trump]}`;
    td.style.display = 'block';
    td.className     = RED_SUITS.has(G.trump) ? 'red' : '';
  } else td.style.display = 'none';

  document.getElementById('score-ns').textContent = G.scores.ns;
  document.getElementById('score-ew').textContent = G.scores.ew;
  document.getElementById('score-ns-wrap').className = 'score-team' +
    (G.scores.ns >= 150 ? ' winning' : G.scores.ns < 0 ? ' at-risk' : '');
  document.getElementById('score-ew-wrap').className = 'score-team' +
    (G.scores.ew >= 150 ? ' winning' : G.scores.ew < 0 ? ' at-risk' : '');

  const nsNames = POSITIONS.filter(p=>teamOf(p)==='ns').map(p=>playerMap[p]?.name||p).join('/');
  const ewNames = POSITIONS.filter(p=>teamOf(p)==='ew').map(p=>playerMap[p]?.name||p).join('/');
  document.getElementById('score-ns-name').textContent = nsNames || 'NS';
  document.getElementById('score-ew-name').textContent = ewNames || 'EW';

  document.getElementById('tt-ns').textContent = G.tricksWon?.ns ?? 0;
  document.getElementById('tt-ew').textContent = G.tricksWon?.ew ?? 0;

  for (const p of POSITIONS) {
    const wrap = document.querySelector(`#seat-${absToDisplay(p)} .seat-video-wrap`);
    if (wrap) wrap.classList.toggle('is-dealer', p === G.dealer);
  }
}

// ── SEATS ────────────────────────────────────────────────────

function renderSeats() {
  // Determine whose turn it is for the active-turn indicator.
  // During passing, both declarer and partner are "active" (simultaneous) —
  // we highlight whichever hasn't submitted yet so the indicator still moves.
  let activeSeat = null;
  if (G.phase === 'bidding')           activeSeat = G.currentBidder;
  else if (G.phase === 'naming_trump') activeSeat = G.highBidder;
  else if (G.phase === 'passing') {
    const bidder  = G.highBidder;
    const partner = partnerOf(bidder);
    if (!G.pendingPass?.[bidder])       activeSeat = bidder;
    else if (!G.pendingPass?.[partner]) activeSeat = partner;
  }
  else if (G.phase === 'playing') {
    if (!G.currentTrick?.length) activeSeat = G.trickLeader;
    else activeSeat = leftOf(G.currentTrick[G.currentTrick.length-1].seat);
  }

  for (const pos of POSITIONS) {
    const disp   = absToDisplay(pos);
    const info   = playerMap[pos];
    const nameEl = document.getElementById('name-' + disp);
    if (nameEl) nameEl.textContent = info ? (pos===myPos?'You · '+info.name : info.name) : '—';

    // Turn indicator glow
    const seatEl = document.getElementById('seat-' + disp);
    if (seatEl) seatEl.classList.toggle('active-turn', pos === activeSeat);

    const badge = document.getElementById('badge-' + disp);
    if (badge) {
      const b = G.bids?.[pos];
      if (b !== null && b !== undefined) {
        badge.textContent = b===0 ? 'Pass' : String(b);
        badge.className   = 'bid-badge visible' + (b===0?' pass':'');
      } else badge.className = 'bid-badge';
    }
  }
}

// ── ACTION PANEL ─────────────────────────────────────────────

function renderActionPanel() {
  const panel = document.getElementById('action-panel');
  panel.innerHTML = ''; panel.classList.remove('visible'); panel.classList.remove('play-hint');

  // Show bid panel when it's myPos's turn and they haven't passed (null or >0 bid)
  if (G.phase === 'bidding' && G.currentBidder === myPos && G.bids?.[myPos] !== 0) {
    panel.classList.add('visible');
    const minBid = Math.max(MIN_BID, G.highBid + 1);
    const allOthersPassed = POSITIONS.filter(p=>p!==G.dealer).every(p=>G.bids[p]===0);
    const isStuck = G.dealer === myPos && allOthersPassed && G.highBid === 0;
    const seatName = myPos.charAt(0).toUpperCase() + myPos.slice(1);

    // Current bid status line
    if (G.highBid > 0 && G.highBidder) {
      const bidderName = playerMap[G.highBidder]?.name || G.highBidder;
      const status = document.createElement('div');
      status.className = 'ap-status';
      status.textContent = `Current high bid: ${G.highBid} by ${bidderName}`;
      panel.appendChild(status);
    } else {
      const status = document.createElement('div');
      status.className = 'ap-status';
      status.textContent = 'No bids yet — minimum bid is 25';
      panel.appendChild(status);
    }

    const row = document.createElement('div');
    row.className = 'ap-row';

    const label = document.createElement('span');
    label.className = 'ap-label';
    label.textContent = isStuck ? `${seatName} must bid:` : `${seatName}'s Bid:`;
    row.appendChild(label);

    const inp = document.createElement('input');
    inp.type='number'; inp.id='bid-input'; inp.min=minBid; inp.max=99; inp.value=minBid;
    const getBidAmount = () => { const v = parseInt(inp.value); return isNaN(v) ? minBid : v; };
    inp.addEventListener('keydown', e => { if(e.key==='Enter') sendToHost({ action:'bid', amount:getBidAmount() }); });
    row.appendChild(inp);

    const bidBtn = document.createElement('button');
    bidBtn.className='btn'; bidBtn.textContent='Bid';
    bidBtn.onclick = () => sendToHost({ action:'bid', amount:getBidAmount() });
    row.appendChild(bidBtn);

    if (!isStuck) {
      const passBtn = document.createElement('button');
      passBtn.className='btn btn-outline'; passBtn.textContent='Pass';
      passBtn.onclick = () => sendToHost({ action:'bid', amount:0 });
      row.appendChild(passBtn);
    }

    panel.appendChild(row);
    setTimeout(()=>inp?.focus(), 60);
  }

  if (G.phase === 'playing' && isMyTurn()) {
    panel.classList.add('visible', 'play-hint');
    const seatName = myPos.charAt(0).toUpperCase() + myPos.slice(1);
    const lbl = document.createElement('span');
    lbl.className = 'ap-label';
    lbl.textContent = !G.currentTrick?.length
      ? `${seatName} leads — click a card`
      : `${seatName}'s turn — must head if able`;
    panel.appendChild(lbl);
    if (G.trump) {
      const trump = document.createElement('span');
      trump.className = 'ap-trump';
      trump.textContent = `Trump: ${SUIT_SYM[G.trump]}`;
      trump.style.cssText = `font-size:1rem; margin-left:12px; color:${RED_SUITS.has(G.trump)?'#ff6666':'var(--cream)'}`;
      lbl.appendChild(trump);
    }
  }

  // Waiting message when it's not your turn during play
  if (G.phase === 'playing' && !isMyTurn()) {
    const whosTurn = soloWhoseTurn ? soloWhoseTurn() : null;
    // Only show in non-solo mode (solo auto-switches)
    if (!soloMode && whosTurn) {
      panel.classList.add('visible', 'play-hint');
      const name = playerMap[whosTurn]?.name || whosTurn;
      const lbl = document.createElement('span');
      lbl.className = 'ap-label';
      lbl.style.opacity = '0.7';
      lbl.textContent = `Waiting for ${name}...`;
      panel.appendChild(lbl);
    }
  }
}

// ── PASS / DISCARD ────────────────────────────────────────────

function renderPassPanel() {
  const p = document.getElementById('pass-panel');
  if (!p) return;

  const bidder  = G.highBidder;
  const partner = bidder ? partnerOf(bidder) : null;
  const isPasser   = myPos === bidder || myPos === partner;
  const haveIPassed = !!G.pendingPass?.[myPos];
  const showPanel   = G.phase === 'passing' && isPasser && !haveIPassed;

  if (showPanel) {
    p.style.display = 'flex';

    const title = p.querySelector('.pass-title');
    if (title) {
      const partnerLabel = myPos === bidder
        ? `your partner (${partner})`
        : `the declarer (${bidder})`;
      title.textContent = `Pick 3 cards to pass to ${partnerLabel}`;
    }

    document.getElementById('pass-selected-display').textContent =
      passSelectedCards.length === 0 ? 'Click 3 cards in your hand to pass' :
      passSelectedCards.map(c => c.r + SUIT_SYM[c.s]).join(' · ');
    document.getElementById('pass-confirm-btn').disabled = passSelectedCards.length !== 3;
  } else {
    p.style.display = 'none';
  }
}

// Discard phase no longer exists — the pass is now a simultaneous exchange.
// This stub keeps any stale callers from crashing.
function renderDiscardPanel() {
  const p = document.getElementById('discard-panel');
  if (p) p.style.display = 'none';
}

function togglePassSelect(card) {
  const idx = passSelectedCards.findIndex(c=>sameCard(c,card));
  if (idx >= 0) passSelectedCards.splice(idx, 1);
  else if (passSelectedCards.length < 3) passSelectedCards.push(card);
  refreshMyHandInteraction(); renderPassPanel();
}

async function confirmPass() {
  if (passSelectedCards.length !== 3) return;
  const cards = [...passSelectedCards];
  passSelectedCards = [];

  const toDisp   = absToDisplay(partnerOf(myPos));
  const fromDisp = absToDisplay(myPos);

  // Fly the 3 selected cards toward partner (face-down for no-peek feel).
  await animPassCards(cards, fromDisp, toDisp);

  // Remove them from the DOM — they're now in pendingPass server-side.
  // When the exchange completes, refreshAllHands will re-create them in
  // their new owner's fan.
  for (const c of cards) {
    const key = cardKey(c);
    const entry = CARD_REGISTRY[key];
    if (entry) {
      entry.el.remove();
      delete CARD_REGISTRY[key];
    }
  }

  sendToHost({ action:'pass_cards', cards });
}

// ── MELD SIDEBAR ─────────────────────────────────────────────

function renderMeldSidebar() {
  const sidebar = document.getElementById('meld-sidebar');
  if (G.phase !== 'meld' && G.phase !== 'playing') { sidebar.style.display='none'; return; }
  sidebar.style.display='block';
  const rows = document.getElementById('meld-rows');
  rows.innerHTML = '';
  for (const pos of POSITIONS) {
    const name  = playerMap[pos]?.name || pos;
    const total = G.meld?.[pos] ?? 0;
    const brk   = G.meldBreak?.[pos] ?? [];
    const block = document.createElement('div');
    block.className = 'meld-player-block';
    block.innerHTML = `<div class="meld-player-name">${name}${pos===myPos?' ★':''}</div>
      <div class="meld-player-total">${total}</div>
      <div class="meld-detail">${brk.map(([l,v])=>`${l}: ${v}`).join('<br>')||'—'}</div>`;
    rows.appendChild(block);
  }
}

// ── MODALS ────────────────────────────────────────────────────

function checkModals() {
  const showTrump = G.phase === 'naming_trump' && G.highBidder === myPos;
  document.getElementById('trump-modal').classList.toggle('visible', showTrump);
  if (showTrump) document.getElementById('won-bid-amt').textContent = G.highBid;

  if (G.phase === 'meld') showMeldModal();
  else document.getElementById('meld-modal').classList.remove('visible');

  if (G.phase === 'round_over') showRoundModal();
  else document.getElementById('round-modal').classList.remove('visible');

  if (G.winner) showGameOver();
  else document.getElementById('gameover-modal').classList.remove('visible');
}

function showMeldModal() {
  const modal = document.getElementById('meld-modal');
  if (modal.classList.contains('visible')) return;
  modal.classList.add('visible');
  const content = document.getElementById('meld-modal-content');
  content.innerHTML = '';
  for (const pos of POSITIONS) {
    const name  = playerMap[pos]?.name || pos;
    const total = G.meld?.[pos] ?? 0;
    const brk   = G.meldBreak?.[pos] ?? [];
    const div   = document.createElement('div');
    div.className = 'meld-modal-player';
    div.innerHTML = `<div class="meld-modal-name">${name} (${pos.toUpperCase()})</div>
      <div class="meld-modal-total">${total} pts</div>
      <div class="meld-modal-breakdown">${brk.map(([l,v])=>`${l}: ${v}`).join('<br>')||'No meld'}</div>`;
    content.appendChild(div);
  }
  const partner  = partnerOf(G.highBidder);
  const teamMeld = (G.meld?.[G.highBidder]??0) + (G.meld?.[partner]??0);
  document.getElementById('meld-modal-note').textContent =
    `Team meld: ${teamMeld} · Bid: ${G.highBid} · Need ${Math.max(0,G.highBid-teamMeld)} more from tricks`;
}
function closeMeldModal() {
  document.getElementById('meld-modal').classList.remove('visible');
  // Immediately advance to playing phase (don't wait for 6s timeout)
  if (isHost && G && G.phase === 'meld') {
    startPlaying(G);
    broadcastGameState();
  }
  renderMeldSidebar();
}

function showRoundModal() {
  document.getElementById('round-modal').classList.add('visible');
  const r = G.lastRoundResult;
  if (!r) return;
  const bidderName = playerMap[r.highBidder]?.name || r.highBidder;
  document.getElementById('round-title').innerHTML = r.bidMet
    ? `<span class="round-made">✓ Bid Made</span>`
    : `<span class="round-missed">✗ Bid Missed — Set Back</span>`;
  const rows = [
    ['Bidder', `${bidderName} (${r.highBidder.toUpperCase()})`],
    ['Trump', SUIT_SYM[r.trump]],
    ['Bid', r.highBid],
    ['Bid team meld', r.teamMeld],
    ['Bid team tricks', r.bidTrickPts],
    ['Bid team total', r.bidTotal],
    ['Other team meld', r.enemMeld],
    ['Other team tricks', r.enemTrickPts],
    ['NS score', r.nsScore],
    ['EW score', r.ewScore],
  ];
  document.getElementById('round-content').innerHTML =
    rows.map(([l,v])=>`<div class="round-row"><span class="rl">${l}</span><span class="rv">${v}</span></div>`).join('');
  document.getElementById('next-round-btn').style.display = isHost ? 'inline-flex' : 'none';
}

function showDealReview() {
  document.getElementById('round-modal').classList.remove('visible');
  document.getElementById('review-modal').classList.add('visible');
  document.getElementById('review-round-num').textContent = G.roundNum - 1;
  const content = document.getElementById('review-content');
  content.innerHTML = '';
  for (const pos of POSITIONS) {
    const name   = playerMap[pos]?.name || pos;
    const hand   = G.dealtHands?.[pos] || [];
    const isArr  = Array.isArray(hand);
    const sorted = isArr ? [...hand] : [];
    if (isArr) sortHand(sorted, G.trump);
    const div = document.createElement('div');
    div.className='review-hand-block';
    div.innerHTML=`<div class="review-hand-name">${name} (${pos.toUpperCase()})</div>
      <div class="review-cards">${isArr
        ? sorted.map(c=>`<span class="review-card${RED_SUITS.has(c.s)?' red':''}">${c.r}${SUIT_SYM[c.s]}</span>`).join('')
        : '<em style="opacity:0.4">hidden</em>'}</div>`;
    content.appendChild(div);
  }
}
function closeReviewModal() {
  document.getElementById('review-modal').classList.remove('visible');
  document.getElementById('round-modal').classList.add('visible');
}

function showGameOver() {
  document.getElementById('gameover-modal').classList.add('visible');
  const ns = POSITIONS.filter(p=>teamOf(p)==='ns').map(p=>playerMap[p]?.name||p).join(' & ');
  const ew = POSITIONS.filter(p=>teamOf(p)==='ew').map(p=>playerMap[p]?.name||p).join(' & ');
  document.getElementById('winner-text').textContent = `${G.winner==='ns'?ns:ew} Win!`;
  document.getElementById('gameover-msg').textContent =
    `Final Score — NS: ${G.scores.ns}  ·  EW: ${G.scores.ew}`;
}

function selectTrump(suit) {
  sendToHost({ action:'name_trump', suit });
  document.getElementById('trump-modal').classList.remove('visible');
}

function nextRound() {
  if (isHost) startNextRound(); else sendToHost({ action:'next_round' });
  document.getElementById('round-modal').classList.remove('visible');
}

function log(msg) {
  const el   = document.getElementById('log');
  const line = document.createElement('div');
  line.textContent = msg;
  el.prepend(line);
  while (el.children.length > 7) el.removeChild(el.lastChild);
}
