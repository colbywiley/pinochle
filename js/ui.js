// ══════════════════════════════════════════
//  ui.js — rendering wired to anim.js
//  Renders V, the redacted view received from the host.
//  V is never the authoritative state (that's G, host-only).
// ══════════════════════════════════════════

// ── Position helpers ──────────────────────────────────────────
// Rotate so myPos always displays at south
function absToDisplay(absPos) {
  if (!myPos) return absPos;
  return ['south','west','north','east'][
    (POSITIONS.indexOf(absPos) - POSITIONS.indexOf(myPos) + 4) % 4];
}
function displayToAbs(dispPos) {
  if (!myPos) return dispPos;
  const di = ['south','west','north','east'].indexOf(dispPos);
  return POSITIONS[(POSITIONS.indexOf(myPos) + di) % 4];
}

// ── State tracking ────────────────────────────────────────────
let V = null;                       // current view
let applyQueue = Promise.resolve(); // serialize state applications
let lastLogSeq   = 0;
let meldModalShownRound = 0;
let selectedKeys = [];              // selected card keys (pass / return phases)

function handArr(state, pos) {
  const h = state?.hands?.[pos];
  return Array.isArray(h) ? h : [];
}
function handCount(state, pos) {
  const h = state?.hands?.[pos];
  if (Array.isArray(h)) return h.length;
  return h?.count ?? 0;
}
function playerName(pos) {
  const info = V?.players?.[pos] || playerMap[pos];
  return info?.name || pos;
}

// ── Top-level state application ───────────────────────────────

function applyGameState(view) {
  applyQueue = applyQueue
    .then(() => doApplyState(view))
    .catch(e => console.error('applyGameState failed', e));
  return applyQueue;
}

async function doApplyState(view) {
  const prev = V;
  V = view;

  renderTopBar();
  renderSeats();
  renderActionPanel();
  renderPassPanels();
  renderMeldSidebar();
  renderLog();

  if (!animLayer) initAnimLayer();

  const newDeal = V.phase === 'bidding' &&
    (!prev || prev.phase === 'round_over' || prev.roundNum !== V.roundNum);

  if (newDeal) {
    selectedKeys = [];
    await doNewDeal();
  } else {
    // ── Card played into trick ──
    const tLen = V.currentTrick?.length ?? 0;
    const pLen = prev?.currentTrick?.length ?? 0;
    if (tLen > pLen && tLen > 0) {
      for (let i = pLen; i < tLen; i++) {
        const played = V.currentTrick[i];
        await animPlayCard(played.card, absToDisplay(played.seat));
      }
    }
    // ── Trick swept to winner ──
    if (pLen === 4 && tLen === 0) {
      const keys = prev.currentTrick.map(t => cardKey(t.card));
      await animTrickSweep(absToDisplay(V.trickLeader), keys);
    }
    // ── Pass / return observed (cards fly between partners) ──
    if (prev && prev.phase === 'passing' && V.phase === 'returning' &&
        myPos !== partnerOf(V.highBidder)) {
      await animFlyBacks(absToDisplay(partnerOf(V.highBidder)), absToDisplay(V.highBidder), 3);
    }
    if (prev && prev.phase === 'returning' && V.phase === 'meld' &&
        myPos !== V.highBidder) {
      await animFlyBacks(absToDisplay(V.highBidder), absToDisplay(partnerOf(V.highBidder)), 3);
    }
    if (prev && prev.phase !== V.phase && V.phase === 'meld' && V.trump) {
      animTrumpBurst(V.trump);
    }
    refreshAllHands();
  }

  checkModals();
}

// ── NEW DEAL SEQUENCE ─────────────────────────────────────────

async function doNewDeal() {
  clearAllCards();
  await wait(200);
  await animShuffle();

  const handsData = {};
  for (const absPos of POSITIONS) {
    handsData[absPos] = absPos === myPos ? handArr(V, myPos) : null;
  }
  await animDeal(handsData);
  refreshAllHands();
}

