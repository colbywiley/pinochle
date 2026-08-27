// ══════════════════════════════════════════
//  rules.js — modern single-deck partnership pinochle
//  Core (always on):
//   • Single 48-card deck (two of each card), partners NS vs EW
//   • Counters: A/10/K taken in tricks = 1 each (24) + last-trick bonus
//   • Bid winner names trump and leads the first trick
//   • Bid not made → lose the bid amount, score nothing else
//   • Bidder goes out (bid team wins tiebreaker at the goal)
//  House rules (state.rules, host-configurable):
//   • goal            — points to win (default 150)
//   • minBid          — opening minimum (default 25, raise by at least 1)
//   • stickDealer     — dealer must bid if all others pass (default on);
//                       off → four passes throw the hand in for a redeal
//   • passCount       — cards passed partner→bidder and returned (0/3/4)
//   • passPeek        — 'peek': bidder sees the passed cards before
//                       choosing returns; 'no_peek': bidder must pick the
//                       returns from their own hand first, then receives
//   • playRules       — 'must_head': follow suit and beat the winner if
//                       able, trump when void, over-trump if able;
//                       'must_trump': follow suit, trump when void, no
//                       heading requirement; 'follow_suit': only follow
//   • lastTrickBonus  — points for the last trick (1 or 2)
//   • needTrickToScore— a team with no tricks scores nothing (default on)
// ══════════════════════════════════════════

const POSITIONS = ['south','west','north','east']; // rotation order (clockwise)
const GOAL      = 150; // defaults — live values come from state.rules
const MIN_BID   = 25;
const MAX_BID   = 500; // sanity ceiling only — far above any makeable hand

const DEFAULT_RULES = {
  goal: 150,
  minBid: 25,
  stickDealer: true,
  passCount: 3,
  passPeek: 'peek',
  playRules: 'must_head',
  lastTrickBonus: 1,
  needTrickToScore: true,
};

/** Sanitize a host-supplied rules object down to known values */
function normalizeRules(r) {
  const d = { ...DEFAULT_RULES };
  if (!r || typeof r !== 'object') return d;
  if ([100,150,200,300].includes(r.goal))        d.goal = r.goal;
  if ([20,25,30].includes(r.minBid))             d.minBid = r.minBid;
  d.stickDealer = r.stickDealer !== false && r.stickDealer !== 'false';
  if ([0,3,4].includes(r.passCount))             d.passCount = r.passCount;
  if (['peek','no_peek'].includes(r.passPeek))   d.passPeek = r.passPeek;
  if (['must_head','must_trump','follow_suit'].includes(r.playRules)) d.playRules = r.playRules;
  if ([1,2].includes(r.lastTrickBonus))          d.lastTrickBonus = r.lastTrickBonus;
  d.needTrickToScore = r.needTrickToScore !== false && r.needTrickToScore !== 'false';
  return d;
}

/** Short human-readable summary, listing only departures from the defaults */
function describeRules(rules) {
  const parts = [];
  if (rules.goal !== 150)    parts.push(`goal ${rules.goal}`);
  if (rules.minBid !== 25)   parts.push(`min bid ${rules.minBid}`);
  if (!rules.stickDealer)    parts.push('no stuck dealer (redeal on 4 passes)');
  if (rules.passCount === 0) parts.push('no passing');
  else if (rules.passCount !== 3) parts.push(`pass ${rules.passCount} cards`);
  if (rules.passCount > 0 && rules.passPeek === 'no_peek') parts.push('no peek at passed cards');
  if (rules.playRules === 'must_trump')  parts.push('must trump, no heading');
  if (rules.playRules === 'follow_suit') parts.push('follow suit only');
  if (rules.lastTrickBonus !== 1) parts.push(`last trick +${rules.lastTrickBonus}`);
  if (!rules.needTrickToScore) parts.push('meld counts without a trick');
  return parts.length ? 'House rules: ' + parts.join(' · ') : 'Standard house rules';
}

/** Is this a well-formed card object from a client? */
function isCardShape(c) {
  return !!c && typeof c === 'object' &&
    RANKS.includes(c.r) && SUITS.includes(c.s);
}

function teamOf(pos)    { return (pos==='north'||pos==='south') ? 'ns' : 'ew'; }
function partnerOf(pos) { return {south:'north',north:'south',east:'west',west:'east'}[pos]; }
function leftOf(pos)    { return POSITIONS[(POSITIONS.indexOf(pos)+1)%4]; }
function rightOf(pos)   { return POSITIONS[(POSITIONS.indexOf(pos)+3)%4]; }

