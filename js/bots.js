// ══════════════════════════════════════════
//  bots.js — computer players
//  Pure decision functions: (state, pos) → choice.
//  Bots run on the host, which holds the full state.
// ══════════════════════════════════════════

// ── Hand evaluation ──────────────────────────────────────────

/** Best trump suit for this hand and a rough value of playing it */
function botEvaluateHand(hand) {
  let best = { suit: SUITS[0], value: -1 };
  for (const s of SUITS) {
    const inSuit = hand.filter(c => c.s === s);
    const meld   = calcMeld(hand, s).score;
    const highs  = inSuit.reduce((n, c) =>
      n + (c.r === 'A' ? 3 : c.r === '10' ? 2 : c.r === 'K' ? 1 : 0), 0);
    const value  = meld + inSuit.length * 2 + highs;
    if (value > best.value) best = { suit: s, value };
  }
  return best;
}

/** Estimate the total points (meld + tricks) the bot's team might make
 *  if it wins the bid with its best trump suit. */
function botEstimatePoints(hand) {
  const { suit } = botEvaluateHand(hand);
  const meld     = calcMeld(hand, suit).score;
  const aces     = hand.filter(c => c.r === 'A').length;
  const trumpLen = hand.filter(c => c.s === suit).length;
  // ~8 trick points as a team baseline, plus own aces and trump length,
  // plus a small allowance for partner meld and the 3-card pass.
  const expectedTricks = 8 + aces + Math.max(0, trumpLen - 3);
  const partnerAllow   = 6;
  return Math.round(meld + expectedTricks + partnerAllow);
}

// ── Bidding ──────────────────────────────────────────────────

/** Returns the bid amount (0 = pass) */
function botChooseBid(state, pos) {
  const hand = state.hands[pos];
  const minAllowed = Math.max(MIN_BID, state.highBid + 1);

  // Stuck dealer must open at minimum
  const others = POSITIONS.filter(p => p !== state.dealer);
  const stuck  = pos === state.dealer && state.highBid === 0 &&
                 others.every(p => state.bids[p] === 0);
  if (stuck) return MIN_BID;

  if (minAllowed > MAX_BID) return 0; // engine's hard bid ceiling

  // Don't outbid our own partner without a strong hand
  const partnerHasBid = state.highBidder === partnerOf(pos);
  const cap = botEstimatePoints(hand) - (partnerHasBid ? 4 : 0);

  if (minAllowed <= cap) return minAllowed;
  return 0;
}

// ── Trump ────────────────────────────────────────────────────

function botChooseTrump(state, pos) {
  return botEvaluateHand(state.hands[pos]).suit;
}

// ── Passing ──────────────────────────────────────────────────

/** How much this card contributes to the hand's meld (0 if removing it loses nothing) */
function botMeldDelta(hand, card, trump) {
  const without = hand.filter(c => c !== card);
  return calcMeld(hand, trump).score - calcMeld(without, trump).score;
}

/** Partner of the bidder: pick 3 cards most useful to the bidder (trump + aces) */
function botChoosePassCards(state, pos) {
  const hand  = state.hands[pos];
  const trump = state.trump;
  const scored = hand.map(card => {
    let v = 0;
    if (card.s === trump) v = 20 + RANK_ORDER[card.r];
    else if (card.r === 'A') v = 12;
    else if (card.r === '10') v = 6;
    else v = RANK_ORDER[card.r];
    v -= botMeldDelta(hand, card, trump) * 2; // don't strip our own meld lightly
    return { card, v };
  });
  scored.sort((a, b) => b.v - a.v);
  return scored.slice(0, 3).map(x => x.card);
}

/** Bidder: return the 3 least useful cards to partner */
function botChooseReturnCards(state, pos) {
  const hand  = state.hands[pos];
  const trump = state.trump;
  const scored = hand.map(card => {
    let keep = 0;
    if (card.s === trump) keep += 30 + RANK_ORDER[card.r];
    if (card.r === 'A') keep += 15;
    if (card.r === '10') keep += 6;
    if (card.r === 'K') keep += 2;
    keep += botMeldDelta(hand, card, trump) * 3;
    keep += RANK_ORDER[card.r] * 0.5;
    return { card, keep };
  });
  scored.sort((a, b) => a.keep - b.keep);
  return scored.slice(0, 3).map(x => x.card);
}