// ── HAND REFRESH ─────────────────────────────────────────────

function refreshAllHands() {
  if (!V) return;
  rebuildMyHandFan();
  for (const disp of ['west','north','east']) {
    rebuildOppStubs(disp, handCount(V, displayToAbs(disp)));
  }
  // Remove any card elements that are no longer mine or on the table
  const valid = new Set(handArr(V, myPos).map(cardKey));
  for (const t of (V.currentTrick || [])) valid.add(cardKey(t.card));
  cleanupRegistry(valid);
}

function rebuildMyHandFan() {
  const hand = [...handArr(V, myPos)];
  sortHand(hand, V.trump);

  const isPassPhase   = V.phase === 'passing'   && partnerOf(V.highBidder) === myPos;
  const isReturnPhase = V.phase === 'returning' && V.highBidder === myPos;
  const myTurn        = isMyTurn();

  let legalKeys = [];
  if (myTurn) legalKeys = legalPlays(V, myPos).map(cardKey);
  else if (isPassPhase || isReturnPhase) legalKeys = hand.map(cardKey);

  const clickable = isPassPhase || isReturnPhase || myTurn;
  const receivedKeys = isReturnPhase ? (V.passedIds || []) : [];

  rebuildHandFan(absToDisplay(myPos), hand, {
    selKeys: clickable ? selectedKeys : [],
    legalKeys,
    receivedKeys,
    clickable,
    onCardClick: card => {
      if (isPassPhase || isReturnPhase) { toggleSelect(card); return; }
      if (isMyTurn() && legalPlays(V, myPos).some(c => cardKey(c) === cardKey(card))) {
        sendToHost({ action: 'play_card', card });
      }
    }
  });
}

function isMyTurn() {
  if (!V || V.phase !== 'playing') return false;
  if ((V.currentTrick?.length ?? 0) >= 4) return false; // trick on display
  return nextToPlay(V) === myPos;
}

// ── TOP BAR ──────────────────────────────────────────────────

const PHASE_LABELS = {
  bidding:'Bidding', naming_trump:'Name Trump', passing:'Passing',
  returning:'Passing Back', meld:'Meld', playing:'Playing', round_over:'Round Over'
};

function renderTopBar() {
  document.getElementById('phase-label').textContent = PHASE_LABELS[V.phase] || V.phase;

  const bs = document.getElementById('bid-summary');
  bs.textContent = (V.highBid > 0 && V.highBidder)
    ? `· ${playerName(V.highBidder)} ${V.highBid}` : '';

  const td = document.getElementById('trump-display');
  if (V.trump) {
    td.textContent   = `Trump: ${SUIT_SYM[V.trump]}`;
    td.style.display = 'block';
    td.className     = RED_SUITS.has(V.trump) ? 'red' : '';
  } else td.style.display = 'none';

  document.getElementById('score-ns').textContent = V.scores.ns;
  document.getElementById('score-ew').textContent = V.scores.ew;
  document.getElementById('score-ns-wrap').className = 'score-team' +
    (V.scores.ns >= GOAL ? ' winning' : V.scores.ns < 0 ? ' at-risk' : '');
  document.getElementById('score-ew-wrap').className = 'score-team' +
    (V.scores.ew >= GOAL ? ' winning' : V.scores.ew < 0 ? ' at-risk' : '');

  const nsNames = POSITIONS.filter(p=>teamOf(p)==='ns').map(playerName).join('/');
  const ewNames = POSITIONS.filter(p=>teamOf(p)==='ew').map(playerName).join('/');
  document.getElementById('score-ns-name').textContent = nsNames || 'NS';
  document.getElementById('score-ew-name').textContent = ewNames || 'EW';

  document.getElementById('tt-ns').textContent = V.tricksWon?.ns ?? 0;
  document.getElementById('tt-ew').textContent = V.tricksWon?.ew ?? 0;

  for (const p of POSITIONS) {
    const wrap = document.querySelector(`#seat-${absToDisplay(p)} .seat-video-wrap`);
    if (wrap) wrap.classList.toggle('is-dealer', p === V.dealer);
  }
}