/** Create a fresh round state (preserving scores, rules & rotating dealer) */
function newRound(prevState, rules) {
  const dealer = prevState ? leftOf(prevState.dealer) : 'south';
  return {
    rules:        prevState ? prevState.rules : normalizeRules(rules),
    phase:        'bidding',   // bidding|naming_trump|passing|returning|meld|playing|round_over
    dealer,
    hands:        { south:[], west:[], north:[], east:[] },
    dealtHands:   { south:[], west:[], north:[], east:[] }, // pristine copy for review
    bids:         { south:null, west:null, north:null, east:null },
    currentBidder: leftOf(dealer),  // player left of dealer bids first
    highBid:      0,
    highBidder:   null,
    trump:        null,
    passedIds:    [],   // ids of the cards partner sent to the bidder
    returnedIds:  [],   // ids of the cards bidder sent back
    pendingPass:  [],   // no-peek: passed cards held here until the return
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
 * Returns { ok, error?, log?, biddingDone?, stuckDealer?, redeal? }
 */
function processBid(state, fromPos, amount) {
  if (state.phase !== 'bidding') return { ok:false, error:'Not bidding phase' };
  if (state.currentBidder !== fromPos) return { ok:false, error:'Not your turn to bid' };
  if (state.bids[fromPos] === 0) return { ok:false, error:'You have already passed' };

  const rules   = state.rules;
  const passing = (amount === 0);

  // Stuck dealer can't pass: all others passed and nobody has bid
  if (passing && rules.stickDealer && fromPos === state.dealer && state.highBid === 0) {
    const others = POSITIONS.filter(p => p !== state.dealer);
    if (others.every(p => state.bids[p] === 0)) {
      return { ok:false, error:`Dealer is stuck — must bid ${rules.minBid}` };
    }
  }

  if (!passing) {
    if (!Number.isInteger(amount)) return { ok:false, error:'Bid must be a whole number' };
    const minAllowed = Math.max(rules.minBid, state.highBid + 1);
    if (amount < minAllowed) return { ok:false, error:`Minimum bid is ${minAllowed}` };
    if (amount > MAX_BID) return { ok:false, error:`Maximum bid is ${MAX_BID}` };
    state.highBid    = amount;
    state.highBidder = fromPos;
  }

  state.bids[fromPos] = passing ? 0 : amount;

  // All four passed (stick-the-dealer off) → throw the hand in
  if (POSITIONS.every(p => state.bids[p] === 0)) {
    state.phase = 'redeal';
    return { ok:true, redeal:true, log:'All four pass — hand thrown in, next deal' };
  }

  // Stick the dealer: everyone else passed, nobody bid, dealer still to act
  if (rules.stickDealer) {
    const allExceptDealer = POSITIONS.filter(p => p !== state.dealer);
    const dealerNoBid     = state.bids[state.dealer] === null;
    const allOthersPassed = allExceptDealer.every(p => state.bids[p] === 0);
    if (allOthersPassed && dealerNoBid && state.highBid === 0) {
      state.currentBidder = state.dealer;
      return {
        ok: true,
        log: `${fromPos} passes — dealer is stuck and must bid ${rules.minBid}`,
        stuckDealer: state.dealer
      };
    }
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

  if (state.rules.passCount === 0) {
    // No passing — hands are already final
    computeMelds(state);
    state.phase = 'meld';
  } else {
    state.phase = 'passing'; // partner now passes cards to the bidder
  }
  return { ok:true, log:`${fromPos} names ${SUIT_NAME[suit]} trump` };
}

/** Hands are final — calculate meld for everyone using the named trump */
function computeMelds(state) {
  for (const p of POSITIONS) {
    const m = calcMeld(state.hands[p], state.trump);
    state.meld[p]      = m.score;
    state.meldBreak[p] = m.breakdown;
  }
}

// ── PASSING ──────────────────────────────────────────────────────────────────

/** Take `cards` out of a hand after validating every entry (never mutates on
 *  a bad request). Returns the removed cards, or false. */
function takeCards(state, fromPos, cards) {
  const hand = state.hands[fromPos];
  const used = new Set();
  for (const pc of cards) {
    if (!isCardShape(pc)) return false;
    let idx = hand.findIndex((c, i) => !used.has(i) && cardKey(c) === cardKey(pc));
    if (idx === -1) idx = hand.findIndex((c, i) => !used.has(i) && sameCard(c, pc));
    if (idx === -1) return false;
    used.add(idx);
  }
  return [...used].sort((a, b) => b - a).map(i => hand.splice(i, 1)[0]).reverse();
}

/** Move `cards` from one hand to another. */
function moveCards(state, fromPos, toPos, cards) {
  const taken = takeCards(state, fromPos, cards);
  if (!taken) return false;
  state.hands[toPos].push(...taken);
  return taken;
}

/**
 * Bid winner's partner passes cards to the bidder.
 * peek: they go straight into the bidder's hand.
 * no_peek: they wait face-down in pendingPass until the bidder has returned.
 */
function processPass(state, fromPos, cards) {
  if (state.phase !== 'passing')               return { ok:false, error:'Not passing phase' };
  if (fromPos !== partnerOf(state.highBidder)) return { ok:false, error:'Only the bidder\'s partner passes now' };
  const n = state.rules.passCount;
  if (!Array.isArray(cards) || cards.length !== n) return { ok:false, error:`Must pass exactly ${n} cards` };

  if (state.rules.passPeek === 'no_peek') {
    const taken = takeCards(state, fromPos, cards);
    if (!taken) return { ok:false, error:'Card not in hand' };
    state.pendingPass = taken;
    state.passedIds = taken.map(c => c.id);
  } else {
    const moved = moveCards(state, fromPos, state.highBidder, cards);
    if (!moved) return { ok:false, error:'Card not in hand' };
    state.passedIds = moved.map(c => c.id);
  }

  state.phase = 'returning'; // bidder must now send cards back
  return { ok:true, log:`${fromPos} passes ${n} cards to ${state.highBidder}` };
}

/**
 * Bidder returns cards to partner. With no_peek the returns necessarily come
 * from the bidder's own dozen (the passed cards aren't in their hand yet);
 * they receive the passed cards only after this. Hands are then final.
 */
function processReturn(state, fromPos, cards) {
  if (state.phase !== 'returning')  return { ok:false, error:'Not returning phase' };
  if (fromPos !== state.highBidder) return { ok:false, error:'Only the bidder returns cards' };
  const n = state.rules.passCount;
  if (!Array.isArray(cards) || cards.length !== n) return { ok:false, error:`Must return exactly ${n} cards` };

  const partner = partnerOf(state.highBidder);
  const moved = moveCards(state, fromPos, partner, cards);
  if (!moved) return { ok:false, error:'Card not in hand' };

  state.returnedIds = moved.map(c => c.id);

  // no_peek: now reveal — the held cards join the bidder's hand
  if (state.pendingPass.length) {
    state.hands[state.highBidder].push(...state.pendingPass);
    state.pendingPass = [];
  }

  computeMelds(state);
  state.phase = 'meld';
  return { ok:true, log:`${fromPos} returns ${n} cards to ${partner}` };
}

// ── PLAYING ───────────────────────────────────────────────────────────────────

function startPlaying(state) {
  if (state.phase !== 'meld') return { ok:false, error:'Not meld phase' };
  state.phase = 'playing';
  return { ok:true, log:`Play begins — ${state.trickLeader} leads` };
}

/**
 * Validate and play a card.
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
    return { ok:false, error:'Illegal play — check the follow/trump/head rules' };
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
 * Legal plays for `pos`, per state.rules.playRules:
 *  must_head:   follow suit and beat the winner if able; trump when void
 *               and over-trump if able
 *  must_trump:  follow suit (any card); trump when void (any trump)
 *  follow_suit: follow suit (any card); anything when void
 */
function legalPlays(state, pos) {
  const hand = state.hands[pos];
  if (state.currentTrick.length === 0) return [...hand]; // lead — play anything

  const mode     = state.rules.playRules;
  const ledSuit  = state.trickLedSuit;
  const trump    = state.trump;
  const hasSuit  = hand.filter(c => c.s === ledSuit);
  const hasTrump = hand.filter(c => c.s === trump);

  const winnerIdx = bestInTrick(state.currentTrick, trump);
  const winCard   = state.currentTrick[winnerIdx].card;

  if (hasSuit.length > 0) {
    if (mode === 'must_head') {
      const canBeat = hasSuit.filter(c => beats(c, winCard, trump));
      if (canBeat.length > 0) return canBeat;
    }
    return hasSuit;
  }
  if (mode !== 'follow_suit' && ledSuit !== trump && hasTrump.length > 0) {
    if (mode === 'must_head') {
      const canBeat = hasTrump.filter(c => beats(c, winCard, trump));
      if (canBeat.length > 0) return canBeat;
    }
    return hasTrump;
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

  const bonus     = state.rules.lastTrickBonus;
  const cardsLeft = POSITIONS.reduce((s, p) => s + state.hands[p].length, 0);
  const isLast    = cardsLeft === 0;
  if (isLast) state.trickPts[team] += bonus;

  const trickLog = `${winner} wins the trick` + (pts > 0 ? ` (+${pts})` : '') +
                   (isLast ? ` and the last-trick bonus (+${bonus})` : '');

  state.trickLeader  = winner;
  state.currentTrick = [];
  state.trickLedSuit = null;

  if (isLast) {
    return { ok:true, log:trickLog, trickDone:true, trickSnapshot, roundOver: finishRound(state) };
  }
  return { ok:true, log:trickLog, trickDone:true, trickSnapshot };
}

function finishRound(state) {
  const rules     = state.rules;
  const bidTeam   = teamOf(state.highBidder);
  const otherTeam = bidTeam === 'ns' ? 'ew' : 'ns';

  const meldOf = team =>
    POSITIONS.filter(p => teamOf(p) === team)
             .reduce((s, p) => s + state.meld[p], 0);

  const teamMeld = meldOf(bidTeam);
  const enemMeld = meldOf(otherTeam);

  // Optionally, a team that takes no tricks scores nothing (meld included)
  const canScore = team => !rules.needTrickToScore || state.tricksWon[team] > 0;
  const bidTotal  = canScore(bidTeam)   ? teamMeld + state.trickPts[bidTeam]   : 0;
  const enemTotal = canScore(otherTeam) ? enemMeld + state.trickPts[otherTeam] : 0;
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
  const goal = state.rules.goal;
  if (state.scores[r.bidTeam]   >= goal) return r.bidTeam;
  if (state.scores[r.otherTeam] >= goal) return r.otherTeam;
  return null;
}