// ── Card play ────────────────────────────────────────────────

function botChoosePlay(state, pos) {
  const legal = legalPlays(state, pos);
  if (legal.length === 1) return legal[0];
  const trump = state.trump;

  const lowestBy = (cards, valFn) =>
    cards.reduce((best, c) => (valFn(c) < valFn(best) ? c : best), cards[0]);
  const highestBy = (cards, valFn) =>
    cards.reduce((best, c) => (valFn(c) > valFn(best) ? c : best), cards[0]);

  // ── Leading ──
  if (state.currentTrick.length === 0) {
    // Lead a side-suit ace if we have one (only trump or the twin ace beats it)
    const sideAces = legal.filter(c => c.r === 'A' && c.s !== trump);
    if (sideAces.length) {
      // prefer the ace from our longest side suit
      return highestBy(sideAces, c => state.hands[pos].filter(h => h.s === c.s).length);
    }
    // With a strong trump holding, pull trump with the ace
    const trumpCards = state.hands[pos].filter(c => c.s === trump);
    const trumpAce   = legal.find(c => c.r === 'A' && c.s === trump);
    if (trumpAce && trumpCards.length >= 5) return trumpAce;
    // Otherwise exit low: lowest non-counter, preferring side suits
    const side = legal.filter(c => c.s !== trump);
    const pool = side.length ? side : legal;
    return lowestBy(pool, c => RANK_ORDER[c.r] * 2 + TRICK_PTS[c.r] * 3);
  }

  // ── Following ──
  const winIdx   = bestInTrick(state.currentTrick, trump);
  const winSeat  = state.currentTrick[winIdx].seat;
  const winCard  = state.currentTrick[winIdx].card;
  const partnerWinning = winSeat === partnerOf(pos);
  const winners  = legal.filter(c => beats(c, winCard, trump));

  if (winners.length) {
    // Must (or may) head — use the cheapest card that wins
    return lowestBy(winners, c => RANK_ORDER[c.r] + TRICK_PTS[c.r] * 2);
  }
  // Can't win: feed counters to a winning partner, dump junk otherwise
  if (partnerWinning) {
    return highestBy(legal, c => TRICK_PTS[c.r] * 10 - RANK_ORDER[c.r]);
  }
  return lowestBy(legal, c => TRICK_PTS[c.r] * 10 + RANK_ORDER[c.r]);
}

// ── Dispatch: what would the bot in seat `pos` do right now? ─

/** Last-resort action that is legal by construction — used by the host
 *  if a bot's chosen action is ever rejected, so the game cannot freeze. */
function botFallback(state, pos) {
  switch (state.phase) {
    case 'bidding': {
      const others = POSITIONS.filter(p => p !== state.dealer);
      const stuck = pos === state.dealer && state.highBid === 0 &&
                    others.every(p => state.bids[p] === 0);
      return { action:'bid', amount: stuck ? MIN_BID : 0 };
    }
    case 'naming_trump':
      return { action:'name_trump', suit: (state.hands[pos][0] || { s: SUITS[0] }).s };
    case 'passing':
      return { action:'pass_cards', cards: state.hands[pos].slice(0, 3) };
    case 'returning':
      return { action:'return_cards', cards: state.hands[pos].slice(0, 3) };
    case 'playing': {
      const legal = legalPlays(state, pos);
      return legal.length ? { action:'play_card', card: legal[0] } : null;
    }
  }
  return null;
}

function botDecide(state, pos) {
  switch (state.phase) {
    case 'bidding':
      if (state.currentBidder !== pos) return null;
      return { action:'bid', amount: botChooseBid(state, pos) };
    case 'naming_trump':
      if (state.highBidder !== pos) return null;
      return { action:'name_trump', suit: botChooseTrump(state, pos) };
    case 'passing':
      if (partnerOf(state.highBidder) !== pos) return null;
      return { action:'pass_cards', cards: botChoosePassCards(state, pos) };
    case 'returning':
      if (state.highBidder !== pos) return null;
      return { action:'return_cards', cards: botChooseReturnCards(state, pos) };
    case 'playing':
      if (nextToPlay(state) !== pos) return null;
      return { action:'play_card', card: botChoosePlay(state, pos) };
  }
  return null;
}
