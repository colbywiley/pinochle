// ══════════════════════════════════════════════════════════════
//  sim.test.mjs — rules-engine unit tests + full-game simulations
//  Run: node tests/sim.test.mjs [numGames]
//  Loads the browser scripts (globals) into a vm sandbox and
//  drives thousands of complete bot-vs-bot games, asserting
//  game invariants the whole way.
// ══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = ['js/cards.js', 'js/meld.js', 'js/rules.js', 'js/bots.js']
  .map(f => readFileSync(join(root, f), 'utf8'))
  .join('\n;\n');

const ctx = { console, Math, JSON };
vm.createContext(ctx);
vm.runInContext(src, ctx, { filename: 'pinochle-bundle.js' });

// const/let bindings live in the context's global lexical scope, not on the
// context object — pull them out with a second evaluation in the same context.
const {
  SUITS, RANK_ORDER, POSITIONS, MIN_BID, GOAL, POINTS_PER_HAND,
  makeDeck, cardKey, sortHand, calcMeld, newRound, dealCards,
  processBid, processTrump, processPass, processReturn, processPlayCard,
  startPlaying, legalPlays, nextToPlay, checkWinner, beats,
  teamOf, partnerOf, leftOf, botDecide, countPoints,
  DEFAULT_RULES, normalizeRules, describeRules,
} = vm.runInContext(`({
  SUITS, RANK_ORDER, POSITIONS, MIN_BID, GOAL, POINTS_PER_HAND,
  makeDeck, cardKey, sortHand, calcMeld, newRound, dealCards,
  processBid, processTrump, processPass, processReturn, processPlayCard,
  startPlaying, legalPlays, nextToPlay, checkWinner, beats,
  teamOf, partnerOf, leftOf, botDecide, countPoints,
  DEFAULT_RULES, normalizeRules, describeRules,
})`, ctx);

