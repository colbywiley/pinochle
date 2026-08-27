// ══════════════════════════════════════════
//  rules.js — modern single-deck partnership pinochle
//  Rules implemented:
//   • Single 48-card deck (two of each card), partners NS vs EW
//   • Goal 150 · 25 points in play per hand (A/10/K = 1, last trick +1)
//   • Min bid 25, raise by at least 1, pass = out
//   • Stick the dealer (dealer must take it at 25 if all others pass)
//   • Bid winner names trump
//   • Bid winner's partner passes 3 cards to the bidder,
//     bidder returns 3 cards to partner (both end with 12)
//   • Meld declared once hands are final
//   • Must head the trick (beat current winner if able; trump if void)
//   • A team must win at least one trick to score anything that hand
//   • Bid not made → lose the bid amount, score nothing else
//   • Bidder goes out (bid team wins tiebreaker at 150)
// ══════════════════════════════════════════

const POSITIONS = ['south','west','north','east']; // rotation order (clockwise)
const GOAL      = 150;
const MIN_BID   = 25;
const MAX_BID   = 500; // sanity ceiling only — far above any makeable hand

/** Is this a well-formed card object from a client? */
function isCardShape(c) {
  return !!c && typeof c === 'object' &&
    RANKS.includes(c.r) && SUITS.includes(c.s);
}

function teamOf(pos)    { return (pos==='north'||pos==='south') ? 'ns' : 'ew'; }
function partnerOf(pos) { return {south:'north',north:'south',east:'west',west:'east'}[pos]; }
function leftOf(pos)    { return POSITIONS[(POSITIONS.indexOf(pos)+1)%4]; }
function rightOf(pos)   { return POSITIONS[(POSITIONS.indexOf(pos)+3)%4]; }

/** Create a fresh round state (preserving scores & rotating dealer) */
function newRound(prevState) {
  const dealer = prevState ? leftOf(prevState.dealer) : 'south';
  return {
    phase:        'bidding',   // bidding|naming_trump|passing|returning|meld|playing|round_over
    dealer,
    hands:        { south:[], west:[], north:[], east:[] },
    dealtHands:   { south:[], west:[], north:[], east:[] }, // pristine copy for review
    bids:         { south:null, west:null, north:null, east:null },
    currentBidder: leftOf(dealer),  // player left of dealer bids first
    highBid:      0,
    highBidder:   null,
    trump:        null,
    passedIds:    [],   // ids of the 3 cards partner sent to the bidder
    returnedIds:  [],   // ids of the 3 cards bidder sent back
    trickLeader:  null, // bid winner leads the first trick
    currentTrick: [],
    trickLedSuit: null,
    tricksWon:    { ns:0, ew:0 },
    trickPts:     { ns:0, ew:0 },
    meld:         { south:0, west:0, north:0, east:0 },
    meldBreak:    { south:[], west:[], north:[], east:[] },
    scores:       prevState ? { ...prevState.scores } : { ns:0, ew:0 },
    roundNum:     prevState ? prevState.roundNum + 1 : 1,
    lastRoundResult: null,
    winner:       null,
  };
}

/** Deal 12 cards to each player */
function dealCards(state) {
  const deck  = shuffle(makeDeck());
  const hands = { south:[], west:[], north:[], east:[] };
  let i = 0;
  for (const p of POSITIONS) { hands[p] = deck.slice(i, i+12); i += 12; }
  state.hands = hands;
  state.dealtHands = {};
  for (const p of POSITIONS) state.dealtHands[p] = hands[p].map(c=>({...c}));
}

// ── BIDDING ──────────────────────────────────────────────────────────────────

/**
 * Process a bid action from `fromPos`.
 * amount = 0 means pass, otherwise the bid value.
 * Returns { ok, error?, log?, biddingDone?, stuckDealer? }
 */