// ── SEATS ────────────────────────────────────────────────────

function renderSeats() {
  const activeSeat = (V.currentTrick?.length ?? 0) >= 4 ? null : currentActor(V);

  for (const pos of POSITIONS) {
    const disp   = absToDisplay(pos);
    const info   = V.players?.[pos] || playerMap[pos];
    const nameEl = document.getElementById('name-' + disp);
    if (nameEl) {
      const nm = info ? info.name : '—';
      nameEl.textContent = pos === myPos
        ? (nm && nm !== 'You' ? 'You · ' + nm : 'You')
        : (info?.bot ? '🤖 ' + nm : nm);
    }

    const seatEl = document.getElementById('seat-' + disp);
    if (seatEl) seatEl.classList.toggle('active-turn', pos === activeSeat);

    const badge = document.getElementById('badge-' + disp);
    if (badge) {
      const b = V.bids?.[pos];
      if (V.phase === 'bidding' && b !== null && b !== undefined) {
        badge.textContent = b === 0 ? 'Pass' : String(b);
        badge.className   = 'bid-badge visible' + (b === 0 ? ' pass' : '');
      } else badge.className = 'bid-badge';
    }
  }
}

// ── ACTION PANEL ─────────────────────────────────────────────

function renderActionPanel() {
  const panel = document.getElementById('action-panel');
  panel.innerHTML = '';
  panel.classList.remove('visible', 'play-hint');

  // ── My bid turn: centered bid dialog ──
  if (V.phase === 'bidding' && V.currentBidder === myPos && V.bids?.[myPos] !== 0) {
    panel.classList.add('visible');
    const minBid = Math.max(MIN_BID, V.highBid + 1);
    const allOthersPassed = POSITIONS.filter(p=>p!==V.dealer).every(p=>V.bids[p]===0);
    const isStuck = V.dealer === myPos && allOthersPassed && V.highBid === 0;

    const status = document.createElement('div');
    status.className = 'ap-status';
    status.textContent = isStuck
      ? `Everyone passed — you're the dealer and must bid ${MIN_BID}`
      : (V.highBid > 0
          ? `Current high bid: ${V.highBid} by ${playerName(V.highBidder)}`
          : `No bids yet — minimum bid is ${MIN_BID}`);
    panel.appendChild(status);

    const row = document.createElement('div');
    row.className = 'ap-row';

    const label = document.createElement('span');
    label.className = 'ap-label';
    label.textContent = 'Your bid:';
    row.appendChild(label);

    const inp = document.createElement('input');
    inp.type='number'; inp.id='bid-input'; inp.min=minBid; inp.max=99; inp.value=minBid;
    const getBidAmount = () => { const x = parseInt(inp.value); return isNaN(x) ? minBid : x; };
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
    return;
  }

  // ── Non-blocking hints ──
  const hint = txt => {
    panel.classList.add('visible', 'play-hint');
    const lbl = document.createElement('span');
    lbl.className = 'ap-label';
    lbl.textContent = txt;
    panel.appendChild(lbl);
    return lbl;
  };

  if (V.phase === 'bidding' && V.currentBidder !== myPos) {
    const l = hint(`Waiting for ${playerName(V.currentBidder)} to bid…`);
    l.style.opacity = '0.75';
  } else if (V.phase === 'naming_trump' && V.highBidder !== myPos) {
    const l = hint(`${playerName(V.highBidder)} won the bid at ${V.highBid} — naming trump…`);
    l.style.opacity = '0.75';
  } else if (V.phase === 'passing' && partnerOf(V.highBidder) !== myPos) {
    const l = hint(`${playerName(partnerOf(V.highBidder))} is passing 3 cards to ${playerName(V.highBidder)}…`);
    l.style.opacity = '0.75';
  } else if (V.phase === 'returning' && V.highBidder !== myPos) {
    const l = hint(`${playerName(V.highBidder)} is returning 3 cards…`);
    l.style.opacity = '0.75';
  } else if (V.phase === 'playing') {
    if (isMyTurn()) {
      const lbl = hint(!V.currentTrick?.length
        ? 'You lead — click a card'
        : 'Your turn — you must head the trick if able');
      if (V.trump) {
        const t = document.createElement('span');
        t.textContent = ` · Trump: ${SUIT_SYM[V.trump]}`;
        t.style.cssText = `color:${RED_SUITS.has(V.trump)?'#ff8888':'var(--cream)'}`;
        lbl.appendChild(t);
      }
    } else {
      const actor = currentActor(V);
      if (actor) {
        const l = hint(`Waiting for ${playerName(actor)}…`);
        l.style.opacity = '0.6';
      }
    }
  }
}

