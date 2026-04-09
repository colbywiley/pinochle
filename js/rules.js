// ══════════════════════════════════════════
//  rules.js — modern single-deck pinochle
//  Rules implemented:
//   • Single 48-card deck, goal 150
//   • Min bid 25, bid by 1
//   • Stick the dealer (dealer must bid if all pass)
//   • Declarer passes 3 blind to partner
//   • Partner sees 3 passed cards, discards 3 (no peek before)
//   • Must head trick (beat current winner if able)
//   • Bidder goes out (bid team wins tiebreaker)
//   • Last trick = 1 point bonus
// ══════════════════════════════════════════

const POSITIONS = ['south','west','north','east']; // rotation order
const GOAL      = 150;
const MIN_BID   = 25;

function teamOf(pos)    { return (pos==='north'||pos==='south') ? 'ns' : 'ew'; }
function partnerOf(pos) { return {south:'north',north:'south',east:'west',west:'east'}[pos]; }
function leftOf(pos)    { return POSITIONS[(POSITIONS.indexOf(pos)+1)%4]; }
function rightOf(pos)   { return POSITIONS[(POSITIONS.indexOf(pos)+3)%4]; }

/** Create a fresh round state (preserving scores & dealer) */
function newRound(prevState) {
  const dealer = prevState ? leftOf(prevState.dealer) : 'south';
  return {
    phase:        'bidding',   // bidding|passing|discarding|meld|playing|round_over
    dealer,
    hands:        { south:[], west:[], north:[], east:[] },
    dealtHands:   { south:[], west:[], north:[], east:[] }, // pristine copy for review
    bids:         { south:null, west:null, north:null, east:null },
    currentBidder: leftOf(dealer),  // player left of dealer bids first
    highBid:      0,
    highBidder:   null,
    trump:        null,
    passedCards:  [],   // 3 cards sent from declarer to partner
    trickLeader:  null, // set after trump named
    currentTrick: [],
    trickLedSuit: null,
    tricksWon:    { ns:0, ew:0 },
    trickPts:     { ns:0, ew:0 },
    meld:         { south:0, west:0, north:0, east:0 },
    meldBreak:    { south:[], west:[], north:[], east:[] },
    scores:       prevState ? { ...prevState.scores } : { ns:0, ew:0 },
    roundNum:     prevState ? prevState.roundNum + 1 : 1,
    lastRoundResult: null,
  };
}

/** Deal 12 cards to each player */
function dealCards(state) {
  const deck  = shuffle(makeDeck());
  const hands = { south:[], west:[], north:[], east:[] };
  let i = 0;
  for (const p of POSITIONS) { hands[p] = deck.slice(i, i+12); i += 12; }
  state.hands     = hands;
  // Deep copy for review
  state.dealtHands = {};
  for (const p of POSITIONS) state.dealtHands[p] = hands[p].map(c=>({...c}));
}

// ── BIDDING ──────────────────────────────────────────────────────────────────

/**
 * Process a bid action from `fromPos`.
 * amount = 0 means pass, otherwise the bid value.
 * Returns { ok, error, log }
 */
function processBid(state, fromPos, amount) {
  if (state.phase !== 'bidding') return { ok:false, error:'Not bidding phase' };
  if (state.currentBidder !== fromPos) return { ok:false, error:'Not your turn to bid' };

  const passing = (amount === 0);

  if (!passing) {
    const minAllowed = Math.max(MIN_BID, state.highBid + 1);
    if (amount < minAllowed) return { ok:false, error:`Minimum bid is ${minAllowed}` };
    state.highBid    = amount;
    state.highBidder = fromPos;
  }

  state.bids[fromPos] = passing ? 0 : amount;

  // Count who is still active
  const active = POSITIONS.filter(p => state.bids[p] === null || state.bids[p] > 0);

  // Stick the dealer: if everyone else has passed, dealer MUST bid
  const allExceptDealer = POSITIONS.filter(p => p !== state.dealer);
  const dealerBidded    = state.bids[state.dealer] !== null;
  const allOthersPassed = allExceptDealer.every(p => state.bids[p] === 0);

  if (!dealerBidded && allOthersPassed) {
    // Dealer is stuck — they must bid at least MIN_BID (or highBid+1 if higher)
    state.currentBidder = state.dealer;
    state.bids[state.dealer] = null; // reset so dealer gets their prompt
    return {
      ok: true,
      log: `${fromPos} passes. Dealer (${state.dealer}) is stuck — must bid.`,
      stuckDealer: state.dealer
    };
  }

  // Is bidding over? (only 1 active bidder, or all have acted)
  const stillActive = POSITIONS.filter(p => state.bids[p] === null || (state.bids[p] !== null && state.bids[p] > 0));
  if (stillActive.length <= 1 || POSITIONS.every(p => state.bids[p] !== null)) {
    state.phase = 'passing';
    return {
      ok: true,
      log: `${passing ? fromPos+' passes' : fromPos+' bids '+amount}. ${state.highBidder} wins bid at ${state.highBid}.`,
      biddingDone: true
    };
  }

  // Advance to next bidder who hasn't passed
  let next = leftOf(fromPos);
  while (state.bids[next] === 0) next = leftOf(next);
  state.currentBidder = next;

  return {
    ok: true,
    log: passing ? `${fromPos} passes` : `${fromPos} bids ${amount}`
  };
}