function processBid(state, fromPos, amount) {
  if (state.phase !== 'bidding') return { ok:false, error:'Not bidding phase' };
  if (state.currentBidder !== fromPos) return { ok:false, error:'Not your turn to bid' };
  if (state.bids[fromPos] === 0) return { ok:false, error:'You have already passed' };

  const passing = (amount === 0);

  // Stuck dealer can't pass: all others passed and nobody has bid
  if (passing && fromPos === state.dealer && state.highBid === 0) {
    const others = POSITIONS.filter(p => p !== state.dealer);
    if (others.every(p => state.bids[p] === 0)) {
      return { ok:false, error:`Dealer is stuck — must bid ${MIN_BID}` };
    }
  }

  if (!passing) {
    if (!Number.isInteger(amount)) return { ok:false, error:'Bid must be a whole number' };
    const minAllowed = Math.max(MIN_BID, state.highBid + 1);
    if (amount < minAllowed) return { ok:false, error:`Minimum bid is ${minAllowed}` };
    if (amount > MAX_BID) return { ok:false, error:`Maximum bid is ${MAX_BID}` };
    state.highBid    = amount;
    state.highBidder = fromPos;
  }

  state.bids[fromPos] = passing ? 0 : amount;

  // Stick the dealer: everyone else passed, nobody bid, dealer still to act
  const allExceptDealer = POSITIONS.filter(p => p !== state.dealer);
  const dealerNoBid     = state.bids[state.dealer] === null;
  const allOthersPassed = allExceptDealer.every(p => state.bids[p] === 0);
  if (allOthersPassed && dealerNoBid && state.highBid === 0) {
    state.currentBidder = state.dealer;
    return {
      ok: true,
      log: `${fromPos} passes — dealer is stuck and must bid ${MIN_BID}`,
      stuckDealer: state.dealer
    };
  }

  // Bidding ends when only one player hasn't passed and they hold the high bid
  const stillIn = POSITIONS.filter(p => state.bids[p] !== 0);
  if (stillIn.length === 1 && state.highBidder === stillIn[0]) {
    state.phase = 'naming_trump';
    return {
      ok: true,
      log: `${passing ? fromPos+' passes' : fromPos+' bids '+amount} — ${state.highBidder} wins the bid at ${state.highBid}`,
      biddingDone: true
    };
  }

  // Advance to next active bidder (skip those who passed)
  let next = leftOf(fromPos);
  while (state.bids[next] === 0) next = leftOf(next);
  state.currentBidder = next;

  return { ok:true, log: passing ? `${fromPos} passes` : `${fromPos} bids ${amount}` };
}

// ── TRUMP ─────────────────────────────────────────────────────────────────────

function processTrump(state, fromPos, suit) {
  if (state.phase !== 'naming_trump') return { ok:false, error:'Not naming trump' };
  if (fromPos !== state.highBidder)   return { ok:false, error:'Only the bid winner names trump' };
  if (!SUITS.includes(suit))          return { ok:false, error:'Invalid suit' };

  state.trump       = suit;
  state.trickLeader = state.highBidder; // bid winner leads the first trick
  state.phase       = 'passing';        // partner now passes 3 cards to the bidder
  return { ok:true, log:`${fromPos} names ${SUIT_NAME[suit]} trump` };
}

// ── PASSING ──────────────────────────────────────────────────────────────────

/** Move `cards` from one hand to another. Validates everything before
 *  mutating anything, so a bad request can never lose or duplicate cards.
 *  Returns the moved cards, or false. */
function moveCards(state, fromPos, toPos, cards) {
  const hand = state.hands[fromPos];
  const used = new Set();
  for (const pc of cards) {
    if (!isCardShape(pc)) return false;
    let idx = hand.findIndex((c, i) => !used.has(i) && cardKey(c) === cardKey(pc));
    if (idx === -1) idx = hand.findIndex((c, i) => !used.has(i) && sameCard(c, pc));
    if (idx === -1) return false;
    used.add(idx);
  }
  const taken = [...used].sort((a, b) => b - a).map(i => hand.splice(i, 1)[0]).reverse();
  state.hands[toPos].push(...taken);
  return taken;
}

/**
 * Bid winner's partner passes 3 cards to the bidder.
 */