// ── PASS / RETURN PANELS ──────────────────────────────────────

function renderPassPanels() {
  const passP = document.getElementById('pass-panel');
  const retP  = document.getElementById('return-panel');
  const showPass = V.phase === 'passing'   && partnerOf(V.highBidder) === myPos;
  const showRet  = V.phase === 'returning' && V.highBidder === myPos;

  passP.style.display = showPass ? 'flex' : 'none';
  retP.style.display  = showRet  ? 'flex' : 'none';

  const selText = () => selectedKeys.length === 0 ? '' :
    selectedKeys.map(k => {
      const c = handArr(V, myPos).find(c => cardKey(c) === k);
      return c ? c.r + SUIT_SYM[c.s] : '';
    }).filter(Boolean).join(' · ');

  if (showPass) {
    document.getElementById('pass-title').textContent =
      `Your partner ${playerName(V.highBidder)} won the bid — pass them your best 3 cards`;
    document.getElementById('pass-selected-display').textContent =
      selectedKeys.length ? selText() : 'Click 3 cards in your hand';
    document.getElementById('pass-confirm-btn').disabled = selectedKeys.length !== 3;
  }
  if (showRet) {
    document.getElementById('return-title').textContent =
      `${playerName(partnerOf(V.highBidder))} passed you 3 cards (highlighted) — return any 3`;
    document.getElementById('return-selected-display').textContent =
      selectedKeys.length ? selText() : 'Click 3 cards in your hand';
    document.getElementById('return-confirm-btn').disabled = selectedKeys.length !== 3;
  }
}

function toggleSelect(card) {
  const key = cardKey(card);
  const idx = selectedKeys.indexOf(key);
  if (idx >= 0) selectedKeys.splice(idx, 1);
  else if (selectedKeys.length < 3) selectedKeys.push(key);
  rebuildMyHandFan();
  renderPassPanels();
}

function selectedCards() {
  const hand = handArr(V, myPos);
  return selectedKeys.map(k => hand.find(c => cardKey(c) === k)).filter(Boolean);
}

async function confirmPass() {
  const cards = selectedCards();
  if (cards.length !== 3 || V.phase !== 'passing') return;
  selectedKeys = [];
  document.getElementById('pass-panel').style.display = 'none';
  await animPassCards(cards, absToDisplay(myPos), absToDisplay(V.highBidder));
  sendToHost({ action:'pass_cards', cards });
}

async function confirmReturn() {
  const cards = selectedCards();
  if (cards.length !== 3 || V.phase !== 'returning') return;
  selectedKeys = [];
  document.getElementById('return-panel').style.display = 'none';
  await animPassCards(cards, absToDisplay(myPos), absToDisplay(partnerOf(myPos)));
  sendToHost({ action:'return_cards', cards });
}

// ── MELD SIDEBAR ─────────────────────────────────────────────