// ── PASSING ──────────────────────────────────────────────────────────────────

/**
 * Declarer passes 3 cards to partner.
 * cards = array of {r,s} card objects
 */
function processPass(state, fromPos, cards) {
  if (state.phase !== 'passing')        return { ok:false, error:'Not passing phase' };
  if (fromPos !== state.highBidder)     return { ok:false, error:'Only the declarer passes cards' };
  if (cards.length !== 3)               return { ok:false, error:'Must pass exactly 3 cards' };

  // Remove passed cards from declarer's hand
  for (const pc of cards) {
    const idx = state.hands[fromPos].findIndex(c => sameCard(c, pc));
    if (idx === -1) return { ok:false, error:'Card not in hand' };
    state.hands[fromPos].splice(idx, 1);
  }

  // Add to partner's hand
  const partner = partnerOf(fromPos);
  for (const pc of cards) state.hands[partner].push(pc);
  state.passedCards = cards;
  state.phase = 'discarding'; // partner must now discard 3

  return { ok:true, log:`${fromPos} passes 3 cards to ${partner}` };
}

/**
 * Partner (receiver) discards 3 cards.
 */
function processDiscard(state, fromPos, cards) {
  if (state.phase !== 'discarding')                   return { ok:false, error:'Not discarding phase' };
  if (fromPos !== partnerOf(state.highBidder))        return { ok:false, error:'Only the partner discards' };
  if (cards.length !== 3)                             return { ok:false, error:'Must discard exactly 3' };

  for (const pc of cards) {
    const idx = state.hands[fromPos].findIndex(c => sameCard(c, pc));
    if (idx === -1) return { ok:false, error:'Card not in hand' };
    state.hands[fromPos].splice(idx, 1);
  }

  state.phase = 'naming_trump';
  return { ok:true, log:`${fromPos} discards 3 cards` };
}

// ── TRUMP ─────────────────────────────────────────────────────────────────────

function processTrump(state, fromPos, suit) {
  if (state.phase !== 'naming_trump')   return { ok:false, error:'Not naming trump' };
  if (fromPos !== state.highBidder)     return { ok:false, error:'Only bid winner names trump' };

  state.trump       = suit;
  state.trickLeader = leftOf(state.dealer); // leader is left of dealer
  state.phase       = 'meld';

  // Calc meld for all players
  for (const p of POSITIONS) {
    const m = calcMeld(state.hands[p], suit);
    state.meld[p]      = m.score;
    state.meldBreak[p] = m.breakdown;
  }

  return { ok:true, log:`${fromPos} names ${SUIT_NAME[suit]} as trump` };
}

// ── PLAYING ───────────────────────────────────────────────────────────────────

function startPlaying(state) {
  state.phase = 'playing';
}

/**
 * Validate and play a card.
 * Must-head rule: if you can beat the current winning card, you must.
 */
function processPlayCard(state, fromPos, card) {
  if (state.phase !== 'playing') return { ok:false, error:'Not playing phase' };

  // Whose turn?
  const expectedPlayer = nextToPlay(state);
  if (expectedPlayer !== fromPos) return { ok:false, error:`It is ${expectedPlayer}'s turn` };

  // Card in hand?
  const cardIdx = state.hands[fromPos].findIndex(c => sameCard(c, card));
  if (cardIdx === -1) return { ok:false, error:'Card not in hand' };

  // Legal play?
  const legal = legalPlays(state, fromPos);
  if (!legal.some(c => sameCard(c, card))) {
    return { ok:false, error:'Illegal play — must follow suit and/or head the trick' };
  }

  // Remove from hand and add to trick (preserve id for animation tracking)
  const playedCard = state.hands[fromPos].splice(cardIdx, 1)[0];
  state.currentTrick.push({ seat: fromPos, card: playedCard });
  if (state.currentTrick.length === 1) state.trickLedSuit = card.s;

  // Trick complete?
  if (state.currentTrick.length === 4) {
    return resolveTrick(state);
  }

  return { ok:true, log:`${fromPos} plays ${card.r}${SUIT_SYM[card.s]}` };
}