let failures = 0, checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) {
    failures++;
    console.error('✗ FAIL:', msg);
    if (failures > 25) { console.error('Too many failures, aborting.'); process.exit(1); }
  }
}
function assertEq(a, b, msg) { assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const C = (r, s, copy = 0) => ({ r, s, id: r + s + copy });

// ══════════════════════════════════════════════════════════════
// 1. DECK
// ══════════════════════════════════════════════════════════════
{
  const deck = makeDeck();
  assertEq(deck.length, 48, 'deck has 48 cards');
  assertEq(new Set(deck.map(c => c.id)).size, 48, 'all card ids unique');
  for (const s of SUITS) {
    assertEq(deck.filter(c => c.s === s).length, 12, `12 cards in suit ${s}`);
  }
  assertEq(deck.filter(c => c.r === 'A' && c.s === 'S').length, 2, 'two aces of spades');
  assertEq(countPoints(deck), 24, '24 counter points in the deck');
}

// ══════════════════════════════════════════════════════════════
// 2. MELD
// ══════════════════════════════════════════════════════════════
function meldOf(cards, trump) { return calcMeld(cards, trump).score; }
{
  // Run = 15 (includes royal marriage, not double counted)
  assertEq(meldOf([C('A','S'),C('10','S'),C('K','S'),C('Q','S'),C('J','S')], 'S'), 15, 'run = 15');
  // Run + extra K,Q of trump = 15 + 4
  assertEq(meldOf([C('A','S'),C('10','S'),C('K','S'),C('Q','S'),C('J','S'),C('K','S',1),C('Q','S',1)], 'S'),
    19, 'run + extra royal marriage = 19');
  // Double run = 150
  const dbl = [];
  for (const cp of [0,1]) for (const r of ['A','10','K','Q','J']) dbl.push(C(r,'S',cp));
  assertEq(meldOf(dbl, 'S'), 150, 'double run = 150');
  // Royal marriage alone = 4
  assertEq(meldOf([C('K','H'),C('Q','H')], 'H'), 4, 'royal marriage = 4');
  // Two royal marriages (no run) = 8
  assertEq(meldOf([C('K','H'),C('Q','H'),C('K','H',1),C('Q','H',1)], 'H'), 8, 'double royal marriage = 8');
  // Off-suit marriage = 2
  assertEq(meldOf([C('K','D'),C('Q','D')], 'S'), 2, 'marriage = 2');
  // Pinochle = 4 (J♦ counts toward nothing else here)
  assertEq(meldOf([C('J','D'),C('Q','S')], 'H'), 4, 'pinochle = 4');
  // Double pinochle = 30
  assertEq(meldOf([C('J','D'),C('Q','S'),C('J','D',1),C('Q','S',1)], 'H'), 30, 'double pinochle = 30');
  // Aces around = 10; double = 100
  assertEq(meldOf(SUITS.map(s => C('A', s)), 'S'), 10, 'aces around = 10');
  assertEq(meldOf(SUITS.flatMap(s => [C('A',s,0), C('A',s,1)]), 'S'), 100, 'double aces = 100');
  // Kings around: 4 kings = 8 + one royal marriage? No queens — just 8
  assertEq(meldOf(SUITS.map(s => C('K', s)), 'S'), 8, 'kings around = 8');
  assertEq(meldOf(SUITS.map(s => C('Q', s)), 'S'), 6, 'queens around = 6');
  assertEq(meldOf(SUITS.map(s => C('J', s)), 'S'), 4, 'jacks around = 4');
  // Dix
  assertEq(meldOf([C('9','S')], 'S'), 1, 'dix = 1');
  assertEq(meldOf([C('9','S'),C('9','S',1)], 'S'), 2, 'two dix = 2');
  assertEq(meldOf([C('9','S')], 'H'), 0, 'off-trump 9 = 0');
  // Combined: queens around + pinochle share the Q♠
  assertEq(meldOf([C('Q','S'),C('Q','H'),C('Q','D'),C('Q','C'),C('J','D')], 'C'),
    6 + 4, 'queens around + pinochle share Q♠');
  // Kings+queens around = 8 + 6 + marriages (3 off-suit @2 + royal @4)
  const kq = SUITS.flatMap(s => [C('K', s), C('Q', s)]);
  assertEq(meldOf(kq, 'S'), 8 + 6 + 4 + 2*3, 'kings+queens around with 4 marriages');
}

// ══════════════════════════════════════════════════════════════
// 3. TRICK LOGIC — beats / legalPlays (must head)
// ══════════════════════════════════════════════════════════════
{
  assert(beats(C('A','S'), C('10','S'), 'H'), 'A beats 10 in suit');
  assert(!beats(C('K','S'), C('10','S'), 'H'), 'K loses to 10 (pinochle order)');
  assert(beats(C('9','H'), C('A','S'), 'H'), 'small trump beats off-suit ace');
  assert(!beats(C('A','S',1), C('A','S',0), 'H'), 'identical card does not beat the first');
  assert(!beats(C('A','D'), C('9','S'), 'H'), 'off-suit cannot beat the led suit');

  // Must-head within led suit
  const st = newRound(null);
  st.phase = 'playing'; st.trump = 'H'; st.trickLeader = 'west';
  st.currentTrick = [{ seat:'west', card:C('K','S') }];
  st.trickLedSuit = 'S';
  st.hands.north = [C('A','S'), C('Q','S'), C('9','H'), C('A','D')];
  let legal = legalPlays(st, 'north');
  assertEq(legal.length, 1, 'must head: only A♠ is legal');
  assertEq(cardKey(legal[0]), cardKey(C('A','S')), 'must head with the ace');

  // Can follow but cannot head → any card of the suit
  st.hands.north = [C('Q','S'), C('J','S'), C('A','D')];
  legal = legalPlays(st, 'north');
  assertEq(legal.length, 2, 'follow suit low: both spades legal');

  // Void in led suit → must trump, and must over-trump
  st.currentTrick = [{ seat:'west', card:C('K','S') }, { seat:'north', card:C('J','H') }];
  st.hands.east = [C('9','H'), C('A','H'), C('A','D')];
  legal = legalPlays(st, 'east');
  assertEq(legal.length, 1, 'must over-trump');
  assertEq(cardKey(legal[0]), cardKey(C('A','H')), 'over-trump with A♥');

  // Void, has only lower trump → must still play trump
  st.hands.east = [C('9','H'), C('A','D')];
  legal = legalPlays(st, 'east');
  assertEq(legal.length, 1, 'must under-trump when void');
  assertEq(cardKey(legal[0]), cardKey(C('9','H')), 'forced 9♥');

  // Void and no trump → anything
  st.hands.east = [C('A','D'), C('9','C')];
  legal = legalPlays(st, 'east');
  assertEq(legal.length, 2, 'no suit, no trump: anything goes');

  // Trump led → follow trump and head it
  st.currentTrick = [{ seat:'west', card:C('K','H') }];
  st.trickLedSuit = 'H';
  st.hands.north = [C('A','H'), C('9','H'), C('A','S')];
  legal = legalPlays(st, 'north');
  assertEq(legal.length, 1, 'trump led: must head in trump');
  assertEq(cardKey(legal[0]), cardKey(C('A','H')), 'head trump with A♥');
}

// ══════════════════════════════════════════════════════════════
// 4. BIDDING — incl. stick the dealer
// ══════════════════════════════════════════════════════════════
{
  // Dealer south → west opens
  let st = newRound(null); dealCards(st);
  assertEq(st.dealer, 'south', 'first dealer is south');
  assertEq(st.currentBidder, 'west', 'left of dealer opens');

  let r = processBid(st, 'north', 25);
  assert(!r.ok, 'out-of-turn bid rejected');
  r = processBid(st, 'west', 24);
  assert(!r.ok, 'sub-minimum bid rejected');
  r = processBid(st, 'west', 25);
  assert(r.ok, 'opening 25 accepted');
  r = processBid(st, 'north', 25);
  assert(!r.ok, 'equal bid rejected');
  r = processBid(st, 'north', 26);
  assert(r.ok, 'raise by 1 accepted');
  r = processBid(st, 'east', 0);
  assert(r.ok, 'pass accepted');
  r = processBid(st, 'south', 0);
  assert(r.ok, 'dealer may pass once someone has bid');
  // back to west
  assertEq(st.currentBidder, 'west', 'east+south passed, back to west');
  r = processBid(st, 'west', 0);
  assert(r.ok && r.biddingDone, 'bidding ends when one bidder remains');
  assertEq(st.highBidder, 'north', 'north wins the auction');
  assertEq(st.highBid, 26, 'winning bid is 26');
  assertEq(st.phase, 'naming_trump', 'moves to naming trump');

  // Stick the dealer
  st = newRound(null); dealCards(st);
  processBid(st, 'west', 0);
  processBid(st, 'north', 0);
  r = processBid(st, 'east', 0);
  assert(r.ok && r.stuckDealer === 'south', 'dealer is stuck after 3 passes');
  r = processBid(st, 'south', 0);
  assert(!r.ok, 'stuck dealer cannot pass');
  r = processBid(st, 'south', 25);
  assert(r.ok && r.biddingDone, 'stuck dealer bids 25 and wins');
  assertEq(st.highBidder, 'south', 'stuck dealer is the bidder');

  // A player who passed cannot bid again
  st = newRound(null); dealCards(st);
  processBid(st, 'west', 25);
  processBid(st, 'north', 0);
  r = processBid(st, 'north', 30);
  assert(!r.ok, 'passed player cannot re-enter');
}

// ══════════════════════════════════════════════════════════════
// 5. PASS / RETURN FLOW
// ══════════════════════════════════════════════════════════════
{
  const st = newRound(null); dealCards(st);
  processBid(st, 'west', 25);
  processBid(st, 'north', 0);
  processBid(st, 'east', 0);
  processBid(st, 'south', 0);
  assertEq(st.highBidder, 'west', 'west wins');
  assertEq(st.phase, 'naming_trump', 'naming trump');

  let r = processTrump(st, 'north', 'S');
  assert(!r.ok, 'non-bidder cannot name trump');
  r = processTrump(st, 'west', 'S');
  assert(r.ok, 'bidder names trump');
  assertEq(st.trickLeader, 'west', 'bid winner will lead');
  assertEq(st.phase, 'passing', 'passing phase');

  // Wrong player passes
  r = processPass(st, 'west', st.hands.west.slice(0,3));
  assert(!r.ok, 'bidder does not pass first — partner does');
  // Partner (east) passes 3
  const passCards = st.hands.east.slice(0, 3).map(c => ({...c}));
  r = processPass(st, 'east', passCards);
  assert(r.ok, 'partner passes 3');
  assertEq(st.hands.east.length, 9, 'partner now has 9');
  assertEq(st.hands.west.length, 15, 'bidder now has 15');
  assertEq(st.phase, 'returning', 'returning phase');

  // Card-not-in-hand rejected, hand not corrupted
  r = processReturn(st, 'west', [C('A','S',0), C('A','S',1), { r:'X', s:'S', id:'fake' }]);
  assert(!r.ok, 'bad return rejected');
  assertEq(st.hands.west.length, 15, 'hand intact after rejected return');

  const retCards = st.hands.west.slice(0, 3).map(c => ({...c}));
  r = processReturn(st, 'west', retCards);
  assert(r.ok, 'bidder returns 3');
  assertEq(st.hands.west.length, 12, 'bidder back to 12');
  assertEq(st.hands.east.length, 12, 'partner back to 12');
  assertEq(st.phase, 'meld', 'meld phase');
  for (const p of POSITIONS) {
    assertEq(st.meld[p], calcMeld(st.hands[p], st.trump).score, `meld computed for ${p}`);
  }
}

// ══════════════════════════════════════════════════════════════
// 5b. HOUSE RULE VARIANTS — unit checks
// ══════════════════════════════════════════════════════════════
function biddingWonBy(st, winner, amount) {
  // drive the auction so `winner` takes it at `amount`
  while (st.phase === 'bidding') {
    const p = st.currentBidder;
    const r = processBid(st, p, p === winner && st.highBidder !== winner ? amount : 0);
    assert(r.ok, `variant auction step ok (${r.error})`);
    if (r.redeal) return false;
  }
  return true;
}
{
  // ── no_peek: returns must come from the bidder's own dozen ──
  let st = newRound(null, { passPeek: 'no_peek' }); dealCards(st);
  assertEq(st.rules.passPeek, 'no_peek', 'no_peek rule stored');
  biddingWonBy(st, 'west', 25);
  processTrump(st, 'west', 'S');
  const passCards = st.hands.east.slice(0, 3).map(c => ({...c}));
  let r = processPass(st, 'east', passCards);
  assert(r.ok, 'no_peek: partner passes');
  assertEq(st.hands.west.length, 12, 'no_peek: bidder hand still 12 (cards held)');
  assertEq(st.pendingPass.length, 3, 'no_peek: 3 cards held face-down');
  assertEq(st.hands.east.length, 9, 'no_peek: partner down to 9');
  // bidder cannot return a card they have not seen (unless they hold the
  // twin copy of the same rank+suit, which is legitimately theirs to give)
  const unseen = passCards.find(pc => !st.hands.west.some(c => c.r === pc.r && c.s === pc.s));
  if (unseen) {
    r = processReturn(st, 'west', [unseen, st.hands.west[0], st.hands.west[1]].map(c=>({...c})));
    assert(!r.ok, 'no_peek: cannot return an unseen passed card');
    assertEq(st.hands.west.length, 12, 'no_peek: hand intact after rejection');
  }
  const ret = st.hands.west.slice(0, 3).map(c => ({...c}));
  r = processReturn(st, 'west', ret);
  assert(r.ok, 'no_peek: valid return accepted');
  assertEq(st.hands.west.length, 12, 'no_peek: bidder ends with 12 (returns out, pass in)');
  assertEq(st.hands.east.length, 12, 'no_peek: partner ends with 12');
  assertEq(st.pendingPass.length, 0, 'no_peek: held cards delivered');
  const passIds = new Set(passCards.map(c => c.id));
  assert(st.hands.west.some(c => passIds.has(c.id)), 'no_peek: passed cards reached the bidder');

  // ── passCount 0: trump goes straight to meld ──
  st = newRound(null, { passCount: 0 }); dealCards(st);
  biddingWonBy(st, 'north', 25);
  r = processTrump(st, 'north', 'H');
  assert(r.ok, 'no-pass: trump named');
  assertEq(st.phase, 'meld', 'no-pass: straight to meld');
  for (const p of POSITIONS) {
    assertEq(st.hands[p].length, 12, `no-pass: ${p} still has 12`);
    assertEq(st.meld[p], calcMeld(st.hands[p], 'H').score, `no-pass: meld computed for ${p}`);
  }

  // ── stick the dealer OFF: four passes throw the hand in ──
  st = newRound(null, { stickDealer: false }); dealCards(st);
  processBid(st, 'west', 0);
  processBid(st, 'north', 0);
  r = processBid(st, 'east', 0);
  assert(r.ok && !r.redeal, 'stick-off: dealer still to act');
  r = processBid(st, 'south', 0);
  assert(r.ok && r.redeal, 'stick-off: dealer may pass — hand thrown in');

  // ── minBid variant ──
  st = newRound(null, { minBid: 30 }); dealCards(st);
  r = processBid(st, 'west', 29);
  assert(!r.ok, 'minBid 30: 29 rejected');
  r = processBid(st, 'west', 30);
  assert(r.ok, 'minBid 30: 30 accepted');

  // ── play-rule variants: void in led suit, an opponent already trumped ──
  const mkPlay = mode => {
    const s = newRound(null, { playRules: mode });
    s.phase = 'playing'; s.trump = 'H'; s.trickLeader = 'west';
    s.currentTrick = [{ seat:'west', card:C('K','S') }, { seat:'north', card:C('J','H') }];
    s.trickLedSuit = 'S';
    s.hands.east = [C('9','H'), C('A','H'), C('A','D')];
    return legalPlays(s, 'east').map(c => cardKey(c)).sort();
  };
  assertEq(JSON.stringify(mkPlay('must_head')),  JSON.stringify([cardKey(C('A','H'))]),
    'must_head: must over-trump the J♥');
  assertEq(JSON.stringify(mkPlay('must_trump')), JSON.stringify([cardKey(C('9','H')), cardKey(C('A','H'))].sort()),
    'must_trump: any trump, no over-trump requirement');
  assertEq(mkPlay('follow_suit').length, 3, 'follow_suit: void → anything');

  // must_head within the led suit still applies only in must_head mode
  const sFollow = newRound(null, { playRules: 'must_trump' });
  sFollow.phase='playing'; sFollow.trump='H'; sFollow.trickLeader='west';
  sFollow.currentTrick=[{seat:'west',card:C('K','S')}]; sFollow.trickLedSuit='S';
  sFollow.hands.north=[C('A','S'), C('Q','S')];
  assertEq(legalPlays(sFollow,'north').length, 2, 'must_trump: follow suit without heading');

  // ── normalizeRules sanitizes junk ──
  const junk = normalizeRules({ goal: 999, minBid: 'x', passCount: 7, passPeek: 'maybe', playRules: 'chaos' });
  assertEq(JSON.stringify(junk), JSON.stringify(DEFAULT_RULES), 'junk rules fall back to defaults');
}

// ══════════════════════════════════════════════════════════════
// 6. FULL-GAME SIMULATIONS (bots at all four seats)
// ══════════════════════════════════════════════════════════════

function currentActorSim(state) {
  switch (state.phase) {
    case 'bidding':      return state.currentBidder;
    case 'naming_trump': return state.highBidder;
    case 'passing':      return partnerOf(state.highBidder);
    case 'returning':    return state.highBidder;
    case 'playing':      return nextToPlay(state);
    default:             return null;
  }
}

function playOneGame(gameIdx, ruleset, tag) {
  let state = newRound(null, ruleset);
  const rules = state.rules;
  const pointsInPlay = 24 + rules.lastTrickBonus;
  dealCards(state);
  let rounds = 0, redeals = 0, steps = 0;
  const id = `game ${tag}/${gameIdx}`;

  while (true) {
    if (++steps > 30000) { assert(false, `${id}: runaway (no termination)`); return; }

    if (state.phase === 'meld') {
      for (const p of POSITIONS) {
        assertEq(state.meld[p], calcMeld(state.hands[p], state.trump).score,
          `${id}: meld matches hand for ${p}`);
        assertEq(state.hands[p].length, 12, `${id}: ${p} has 12 cards at meld`);
      }
      assertEq(state.pendingPass.length, 0, `${id}: no cards left in limbo`);
      const r = startPlaying(state);
      assert(r.ok, `${id}: startPlaying ok`);
      assertEq(nextToPlay(state), state.highBidder, `${id}: bidder leads first trick`);
      continue;
    }

    if (state.phase === 'round_over') {
      rounds++;
      const res = state.lastRoundResult;
      assert(res, `${id}: round result exists`);
      assertEq(state.trickPts.ns + state.trickPts.ew, pointsInPlay,
        `${id} round ${rounds}: ${pointsInPlay} points in play`);
      assertEq(state.tricksWon.ns + state.tricksWon.ew, 12,
        `${id} round ${rounds}: 12 tricks played`);
      for (const p of POSITIONS) {
        assertEq(state.hands[p].length, 0, `${id}: hands empty at round end`);
      }
      assert(Number.isFinite(res.nsScore) && Number.isFinite(res.ewScore), `${id}: finite scores`);
      if (res.bidMet) assert(res.bidTotal >= res.highBid, `${id}: bidMet implies total >= bid`);
      if (rules.needTrickToScore) {
        if (res.bidTricksWon === 0)  assert(!res.bidMet, `${id}: zero tricks can never make the bid`);
        if (res.enemTricksWon === 0) assertEq(res.enemTotal, 0, `${id}: no tricks = no score`);
      } else {
        if (res.enemTricksWon === 0) assertEq(res.enemTotal, res.enemMeld, `${id}: trickless meld still scores`);
      }

      const winner = checkWinner(state);
      if (winner) {
        assert(state.scores[winner] >= rules.goal, `${id}: winner reached goal ${rules.goal}`);
        if (state.scores.ns >= rules.goal && state.scores.ew >= rules.goal) {
          assertEq(winner, res.bidTeam, `${id}: bidder goes out on double-cross`);
        }
        return { rounds, redeals, winner, scores: { ...state.scores } };
      }
      assert(rounds < 300, `${id}: terminates within 300 rounds`);
      const prevScores = { ...state.scores };
      const prevRound = state.roundNum;
      const prevDealer = state.dealer;
      state = newRound(state);
      dealCards(state);
      assertEq(state.roundNum, prevRound + 1, `${id}: round number increments`);
      assertEq(state.dealer, leftOf(prevDealer), `${id}: deal rotates`);
      assertEq(state.scores.ns, prevScores.ns, `${id}: scores carry over`);
      assertEq(JSON.stringify(state.rules), JSON.stringify(rules), `${id}: rules carry over`);
      continue;
    }

    const actor = currentActorSim(state);
    assert(actor, `${id}: phase ${state.phase} has an actor`);
    const act = botDecide(state, actor);
    assert(act, `${id}: bot has an action in ${state.phase}`);

    let r;
    switch (act.action) {
      case 'bid':          r = processBid(state, actor, act.amount); break;
      case 'name_trump':   r = processTrump(state, actor, act.suit); break;
      case 'pass_cards':   r = processPass(state, actor, act.cards); break;
      case 'return_cards': r = processReturn(state, actor, act.cards); break;
      case 'play_card': {
        // Every bot play must be legal by the engine's own rules
        const legal = legalPlays(state, actor);
        assert(legal.some(c => cardKey(c) === cardKey(act.card)),
          `${id}: bot plays a legal card`);
        r = processPlayCard(state, actor, act.card);
        break;
      }
      default: assert(false, `${id}: unknown bot action ${act.action}`); return;
    }
    assert(r && r.ok, `${id}: ${act.action} by ${actor} accepted (${r && r.error})`);

    if (r.redeal) {
      redeals++;
      assert(!rules.stickDealer, `${id}: redeal only when stick-the-dealer is off`);
      assert(redeals < 500, `${id}: not stuck in redeals`);
      state = newRound(state);
      dealCards(state);
    }
  }
}

// Full games across the house-rule matrix
const RULESETS = [
  ['default',   {}],
  ['no_peek',   { passPeek: 'no_peek' }],
  ['pass4',     { passCount: 4 }],
  ['no_pass',   { passCount: 0 }],
  ['stick_off', { stickDealer: false }],
  ['must_trump',{ playRules: 'must_trump' }],
  ['follow',    { playRules: 'follow_suit' }],
  ['variant_mix', { goal: 100, minBid: 20, lastTrickBonus: 2, needTrickToScore: false }],
  ['kitchen_sink', { goal: 300, minBid: 30, passCount: 4, passPeek: 'no_peek',
                     playRules: 'must_trump', stickDealer: false, lastTrickBonus: 2 }],
];

const NUM_GAMES = parseInt(process.argv[2] || '300', 10);
const perSet = Math.max(10, Math.floor(NUM_GAMES / RULESETS.length));
console.log(`\n── Full-game simulations (${perSet} games × ${RULESETS.length} rulesets) ──`);
for (const [tag, ruleset] of RULESETS) {
  const stats = { games: 0, rounds: 0, redeals: 0, ns: 0, ew: 0, maxRounds: 0 };
  for (let i = 0; i < perSet; i++) {
    const out = playOneGame(i, ruleset, tag);
    if (!out) break;
    stats.games++;
    stats.rounds += out.rounds;
    stats.redeals += out.redeals;
    stats.maxRounds = Math.max(stats.maxRounds, out.rounds);
    stats[out.winner]++;
  }
  console.log(`${tag.padEnd(13)} games ${stats.games} · avg rounds ${(stats.rounds/stats.games).toFixed(1)}` +
    ` · NS ${stats.ns} / EW ${stats.ew}` + (stats.redeals ? ` · redeals ${stats.redeals}` : ''));
}

console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