function renderMeldSidebar() {
  const sidebar = document.getElementById('meld-sidebar');
  if (V.phase !== 'meld' && V.phase !== 'playing') { sidebar.style.display='none'; return; }
  sidebar.style.display='block';
  const rows = document.getElementById('meld-rows');
  rows.innerHTML = '';
  for (const pos of POSITIONS) {
    const total = V.meld?.[pos] ?? 0;
    const brk   = V.meldBreak?.[pos] ?? [];
    const block = document.createElement('div');
    block.className = 'meld-player-block';
    block.innerHTML = `<div class="meld-player-name">${escapeHtml(playerName(pos))}${pos===myPos?' ★':''}</div>
      <div class="meld-player-total">${total}</div>
      <div class="meld-detail">${brk.map(([l,v])=>`${l}: ${v}`).join('<br>')||'—'}</div>`;
    rows.appendChild(block);
  }
}

// ── MODALS ────────────────────────────────────────────────────

function checkModals() {
  const showTrump = V.phase === 'naming_trump' && V.highBidder === myPos;
  document.getElementById('trump-modal').classList.toggle('visible', showTrump);
  if (showTrump) document.getElementById('won-bid-amt').textContent = V.highBid;

  if (V.phase === 'meld') {
    if (meldModalShownRound !== V.roundNum) {
      meldModalShownRound = V.roundNum;
      showMeldModal();
    }
  } else document.getElementById('meld-modal').classList.remove('visible');

  const roundOverSettled = V.phase === 'round_over' && (V.currentTrick?.length ?? 0) === 0;
  if (roundOverSettled && !V.winner) showRoundModal();
  else document.getElementById('round-modal').classList.remove('visible');

  if (V.winner && roundOverSettled) showGameOver();
  else if (!V.winner) document.getElementById('gameover-modal').classList.remove('visible');
}

function showMeldModal() {
  const modal = document.getElementById('meld-modal');
  modal.classList.add('visible');
  const content = document.getElementById('meld-modal-content');
  content.innerHTML = '';
  for (const pos of POSITIONS) {
    const total = V.meld?.[pos] ?? 0;
    const brk   = V.meldBreak?.[pos] ?? [];
    const div   = document.createElement('div');
    div.className = 'meld-modal-player';
    div.innerHTML = `<div class="meld-modal-name">${escapeHtml(playerName(pos))} (${pos.toUpperCase()})</div>
      <div class="meld-modal-total">${total} pts</div>
      <div class="meld-modal-breakdown">${brk.map(([l,v])=>`${l}: ${v}`).join('<br>')||'No meld'}</div>`;
    content.appendChild(div);
  }
  const partner  = partnerOf(V.highBidder);
  const teamMeld = (V.meld?.[V.highBidder]??0) + (V.meld?.[partner]??0);
  document.getElementById('meld-modal-note').textContent =
    `Bid team meld: ${teamMeld} · Bid: ${V.highBid} · ` +
    (teamMeld >= V.highBid ? 'Bid already covered by meld (must still win a trick)'
                           : `Need ${V.highBid - teamMeld} more from tricks`);
}
function closeMeldModal() {
  document.getElementById('meld-modal').classList.remove('visible');
  sendToHost({ action:'begin_play' });
}