function nextToPlay(state) {
  if (state.currentTrick.length === 0) return state.trickLeader;
  const last = state.currentTrick[state.currentTrick.length - 1].seat;
  return leftOf(last);
}

/**
 * Legal plays for `pos`:
 * 1. Must follow led suit if possible
 * 2. Within that constraint, must beat current winning card if possible (must head)
 * 3. If can't follow suit, must trump if possible
 * 4. If can't trump, may play anything
 */
function legalPlays(state, pos) {
  const hand = state.hands[pos];
  if (state.currentTrick.length === 0) return hand; // lead — play anything

  const ledSuit    = state.trickLedSuit;
  const trump      = state.trump;
  const hasSuit    = hand.filter(c => c.s === ledSuit);
  const hasTrump   = hand.filter(c => c.s === trump);

  // Current winning card in trick
  const winnerIdx  = bestInTrick(state.currentTrick, trump);
  const winCard    = state.currentTrick[winnerIdx].card;

  if (hasSuit.length > 0) {
    // Must follow suit. Within suit, must head if able.
    const canBeat = hasSuit.filter(c => beats(c, winCard, trump));
    return canBeat.length > 0 ? canBeat : hasSuit;
  }

  // Can't follow suit
  if (ledSuit !== trump && hasTrump.length > 0) {
    // Must trump. Must head if able.
    const canBeat = hasTrump.filter(c => beats(c, winCard, trump));
    return canBeat.length > 0 ? canBeat : hasTrump;
  }

  // Can't follow, can't trump (or led trump, no trump left)
  return hand;
}

function bestInTrick(trick, trump) {
  let best = 0;
  for (let i = 1; i < trick.length; i++) {
    if (beats(trick[i].card, trick[best].card, trump)) best = i;
  }
  return best;
}

function resolveTrick(state) {
  const winner = trickWinner(state.currentTrick, state.trump);
  const team   = teamOf(winner);
  state.tricksWon[team]++;

  const pts = countPoints(state.currentTrick.map(t => t.card));
  state.trickPts[team] += pts;

  const trickLog = `${winner} wins trick (+${pts} pts)`;

  // Last trick bonus (+1)
  const cardsLeft = POSITIONS.reduce((s, p) => s + state.hands[p].length, 0);
  const isLast    = cardsLeft === 0;
  if (isLast) state.trickPts[team] += 1;

  state.trickLeader  = winner;
  state.currentTrick = [];
  state.trickLedSuit = null;

  if (isLast) {
    return { ok:true, log:trickLog, trickDone:true, roundOver: finishRound(state) };
  }

  return { ok:true, log:trickLog, trickDone:true };
}

function finishRound(state) {
  const bidTeam   = teamOf(state.highBidder);
  const otherTeam = bidTeam === 'ns' ? 'ew' : 'ns';

  const partner   = partnerOf(state.highBidder);
  const teamMeld  = state.meld[state.highBidder] + state.meld[partner];
  const enemMeld  = state.meld[POSITIONS.filter(p=>teamOf(p)===otherTeam)[0]] +
                    state.meld[POSITIONS.filter(p=>teamOf(p)===otherTeam)[1]];

  const bidTotal  = teamMeld + state.trickPts[bidTeam];
  const bidMet    = bidTotal >= state.highBid;

  // Scoring
  if (bidMet) {
    state.scores[bidTeam]   += bidTotal;
  } else {
    state.scores[bidTeam]   -= state.highBid;  // set back
  }
  state.scores[otherTeam] += enemMeld + state.trickPts[otherTeam];

  // Bidder goes out: if both teams reach 150 on same round, bid team wins
  // (handled in win check by checking bid team first)

  state.lastRoundResult = {
    bidTeam, otherTeam, bidMet,
    highBid:      state.highBid,
    highBidder:   state.highBidder,
    trump:        state.trump,
    teamMeld,  enemMeld,
    bidTrickPts:  state.trickPts[bidTeam],
    enemTrickPts: state.trickPts[otherTeam],
    bidTotal,
    nsScore: state.scores.ns,
    ewScore: state.scores.ew,
  };
  state.phase = 'round_over';
  return state.lastRoundResult;
}

/** Check winner. Bid team is checked first (bidder-goes-out). */
function checkWinner(state) {
  const r = state.lastRoundResult;
  if (!r) return null;
  if (state.scores[r.bidTeam]   >= GOAL) return r.bidTeam;
  if (state.scores[r.otherTeam] >= GOAL) return r.otherTeam;
  return null;
}