function processPass(state, fromPos, cards) {
  if (state.phase !== 'passing')                 return { ok:false, error:'Not passing phase' };
  if (fromPos !== partnerOf(state.highBidder))   return { ok:false, error:'Only the bidder\'s partner passes now' };
  if (!Array.isArray(cards) || cards.length !== 3) return { ok:false, error:'Must pass exactly 3 cards' };

  const moved = moveCards(state, fromPos, state.highBidder, cards);
  if (!moved) return { ok:false, error:'Card not in hand' };

  state.passedIds = moved.map(c => c.id);
  state.phase = 'returning'; // bidder must now send 3 back
  return { ok:true, log:`${fromPos} passes 3 cards to ${state.highBidder}` };
}

/**
 * Bidder returns 3 cards to partner. Hands are now final — calculate meld.
 */
function processReturn(state, fromPos, cards) {
  if (state.phase !== 'returning')               return { ok:false, error:'Not returning phase' };
  if (fromPos !== state.highBidder)              return { ok:false, error:'Only the bidder returns cards' };
  if (!Array.isArray(cards) || cards.length !== 3) return { ok:false, error:'Must return exactly 3 cards' };

  const partner = partnerOf(state.highBidder);
  const moved = moveCards(state, fromPos, partner, cards);
  if (!moved) return { ok:false, error:'Card not in hand' };

  state.returnedIds = moved.map(c => c.id);

  // Hands are final — calculate meld for everyone using the named trump
  for (const p of POSITIONS) {
    const m = calcMeld(state.hands[p], state.trump);
    state.meld[p]      = m.score;
    state.meldBreak[p] = m.breakdown;
  }

  state.phase = 'meld';
  return { ok:true, log:`${fromPos} returns 3 cards to ${partner}` };
}

// ── PLAYING ───────────────────────────────────────────────────────────────────

function startPlaying(state) {
  if (state.phase !== 'meld') return { ok:false, error:'Not meld phase' };
  state.phase = 'playing';
  return { ok:true, log:`Play begins — ${state.trickLeader} leads` };
}

/**
 * Validate and play a card.
 * Must-head rule: if you can beat the current winning card, you must.
 */
function processPlayCard(state, fromPos, card) {
  if (state.phase !== 'playing') return { ok:false, error:'Not playing phase' };
  if (!isCardShape(card))        return { ok:false, error:'Invalid card' };

  const expectedPlayer = nextToPlay(state);
  if (expectedPlayer !== fromPos) return { ok:false, error:`It is ${expectedPlayer}'s turn` };

  const cardIdx = indexOfCard(state.hands[fromPos], card);
  if (cardIdx === -1) return { ok:false, error:'Card not in hand' };
  const actualCard = state.hands[fromPos][cardIdx];

  const legal = legalPlays(state, fromPos);
  if (!legal.some(c => cardKey(c) === cardKey(actualCard))) {
    return { ok:false, error:'Illegal play — must follow suit and head the trick if able' };
  }

  state.hands[fromPos].splice(cardIdx, 1);
  state.currentTrick.push({ seat: fromPos, card: actualCard });
  if (state.currentTrick.length === 1) state.trickLedSuit = actualCard.s;

  if (state.currentTrick.length === 4) {
    return resolveTrick(state);
  }
  return { ok:true, log:`${fromPos} plays ${actualCard.r}${SUIT_SYM[actualCard.s]}` };
}

function nextToPlay(state) {
  if (state.phase !== 'playing') return null;
  if (state.currentTrick.length === 0) return state.trickLeader;
  if (state.currentTrick.length >= 4) return null;
  const last = state.currentTrick[state.currentTrick.length - 1].seat;
  return leftOf(last);
}

/**
 * Legal plays for `pos`:
 * 1. Must follow led suit if possible
 * 2. Within that constraint, must beat the current winning card if possible
 * 3. If can't follow suit, must trump — and must over-trump if possible
 * 4. If can't follow and can't trump, may play anything
 */