function showRoundModal() {
  document.getElementById('round-modal').classList.add('visible');
  const r = V.lastRoundResult;
  if (!r) return;
  document.getElementById('round-title').innerHTML = r.bidMet
    ? `<span class="round-made">✓ Bid Made</span>`
    : `<span class="round-missed">✗ Bid Missed — Set Back ${r.highBid}</span>`;
  const bidTeamNames  = POSITIONS.filter(p=>teamOf(p)===r.bidTeam).map(playerName).join(' & ');
  const enemTeamNames = POSITIONS.filter(p=>teamOf(p)===r.otherTeam).map(playerName).join(' & ');
  const rows = [
    ['Bidder', `${playerName(r.highBidder)} · ${SUIT_SYM[r.trump]} trump · bid ${r.highBid}`],
    [`${bidTeamNames} meld`, r.teamMeld],
    [`${bidTeamNames} tricks`, `${r.bidTrickPts} pts (${r.bidTricksWon} tricks)`],
    [`${bidTeamNames} total`, r.bidMet ? `+${r.bidTotal}` : `−${r.highBid} (set)`],
    [`${enemTeamNames} meld`, r.enemMeld],
    [`${enemTeamNames} tricks`, `${r.enemTrickPts} pts (${r.enemTricksWon} tricks)`],
    [`${enemTeamNames} total`, `+${r.enemTotal}`],
    ['NS score', r.nsScore],
    ['EW score', r.ewScore],
  ];
  if (r.bidTricksWon === 0 || r.enemTricksWon === 0) {
    rows.splice(1, 0, ['Note', 'A team with no tricks scores nothing']);
  }
  document.getElementById('round-content').innerHTML =
    rows.map(([l,v])=>`<div class="round-row"><span class="rl">${escapeHtml(l)}</span><span class="rv">${escapeHtml(v)}</span></div>`).join('');
  document.getElementById('next-round-btn').style.display = isHost ? 'inline-flex' : 'none';
  document.getElementById('round-wait-note').style.display = isHost ? 'none' : 'block';
}

function showDealReview() {
  document.getElementById('round-modal').classList.remove('visible');
  document.getElementById('review-modal').classList.add('visible');
  document.getElementById('review-round-num').textContent = V.lastRoundResult?.roundNum ?? V.roundNum;
  const content = document.getElementById('review-content');
  content.innerHTML = '';
  for (const pos of POSITIONS) {
    const hand   = V.dealtHands?.[pos];
    const isArr  = Array.isArray(hand);
    const sorted = isArr ? [...hand] : [];
    if (isArr) sortHand(sorted, V.trump);
    const div = document.createElement('div');
    div.className='review-hand-block';
    div.innerHTML=`<div class="review-hand-name">${escapeHtml(playerName(pos))} (${pos.toUpperCase()})</div>
      <div class="review-cards">${isArr
        ? sorted.map(c=>`<span class="review-card${RED_SUITS.has(c.s)?' red':''}">${c.r}${SUIT_SYM[c.s]}</span>`).join('')
        : '<em style="opacity:0.4">hidden</em>'}</div>`;
    content.appendChild(div);
  }
}
function closeReviewModal() {
  document.getElementById('review-modal').classList.remove('visible');
  if (V?.winner) document.getElementById('gameover-modal').classList.add('visible');
  else document.getElementById('round-modal').classList.add('visible');
}

function showGameOver() {
  document.getElementById('round-modal').classList.remove('visible');
  document.getElementById('gameover-modal').classList.add('visible');
  const winners = POSITIONS.filter(p=>teamOf(p)===V.winner).map(playerName).join(' & ');
  document.getElementById('winner-text').textContent = `${winners} Win!`;
  document.getElementById('gameover-msg').textContent =
    `Final Score — NS: ${V.scores.ns}  ·  EW: ${V.scores.ew}`;
}

function selectTrump(suit) {
  sendToHost({ action:'name_trump', suit });
  document.getElementById('trump-modal').classList.remove('visible');
}

function nextRound() {
  document.getElementById('round-modal').classList.remove('visible');
  sendToHost({ action:'next_round' });
}

// ── LOG ───────────────────────────────────────────────────────

function renderLog() {
  if (V.lastLog && V.lastLog.seq > lastLogSeq) {
    lastLogSeq = V.lastLog.seq;
    log(V.lastLog.msg);
  }
}

function log(msg) {
  const el = document.getElementById('log');
  if (!el) return;
  const line = document.createElement('div');
  line.textContent = msg;
  el.prepend(line);
  while (el.children.length > 7) el.removeChild(el.lastChild);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