function legalPlays(state, pos) {
  const hand = state.hands[pos];
  if (state.currentTrick.length === 0) return [...hand]; // lead — play anything

  const ledSuit  = state.trickLedSuit;
  const trump    = state.trump;
  const hasSuit  = hand.filter(c => c.s === ledSuit);
  const hasTrump = hand.filter(c => c.s === trump);

  const winnerIdx = bestInTrick(state.currentTrick, trump);
  const winCard   = state.currentTrick[winnerIdx].card;

  if (hasSuit.length > 0) {
    const canBeat = hasSuit.filter(c => beats(c, winCard, trump));
    return canBeat.length > 0 ? canBeat : hasSuit;
  }
  if (ledSuit !== trump && hasTrump.length > 0) {
    const canBeat = hasTrump.filter(c => beats(c, winCard, trump));
    return canBeat.length > 0 ? canBeat : hasTrump;
  }
  return [...hand];
}

function bestInTrick(trick, trump) {
  let best = 0;
  for (let i = 1; i < trick.length; i++) {
    if (beats(trick[i].card, trick[best].card, trump)) best = i;
  }
  return best;
}

function resolveTrick(state) {
  // Snapshot the 4-card trick before clearing (for animation)
  const trickSnapshot = {
    cards: state.currentTrick.map(t => ({ seat: t.seat, card: { ...t.card } })),
    ledSuit: state.trickLedSuit,
  };

  const winner = trickWinner(state.currentTrick, state.trump);
  const team   = teamOf(winner);
  state.tricksWon[team]++;

  const pts = countPoints(state.currentTrick.map(t => t.card));
  state.trickPts[team] += pts;

  const cardsLeft = POSITIONS.reduce((s, p) => s + state.hands[p].length, 0);
  const isLast    = cardsLeft === 0;
  if (isLast) state.trickPts[team] += LAST_TRICK_BONUS;

  const trickLog = `${winner} wins the trick` + (pts > 0 ? ` (+${pts})` : '') +
                   (isLast ? ` and the last-trick bonus (+${LAST_TRICK_BONUS})` : '');

  state.trickLeader  = winner;
  state.currentTrick = [];
  state.trickLedSuit = null;

  if (isLast) {
    return { ok:true, log:trickLog, trickDone:true, trickSnapshot, roundOver: finishRound(state) };
  }
  return { ok:true, log:trickLog, trickDone:true, trickSnapshot };
}

function finishRound(state) {
  const bidTeam   = teamOf(state.highBidder);
  const otherTeam = bidTeam === 'ns' ? 'ew' : 'ns';

  const meldOf = team =>
    POSITIONS.filter(p => teamOf(p) === team)
             .reduce((s, p) => s + state.meld[p], 0);

  const teamMeld = meldOf(bidTeam);
  const enemMeld = meldOf(otherTeam);

  // A team that takes no tricks scores nothing that hand (meld included)
  const bidTotal  = state.tricksWon[bidTeam] > 0 ? teamMeld + state.trickPts[bidTeam] : 0;
  const enemTotal = state.tricksWon[otherTeam] > 0 ? enemMeld + state.trickPts[otherTeam] : 0;
  const bidMet    = bidTotal >= state.highBid;

  if (bidMet) state.scores[bidTeam] += bidTotal;
  else        state.scores[bidTeam] -= state.highBid;  // set back
  state.scores[otherTeam] += enemTotal;

  state.lastRoundResult = {
    bidTeam, otherTeam, bidMet,
    highBid:      state.highBid,
    highBidder:   state.highBidder,
    trump:        state.trump,
    teamMeld, enemMeld,
    bidTrickPts:  state.trickPts[bidTeam],
    enemTrickPts: state.trickPts[otherTeam],
    bidTricksWon:  state.tricksWon[bidTeam],
    enemTricksWon: state.tricksWon[otherTeam],
    bidTotal, enemTotal,
    nsScore: state.scores.ns,
    ewScore: state.scores.ew,
    roundNum: state.roundNum,
  };
  state.phase = 'round_over';
  return state.lastRoundResult;
}

/** Check winner. Bid team is checked first (bidder goes out). */
function checkWinner(state) {
  const r = state.lastRoundResult;
  if (!r) return null;
  if (state.scores[r.bidTeam]   >= GOAL) return r.bidTeam;
  if (state.scores[r.otherTeam] >= GOAL) return r.otherTeam;
  return null;
}
